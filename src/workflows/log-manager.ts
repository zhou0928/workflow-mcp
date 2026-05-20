import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { exec } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
  keywords: z.array(z.string()).optional().describe("Keywords to alert on"),
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
          const { file, lines, follow, timeout } = LogTailSchema.parse(args);
          const numLines = Math.min(lines ?? 50, 5000);

          if (!existsSync(file)) {
            return { content: [{ type: "text", text: `❌ File not found: ${file}` }], isError: true };
          }

          const stat = statSync(file);
          if (!stat.isFile()) {
            return { content: [{ type: "text", text: `❌ Not a file: ${file}` }], isError: true };
          }

          const t = follow ? (timeout ?? 30) : 10;
          const cmd = follow
            ? `tail -n ${numLines} -f '${file}' & PID=$!; sleep ${t}; kill $PID 2>/dev/null; wait $PID 2>/dev/null`
            : `tail -n ${numLines} '${file}'`;

          const result = exec(cmd, { timeout: (t + 5) * 1000 });

          if (result.exitCode !== 0 && result.stderr && !result.stderr.includes("killed") && !result.stderr.includes("Terminated")) {
            return { content: [{ type: "text", text: `❌ Failed to read log.\n${result.stderr}` }], isError: true };
          }

          const info = `File: ${file} (${formatSize(stat.size)})`;
          return {
            content: [{ type: "text", text: [info, "", result.stdout.slice(0, 10000)].join("\n") }],
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

          const caseFlag = ignoreCase ?? true ? "-i" : "";
          const cmd = `grep -n ${caseFlag} -C ${ctx} '${pattern.replace(/'/g, "'\\''")}' '${file}' | head -n ${max * (ctx * 2 + 1)}`;

          const result = exec(cmd, { timeout: 30_000 });

          if (result.exitCode === 1 && !result.stdout) {
            return { content: [{ type: "text", text: `No matches found for pattern: ${pattern}` }] };
          }

          if (result.exitCode !== 0 && result.exitCode !== 1) {
            return { content: [{ type: "text", text: `❌ Search failed.\n${result.stderr}` }], isError: true };
          }

          const matchCount = result.stdout.split("\n").filter((l) => l.match(/^\d+:/)).length;
          return {
            content: [{ type: "text", text: `🔍 Found ${matchCount} match(es) for "${pattern}" in ${file}\n\n${result.stdout.slice(0, 10000)}` }],
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

          // Rotate: remove oldest, shift existing, compress
          const dir = file.substring(0, file.lastIndexOf("/")) || ".";
          const base = file.substring(file.lastIndexOf("/") + 1);

          // Remove oldest if over limit
          if (keepCount > 0) {
            const oldest = `${file}.${keepCount}`;
            if (existsSync(oldest)) exec(`rm -f '${oldest}'`, { timeout: 5_000 });
            if (compress && existsSync(`${oldest}.gz`)) exec(`rm -f '${oldest}.gz'`, { timeout: 5_000 });
          }

          // Shift existing
          for (let i = keepCount - 1; i >= 1; i--) {
            const src = `${file}.${i}`;
            const srcGz = `${file}.${i}.gz`;
            const dst = `${file}.${i + 1}`;
            if (existsSync(src)) exec(`mv '${src}' '${dst}'`, { timeout: 5_000 });
            if (compress && existsSync(srcGz)) exec(`mv '${srcGz}' '${dst}.gz'`, { timeout: 5_000 });
          }

          // Rotate current
          exec(`cp '${file}' '${file}.1'`, { timeout: 10_000 });
          exec(`: > '${file}'`, { timeout: 5_000 });

          // Compress
          if (compress) {
            exec(`gzip -f '${file}.1'`, { timeout: 30_000 });
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
          const totalLines = exec(`wc -l < '${file}'`, { timeout: 10_000 });
          const lineCount = parseInt(totalLines.stdout || "0");

          // Count by log level
          const errorCount = exec(`grep -ciE '\\berror\\b|\\bfatal\\b|\\bexception\\b|\\bFAIL\\b' '${file}'`, { timeout: 30_000 });
          const warnCount = exec(`grep -ciE '\\bwarn\\b|\\bwarning\\b' '${file}'`, { timeout: 30_000 });
          const infoCount = exec(`grep -ciE '\\binfo\\b' '${file}'`, { timeout: 30_000 });
          const debugCount = exec(`grep -ciE '\\bdebug\\b|\\btrace\\b' '${file}'`, { timeout: 30_000 });

          const errors = parseInt(errorCount.stdout || "0");
          const warns = parseInt(warnCount.stdout || "0");
          const infos = parseInt(infoCount.stdout || "0");
          const debugs = parseInt(debugCount.stdout || "0");

          // Top error messages
          const topErrors = exec(`grep -ioE '(error|fatal|exception)[^.!?\\n]*' '${file}' | sort | uniq -c | sort -rn | head -10`, { timeout: 30_000 });

          const report = [
            `📊 Log Analysis: ${file}`,
            `   Size: ${formatSize(stat.size)}`,
            `   Total lines: ${lineCount}`,
            ``,
            `   Log Level Breakdown:`,
            `     ❌ Errors:   ${errors}${lineCount > 0 ? ` (${(errors / lineCount * 100).toFixed(1)}%)` : ""}`,
            `     ⚠️  Warnings: ${warns}${lineCount > 0 ? ` (${(warns / lineCount * 100).toFixed(1)}%)` : ""}`,
            `     ℹ️  Info:     ${infos}${lineCount > 0 ? ` (${(infos / lineCount * 100).toFixed(1)}%)` : ""}`,
            `     🔍 Debug:    ${debugs}${lineCount > 0 ? ` (${(debugs / lineCount * 100).toFixed(1)}%)` : ""}`,
          ];

          if (topErrors.stdout.trim()) {
            report.push(``, `   Top Error Patterns:`);
            topErrors.stdout.trim().split("\n").slice(0, 10).forEach((line) => {
              report.push(`     ${line.trim()}`);
            });
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
          const dur = duration ?? 60;
          const kw = keywords ?? ["error", "fatal", "exception", "fail"];

          if (!existsSync(directory)) {
            return { content: [{ type: "text", text: `❌ Directory not found: ${directory}` }], isError: true };
          }

          // Find matching log files
          const findCmd = `find '${directory}' -name '${glob}' -type f 2>/dev/null | head -20`;
          const files = exec(findCmd, { timeout: 10_000 });

          const logFiles = files.stdout.trim().split("\n").filter(Boolean);
          if (logFiles.length === 0) {
            return { content: [{ type: "text", text: `No log files matching "${glob}" found in ${directory}.` }] };
          }

          // Build keyword grep pattern
          const kwPattern = kw.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
          const results: string[] = [`👁️  Watching ${logFiles.length} log file(s) for ${dur}s`, `   Keywords: ${kw.join(", ")}`, ""];
          let totalMatches = 0;

          for (const logFile of logFiles) {
            const grepCmd = `tail -f '${logFile}' 2>/dev/null & PID=$!; sleep ${dur}; kill $PID 2>/dev/null; wait $PID 2>/dev/null | grep -iE '${kwPattern}' || true`;
            const result = exec(grepCmd, { timeout: (dur + 5) * 1000 });

            if (result.stdout.trim()) {
              const matches = result.stdout.trim().split("\n").filter(Boolean);
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
