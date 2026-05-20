import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import {
  FileBatchRenameSchema,
  FileBatchConvertSchema,
  FileCompressSchema,
  FileArchiveSchema,
  FileFindDuplicatesSchema,
} from "../types.js";
import { execSafe, commandExists } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { readdirSync, statSync, renameSync, existsSync, mkdirSync, copyFileSync, unlinkSync, createReadStream, createWriteStream, readFileSync } from "node:fs";
import { join, extname, dirname, basename, relative } from "node:path";
import { createHash } from "node:crypto";

export function getFileProcessingTools(): ToolDefinition[] {
  return [
    {
      name: "file_batch_rename",
      description: "Batch rename files using pattern matching (glob or regex)",
      inputSchema: zToJsonSchema(FileBatchRenameSchema),
      handler: async (args) => {
        try {
          const { directory, pattern, replacement, useRegex, dryRun } = FileBatchRenameSchema.parse(args);

          if (!existsSync(directory)) {
            return { content: [{ type: "text", text: `Directory not found: ${directory}` }], isError: true };
          }

          const files = readdirSync(directory);
          const results: string[] = [];
          let renamed = 0;

          for (const file of files) {
            const filePath = join(directory, file);
            if (!statSync(filePath).isFile()) continue;

            let newName: string | null = null;
            if (useRegex) {
              const regex = new RegExp(pattern);
              newName = file.replace(regex, replacement);
            } else {
              newName = file.replace(new RegExp(pattern.replace(/\*/g, ".*").replace(/\?/g, ".")), replacement);
            }

            if (newName && newName !== file) {
              const newPath = join(directory, newName);
              if (dryRun) {
                results.push(`[DRY RUN] ${file} → ${newName}`);
              } else {
                renameSync(filePath, newPath);
                results.push(`Renamed: ${file} → ${newName}`);
              }
              renamed++;
            }
          }

          const prefix = dryRun ? "[DRY RUN] " : "";
          return {
            content: [{ type: "text", text: `${prefix}Renamed ${renamed} file(s).\n${results.join("\n")}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "file_batch_convert",
      description: "Batch convert files between formats (e.g., .png → .jpg)",
      inputSchema: zToJsonSchema(FileBatchConvertSchema),
      handler: async (args) => {
        try {
          const { directory, fromFormat, toFormat, recursive, keepOriginal } = FileBatchConvertSchema.parse(args);

          if (!existsSync(directory)) {
            return { content: [{ type: "text", text: `Directory not found: ${directory}` }], isError: true };
          }

          // Use imagemagick (convert) or ffmpeg for conversion
          const hasConvert = commandExists("convert");
          const hasFfmpeg = commandExists("ffmpeg");

          if (!hasConvert && !hasFfmpeg) {
            return {
              content: [{ type: "text", text: "No conversion tool found. Install ImageMagick (`convert`) or FFmpeg." }],
              isError: true,
            };
          }

          const tools = hasConvert ? "convert" : "ffmpeg";

          // Collect files
          const fromExt = fromFormat.startsWith(".") ? fromFormat : `.${fromFormat}`;
          const toExt = toFormat.startsWith(".") ? toFormat : `.${toFormat}`;

          const collectFiles = (dir: string, recursive: boolean): string[] => {
            const result: string[] = [];
            const entries = readdirSync(dir);
            for (const entry of entries) {
              const fullPath = join(dir, entry);
              const stat = statSync(fullPath);
              if (stat.isFile() && fullPath.toLowerCase().endsWith(fromExt.toLowerCase())) {
                result.push(fullPath);
              } else if (stat.isDirectory() && recursive) {
                result.push(...collectFiles(fullPath, true));
              }
            }
            return result;
          };

          const files = collectFiles(directory, recursive ?? false);
          if (files.length === 0) {
            return { content: [{ type: "text", text: `No files matching ${fromExt} found.` }] };
          }

          const results: string[] = [];
          for (const file of files) {
            const outPath = file.slice(0, -fromExt.length) + toExt;
            let r: import("../utils/exec.js").ExecResult;
            if (hasConvert) {
              r = execSafe("convert", [file, outPath], { timeout: 120_000 });
            } else {
              r = execSafe("ffmpeg", ["-i", file, outPath, "-y"], { timeout: 120_000 });
            }
            if (r.exitCode === 0) {
              results.push(`Converted: ${basename(file)} → ${basename(outPath)}`);
              if (!keepOriginal) unlinkSync(file);
            } else {
              results.push(`Failed: ${basename(file)} - ${r.stderr}`);
            }
          }

          return {
            content: [{ type: "text", text: `Converted ${results.filter((r) => r.startsWith("Converted")).length} file(s).\n${results.join("\n")}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "file_compress",
      description: "Compress files or directories into an archive (zip/tar)",
      inputSchema: zToJsonSchema(FileCompressSchema),
      handler: async (args) => {
        try {
          const { source, output, format } = FileCompressSchema.parse(args);

          if (!existsSync(source)) {
            return { content: [{ type: "text", text: `Source not found: ${source}` }], isError: true };
          }

          const fmt = format ?? (statSync(source).isDirectory() ? "tar.gz" : "zip");
          const extMap: Record<string, string> = { zip: "zip", tar: "tar", "tar.gz": "tar.gz", "tar.bz2": "tar.bz2" };
          const outPath = output ?? `${source}.${extMap[fmt] ?? fmt}`;

          let fmtArg: string[];
          switch (fmt) {
            case "zip":
              fmtArg = ["-r", outPath, source];
              break;
            case "tar":
              fmtArg = ["-cf", outPath, source];
              break;
            case "tar.gz":
              fmtArg = ["-czf", outPath, source];
              break;
            case "tar.bz2":
              fmtArg = ["-cjf", outPath, source];
              break;
            default:
              return { content: [{ type: "text", text: `Unsupported format: ${fmt}` }], isError: true };
          }

          const tool = fmt === "zip" ? "zip" : "tar";
          const r = execSafe(tool, fmtArg, { timeout: 120_000 });
          if (r.exitCode !== 0) {
            return { content: [{ type: "text", text: `Compression failed: ${r.stderr}` }], isError: true };
          }

          return {
            content: [{ type: "text", text: `✅ Compressed to ${outPath} (${fmt} format).` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "file_archive",
      description: "Organize files into folders by date, type, or size",
      inputSchema: zToJsonSchema(FileArchiveSchema),
      handler: async (args) => {
        try {
          const { source, destination, organizeBy } = FileArchiveSchema.parse(args);

          if (!existsSync(source)) {
            return { content: [{ type: "text", text: `Source not found: ${source}` }], isError: true };
          }

          const strategy = organizeBy ?? "type";
          const stat = statSync(source);
          const files = stat.isDirectory()
            ? readdirSync(source).filter((f) => statSync(join(source, f)).isFile())
            : [basename(source)];

          const srcDir = stat.isDirectory() ? source : dirname(source);
          const destDir = destination ?? `${source}_organized`;
          if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

          const results: string[] = [];
          for (const file of files) {
            const filePath = join(srcDir, file);
            let subDir: string;

            switch (strategy) {
              case "type": {
                const ext = extname(file).slice(1).toLowerCase() || "no_extension";
                subDir = ext;
                break;
              }
              case "date": {
                const fileStat = statSync(filePath);
                const mtime = fileStat.mtime;
                subDir = `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, "0")}`;
                break;
              }
              case "size": {
                const fileSize = statSync(filePath).size;
                if (fileSize < 1024) subDir = "tiny_<1KB";
                else if (fileSize < 1024 * 1024) subDir = "small_1KB-1MB";
                else if (fileSize < 100 * 1024 * 1024) subDir = "medium_1MB-100MB";
                else subDir = "large_>100MB";
                break;
              }
              default:
                subDir = "other";
            }

            const targetDir = join(destDir, subDir);
            if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
            copyFileSync(filePath, join(targetDir, file));
            unlinkSync(filePath);
            results.push(`Moved: ${file} → ${subDir}/`);
          }

          return {
            content: [{ type: "text", text: `Organized ${results.length} file(s) by "${strategy}" into ${destDir}.\n${results.join("\n")}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "file_find_duplicates",
      description: "Find duplicate files in a directory by content hash",
      inputSchema: zToJsonSchema(FileFindDuplicatesSchema),
      handler: async (args) => {
        try {
          const { directory, namePattern, minSize } = FileFindDuplicatesSchema.parse(args);

          if (!existsSync(directory)) {
            return { content: [{ type: "text", text: `Directory not found: ${directory}` }], isError: true };
          }

          const hashMap = new Map<string, string[]>();
          const collectFiles = (dir: string): void => {
            const entries = readdirSync(dir);
            for (const entry of entries) {
              const fullPath = join(dir, entry);
              try {
                const s = statSync(fullPath);
                if (s.isDirectory()) {
                  collectFiles(fullPath);
                } else if (s.isFile()) {
                  if (namePattern && !entry.includes(namePattern)) continue;
                  if (minSize && s.size < minSize) continue;

                  // Compute MD5 hash via Node.js crypto (no shell)
                  let fileHash = "";
                  try {
                    const hash = createHash("md5");
                    const content = readFileSync(fullPath);
                    hash.update(content);
                    fileHash = hash.digest("hex");
                  } catch {
                    // Skip inaccessible files
                  }

                  if (fileHash) {
                    const existing = hashMap.get(fileHash) ?? [];
                    existing.push(fullPath);
                    hashMap.set(fileHash, existing);
                  }
                }
              } catch {
                // Skip inaccessible files
              }
            }
          };

          collectFiles(directory);

          const duplicates = Array.from(hashMap.entries()).filter(([, paths]) => paths.length > 1);

          if (duplicates.length === 0) {
            return { content: [{ type: "text", text: "No duplicate files found." }] };
          }

          const totalSize = duplicates.reduce((sum, [, paths]) => {
            try {
              return sum + statSync(paths[0]).size * (paths.length - 1);
            } catch {
              return sum;
            }
          }, 0);

          const lines: string[] = [`Found ${duplicates.length} group(s) of duplicate files.`];
          lines.push(`Wasted space: ~${(totalSize / 1024 / 1024).toFixed(2)} MB`);
          lines.push("");

          for (const [hash, paths] of duplicates.slice(0, 20)) {
            lines.push(`Hash: ${hash}`);
            for (const p of paths) {
              lines.push(`  ${p}`);
            }
            lines.push("");
          }

          if (duplicates.length > 20) {
            lines.push(`... and ${duplicates.length - 20} more groups.`);
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
