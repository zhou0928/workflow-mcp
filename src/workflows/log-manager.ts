import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { execSafe } from "../utils/exec.js";
import { existsSync, readFileSync, statSync, readdirSync, unlinkSync, renameSync, copyFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// ============================================================
// Schemas
// ============================================================

const LogTailSchema = z.object({
  file: z.string().describe("Log file path"),
  lines: z.number().optional().describe("Number of recent lines (default: 50, max: 5000)"),
  follow: z.boolean().optional().describe("Follow new entries (tail -f, default: false)"),
  timeout: z.number().optional().describe("Follow timeout in seconds (default: 30)"),
});

const LogSearchSchema = z.object({
  file: z.string().describe("Log file path"),
  pattern: z.string().describe("Search pattern (regex)"),
  context: z.number().optional().describe("Lines of context around matches (default: 2)"),
  ignoreCase: z.boolean().optional().describe("Case-insensitive search (default: true)"),
  maxResults: z.number().optional().describe("Max matches to return (default: 100)"),
});

const LogRotateSchema = z.object({
  file: z.string().describe("Log file to rotate"),
  maxSize: z.string().optional().describe("Max size before rotate (e.g. '10M', '1G', default: '100M')"),
  keep: z.number().optional().describe("Number of rotated files to keep (default: 5)"),
  compress: z.boolean().optional().describe("Compress old logs with gzip (default: true)"),
});

const LogAnalyzeSchema = z.object({
  file: z.string().describe("Log file to analyze"),
  type: z.enum(["auto", "nginx", "access", "error", "json", "custom"]).optional().describe("Log format type (default: auto)"),
  pattern: z.string().optional().describe("Custom regex pattern for parsing log lines"),
});

const LogWatchSchema = z.object({
  directory: z.string().describe("Directory to watch for log files"),
  pattern: z.string().optional().describe("File glob pattern (default: '*.log')"),
  keywords: z.array(z.string()).optional().describe("Keywords to alert on (default: ['error', 'fatal', 'exception', 'fail'])"),
  duration: z.number().optional().describe("Watch duration in seconds (default: 60)"),
});

// ============================================================
// Helpers
// ============================================================

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function parseMaxSize(size: string): number {
  const match = size.match(/^(\d+)([KMG]?)$/);
  if (!match) return 100 * 1024 * 1024; // default 100M
  const num = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case "K": return num * 1024;
    case "M": return num * 1024 * 1024;
    case "G": return num * 1024 * 1024 * 1024;
    default: return num;
  }
}

/**
 * Recursively find files matching a simple glob pattern (only * and ? supported).
 */
function findFiles(dir: string, patternGlob: string, maxResults = 20): string[] {
  const results: string[] = [];
  // Convert glob to regex: * → .*, ? → .
  const regexStr = "^" + patternGlob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  const regex = new RegExp(regexStr);

  function walk(current: string) {
    if (results.length >= maxResults) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && regex.test(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Read the last N lines of a file.
 */
function tailLines(filePath: string, n: number): string[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  return lines.slice(-n);
}

// ============================================================
// Tool factory
// ============================================================

export function getLogTools(): ToolDefinition[] {
  return [
    {
      name: "log_tail",
      description: "Tail a log file, showing the most recent lines",
      inputSchema: zToJsonSchema(LogTailSchema),
      handler: async (args) => {
        try {
          const { file, lines } = LogTailSchema.parse(args);
          const numLines = Math.min(lines ?? 50, 5000);

          if (!existsSync(file)) {
            return { content: [{ type: "text", text: `❌ File not found: ${file}` }], isError: true };
          }

          const stat = statSync(file);
          if (!stat.isFile()) {
            return { content: [{ type: "text", text: `❌ Not a file: ${file}` }], isError: true };
          }

          const recentLines = tailLines(file, numLines);
          const result = recentLines.join("\n");

          const info = `File: ${file} (${formatSize(stat.size)})`;
          return {
            content: [{ type: "text", text: [info, "", result.slice(0, 10000)].join("\n") }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "log_search",
      description: "Search a log file for a pattern with context",
      inputSchema: zToJsonSchema(LogSearchSchema),
      handler: async (args) => {
        try {
          const { file, pattern, context, ignoreCase, maxResults } = LogSearchSchema.parse(args);
          const ctx = context ?? 2;
          const max = maxResults ?? 100;

          if (!existsSync(file)) {
            return { content: [{ type: "text", text: `❌ File not found: ${file}` }], isError: true };
          }

          const flags = ignoreCase !== false ? "gi" : "g";
          const regex = new RegExp(pattern, flags);
          const content = readFileSync(file, "utf-8");
          const lines = content.split("\n");

          // Collect context groups around each match
          const matchGroups: Set<number>[] = [];
          let matchCount = 0;
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              const start = Math.max(0, i - ctx);
              const end = Math.min(lines.length - 1, i + ctx);
              const group = new Set<number>();
              for (let j = start; j <= end; j++) group.add(j);
              matchGroups.push(group);
              matchCount++;
              if (matchCount >= max) break;
            }
          }

          // Merge overlapping/sorted groups and format output
          const outputLines: string[] = [];
          let prevEnd = -2;
          for (const group of matchGroups) {
            const indices = [...group].sort((a, b) => a - b);
            if (prevEnd >= indices[0] - 1) {
              // Overlapping — just keep the output going
            } else {
              if (outputLines.length > 0) outputLines.push("--");
            }
            for (const idx of indices) {
              outputLines.push(`${idx + 1}:${lines[idx]}`);
            }
            prevEnd = indices[indices.length - 1];
          }

          const output = outputLines.join("\n");
          return {
            content: [{ type: "text", text: `🔍 Found ${matchCount} match(es) for "${pattern}" in ${file}\n\n${output.slice(0, 10000)}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "log_rotate",
      description: "Rotate a log file (compress and archive old entries)",
      inputSchema: zToJsonSchema(LogRotateSchema),
      handler: async (args) => {
        try {
          const { file, maxSize, keep, compress } = LogRotateSchema.parse(args);
          const maxBytes = parseMaxSize(maxSize ?? "100M");
          const keepCount = keep ?? 5;

          if (!existsSync(file)) {
            return { content: [{ type: "text", text: `❌ File not found: ${file}` }], isError: true };
          }

          const stat = statSync(file);
          if (stat.size < maxBytes) {
            return { content: [{ type: "text", text: `File size (${formatSize(stat.size)}) is below max (${maxSize ?? "100M"}). No rotation needed.` }] };
          }

          // Remove oldest if over limit
          if (keepCount > 0) {
            const oldest = `${file}.${keepCount}`;
            if (existsSync(oldest)) unlinkSync(oldest);
            const oldestGz = `${oldest}.gz`;
            if (compress && existsSync(oldestGz)) unlinkSync(oldestGz);
          }

          // Shift existing
          for (let i = keepCount - 1; i >= 1; i--) {
            const src = `${file}.${i}`;
            const srcGz = `${file}.${i}.gz`;
            const dst = `${file}.${i + 1}`;
            if (existsSync(src)) renameSync(src, dst);
            if (compress && existsSync(srcGz)) renameSync(srcGz, `${dst}.gz`);
          }

          // Rotate current
          copyFileSync(file, `${file}.1`);
          writeFileSync(file, "");

          // Compress
          if (compress) {
            const data = readFileSync(`${file}.1`);
            writeFileSync(`${file}.1.gz`, gzipSync(data));
            unlinkSync(`${file}.1`);
          }

          return {
            content: [{ type: "text", text: `✅ Log rotated: ${file}\n   Original size: ${formatSize(stat.size)}\n   Old log archived as: ${file}.1${compress ? ".gz" : ""}\n   Keeping ${keepCount} rotated file(s)` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "log_analyze",
      description: "Analyze a log file — count by level, find error rates, etc.",
      inputSchema: zToJsonSchema(LogAnalyzeSchema),
      handler: async (args) => {
        try {
          const { file } = LogAnalyzeSchema.parse(args);

          if (!existsSync(file)) {
            return { content: [{ type: "text", text: `❌ File not found: ${file}` }], isError: true };
          }

          const stat = statSync(file);
          const content = readFileSync(file, "utf-8");
          const lineCount = content.split("\n").length;

          // Count by log level (case-insensitive)
          const errorCount = (content.match(/\berror\b|\bfatal\b|\bexception\b|\bFAIL\b/gi) || []).length;
          const warnCount = (content.match(/\bwarn\b|\bwarning\b/gi) || []).length;
          const infoCount = (content.match(/\binfo\b/gi) || []).length;
          const debugCount = (content.match(/\bdebug\b|\btrace\b/gi) || []).length;

          // Top error patterns: find lines with "error", extract unique error-like snippets
          const errorLines = content.split("\n").filter((l) => /\berror\b/i.test(l));
          const errorPatternMap: Record<string, number> = {};
          for (const line of errorLines) {
            const m = line.match(/\berror[^:;,]*/i);
            if (m) {
              const key = m[0].trim().toLowerCase();
              errorPatternMap[key] = (errorPatternMap[key] || 0) + 1;
            }
          }
          const topErrorEntries = Object.entries(errorPatternMap)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

          const report: string[] = [
            `📊 Log Analysis: ${file}`,
            `   Size: ${formatSize(stat.size)}`,
            `   Total lines: ${lineCount}`,
            ``,
            `   🔴 Errors:   ${errorCount}${lineCount > 0 ? ` (${(errorCount / lineCount * 100).toFixed(1)}%)` : ""}`,
            `   🟡 Warnings: ${warnCount}${lineCount > 0 ? ` (${(warnCount / lineCount * 100).toFixed(1)}%)` : ""}`,
            `   🔵 Info:     ${infoCount}${lineCount > 0 ? ` (${(infoCount / lineCount * 100).toFixed(1)}%)` : ""}`,
            `     🔍 Debug:    ${debugCount}${lineCount > 0 ? ` (${(debugCount / lineCount * 100).toFixed(1)}%)` : ""}`,
          ];

          if (topErrorEntries.length > 0) {
            report.push(``, `   Top Error Patterns:`);
            for (const [pattern, count] of topErrorEntries) {
              report.push(`     ${count} ${pattern}`);
            }
          }

          return { content: [{ type: "text", text: report.join("\n") }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "log_watch",
      description: "Watch a directory for log files and alert on keywords",
      inputSchema: zToJsonSchema(LogWatchSchema),
      handler: async (args) => {
        try {
          const { directory, pattern, keywords, duration } = LogWatchSchema.parse(args);
          const glob = pattern ?? "*.log";
          const kw = keywords ?? ["error", "fatal", "exception", "fail"];

          if (!existsSync(directory)) {
            return { content: [{ type: "text", text: `❌ Directory not found: ${directory}` }], isError: true };
          }

          // Find matching log files using recursive walk
          const logFiles = findFiles(directory, glob, 20);

          if (logFiles.length === 0) {
            return { content: [{ type: "text", text: `No log files matching "${glob}" found in ${directory}.` }] };
          }

          // Build keyword regex
          const kwPattern = kw.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
          const kwRegex = new RegExp(kwPattern, "i");
          const results: string[] = [`👁️  Scanning ${logFiles.length} log file(s)`, `   Keywords: ${kw.join(", ")}`, ""];
          let totalMatches = 0;

          for (const logFile of logFiles) {
            const content = readFileSync(logFile, "utf-8");
            const lines = content.split("\n");
            const matches = lines.filter((l) => kwRegex.test(l));
            if (matches.length > 0) {
              totalMatches += matches.length;
              results.push(`   📄 ${logFile}: ${matches.length} alert(s)`);
              matches.slice(0, 5).forEach((m) => results.push(`     ⚠️  ${m.slice(0, 200)}`));
              if (matches.length > 5) results.push(`     ... and ${matches.length - 5} more`);
            } else {
              results.push(`   ✅ ${logFile}: no alerts`);
            }
          }

          results.push("", `📊 Total alerts: ${totalMatches}`);

          return { content: [{ type: "text", text: results.join("\n") }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
