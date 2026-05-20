import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { EtlExtractSchema, EtlTransformSchema, EtlLoadSchema, EtlRunPipelineSchema } from "../types.js";
import { exec } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, createReadStream, createWriteStream } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { cwd } from "node:process";

// Simple CSV parser (no external deps)
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? "";
    });
    return row;
  });
}

function toCsv(data: Record<string, string>[]): string {
  if (data.length === 0) return "";
  const headers = Object.keys(data[0]);
  const lines = data.map((row) =>
    headers.map((h) => {
      const v = row[h] ?? "";
      return v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(",")
  );
  return [headers.join(","), ...lines].join("\n");
}

interface PipelineStep {
  type: "extract" | "transform" | "load";
  config: Record<string, unknown>;
}

function runExtract(sourceType: string, sourceConfig: Record<string, string>, query?: string): Record<string, string>[] {
  switch (sourceType) {
    case "csv": {
      const filePath = sourceConfig["filePath"] || sourceConfig["path"];
      if (!filePath || !existsSync(filePath)) {
        throw new Error(`CSV file not found: ${filePath}`);
      }
      const content = readFileSync(filePath, "utf-8");
      return parseCsv(content);
    }
    case "json": {
      const filePath = sourceConfig["filePath"] || sourceConfig["path"];
      if (!filePath || !existsSync(filePath)) {
        throw new Error(`JSON file not found: ${filePath}`);
      }
      const content = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [parsed];
    }
    case "file": {
      const dir = sourceConfig["directory"] || sourceConfig["dir"] || ".";
      const pattern = sourceConfig["pattern"] || "*";
      const entries = readdirSync(dir).filter((f) => {
        if (pattern === "*") return true;
        return f.includes(pattern.replace("*", ""));
      });
      return entries.map((name) => {
        const fullPath = join(dir, name);
        const s = statSync(fullPath);
        return { name, path: fullPath, size: String(s.size), modified: s.mtime.toISOString() };
      });
    }
    case "api": {
      const url = sourceConfig["url"];
      if (!url) throw new Error("API URL required");
      const result = exec(`curl -s "${url}"`, { timeout: 30_000 });
      if (result.exitCode !== 0) throw new Error(`API request failed: ${result.stderr}`);
      return [{ data: result.stdout }];
    }
    case "database": {
      // Placeholder - real DB connections need more config
      return [{ message: "Database extraction requires database-specific configuration. Implement your own connection." }];
    }
    default:
      throw new Error(`Unsupported source type: ${sourceType}`);
  }
}

function applyTransforms(data: Record<string, string>[], rules: z.infer<typeof EtlTransformSchema>["rules"]): Record<string, string>[] {
  let result = [...data];

  for (const rule of rules) {
    switch (rule.operation) {
      case "rename": {
        const newName = (rule.params as Record<string, unknown>)?.["to"] as string;
        if (!newName) throw new Error("rename operation requires 'to' param");
        result = result.map((row) => {
          const newRow = { ...row };
          if (rule.field in newRow) {
            newRow[newName] = newRow[rule.field];
            delete newRow[rule.field];
          }
          return newRow;
        });
        break;
      }
      case "remove":
        result = result.map((row) => {
          const newRow = { ...row };
          delete newRow[rule.field];
          return newRow;
        });
        break;
      case "cast": {
        const type = (rule.params as Record<string, unknown>)?.["type"] as string;
        result = result.map((row) => {
          const newRow = { ...row };
          if (rule.field in newRow) {
            const val = newRow[rule.field];
            switch (type) {
              case "number":
                newRow[rule.field] = String(Number(val));
                break;
              case "boolean":
                newRow[rule.field] = String(val === "true" || val === "1" || val === "yes");
                break;
              case "date":
                newRow[rule.field] = new Date(val).toISOString();
                break;
              // default: keep as string
            }
          }
          return newRow;
        });
        break;
      }
      case "default": {
        const defaultVal = (rule.params as Record<string, unknown>)?.["value"] as string;
        result = result.map((row) => {
          if (!row[rule.field] || row[rule.field].trim() === "") {
            return { ...row, [rule.field]: defaultVal ?? "" };
          }
          return row;
        });
        break;
      }
      case "map": {
        const mapping = (rule.params as Record<string, unknown>)?.["mapping"] as Record<string, string> | undefined;
        if (!mapping) throw new Error("map operation requires 'mapping' param");
        result = result.map((row) => {
          const val = row[rule.field];
          return { ...row, [rule.field]: mapping[val] ?? val };
        });
        break;
      }
      case "filter": {
        const filterVal = (rule.params as Record<string, unknown>)?.["value"] as string;
        const operator = ((rule.params as Record<string, unknown>)?.["operator"] as string) ?? "eq";
        result = result.filter((row) => {
          const val = row[rule.field];
          switch (operator) {
            case "eq": return val === filterVal;
            case "neq": return val !== filterVal;
            case "gt": return Number(val) > Number(filterVal);
            case "gte": return Number(val) >= Number(filterVal);
            case "lt": return Number(val) < Number(filterVal);
            case "lte": return Number(val) <= Number(filterVal);
            case "contains": return val.includes(filterVal ?? "");
            default: return true;
          }
        });
        break;
      }
    }
  }

  return result;
}

function writeOutput(data: Record<string, string>[], filePath: string, format: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (format === "csv") {
    writeFileSync(filePath, toCsv(data), "utf-8");
  } else {
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}

export function getEtlTools(): ToolDefinition[] {
  return [
    {
      name: "etl_extract",
      description: "Extract data from a source (CSV, JSON, API, file)",
      inputSchema: zToJsonSchema(EtlExtractSchema),
      handler: async (args) => {
        try {
          const { sourceType, sourceConfig, output, query } = EtlExtractSchema.parse(args);
          logger.info(`Extracting data from ${sourceType}`);

          const data = runExtract(sourceType, sourceConfig, query);

          if (output) {
            const fmt = output.endsWith(".csv") ? "csv" : "json";
            writeOutput(data, output, fmt);
            return { content: [{ type: "text", text: `✅ Extracted ${data.length} records to ${output}` }] };
          }

          const preview = data.slice(0, 10);
          return {
            content: [
              {
                type: "text",
                text: [
                  `Extracted ${data.length} record(s).`,
                  "",
                  "Preview (first 10):",
                  JSON.stringify(preview, null, 2).slice(0, 3000),
                ].join("\n"),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "etl_transform",
      description: "Transform data using rule pipelines (rename, remove, cast, filter, etc.)",
      inputSchema: zToJsonSchema(EtlTransformSchema),
      handler: async (args) => {
        try {
          const { input, rules, output, format } = EtlTransformSchema.parse(args);

          if (!existsSync(input)) {
            return { content: [{ type: "text", text: `Input file not found: ${input}` }], isError: true };
          }

          const content = readFileSync(input, "utf-8");
          const ext = extname(input).toLowerCase();
          const data = ext === ".csv" ? parseCsv(content) : JSON.parse(content);

          const transformed = applyTransforms(data, rules);

          const outFormat = format ?? (ext === ".csv" ? "csv" : "json");
          const outPath = output ?? `transformed_output.${outFormat === "csv" ? "csv" : "json"}`;

          writeOutput(transformed, outPath, outFormat);

          return {
            content: [{ type: "text", text: `✅ Transformed ${data.length} → ${transformed.length} records. Output: ${outPath}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "etl_load",
      description: "Load data to a destination (JSON file, CSV file, or API)",
      inputSchema: zToJsonSchema(EtlLoadSchema),
      handler: async (args) => {
        try {
          const { input, destinationType, destinationConfig, mode } = EtlLoadSchema.parse(args);

          if (!existsSync(input)) {
            return { content: [{ type: "text", text: `Input file not found: ${input}` }], isError: true };
          }

          const content = readFileSync(input, "utf-8");
          const loadMode = mode ?? "replace";

          switch (destinationType) {
            case "json": {
              const outPath = destinationConfig["filePath"] || destinationConfig["path"] || "output.json";
              const dir = dirname(outPath);
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

              if (loadMode === "append" && existsSync(outPath)) {
                const existing = JSON.parse(readFileSync(outPath, "utf-8"));
                const newData = JSON.parse(content);
                const merged = Array.isArray(existing) && Array.isArray(newData) ? [...existing, ...newData] : newData;
                writeFileSync(outPath, JSON.stringify(merged, null, 2), "utf-8");
              } else {
                writeFileSync(outPath, content, "utf-8");
              }
              return { content: [{ type: "text", text: `✅ Loaded data to ${outPath} (mode: ${loadMode})` }] };
            }
            case "csv": {
              const outPath = destinationConfig["filePath"] || destinationConfig["path"] || "output.csv";
              const dir = dirname(outPath);
              if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

              const data = JSON.parse(content);
              const csv = toCsv(Array.isArray(data) ? data : [data]);

              if (loadMode === "append" && existsSync(outPath)) {
                // Append without headers
                const existingLines = readFileSync(outPath, "utf-8").trim().split("\n");
                const newLines = csv.trim().split("\n");
                const combined = existingLines[0] === newLines[0]
                  ? [...existingLines, ...newLines.slice(1)]
                  : [...existingLines, ...newLines];
                writeFileSync(outPath, combined.join("\n"), "utf-8");
              } else {
                writeFileSync(outPath, csv, "utf-8");
              }
              return { content: [{ type: "text", text: `✅ Loaded data to ${outPath} (mode: ${loadMode})` }] };
            }
            case "api": {
              const url = destinationConfig["url"];
              if (!url) return { content: [{ type: "text", text: "API URL required for API destination." }], isError: true };
              const method = (destinationConfig["method"] ?? "POST").toUpperCase();
              const result = exec(`curl -s -X ${method} "${url}" -H "Content-Type: application/json" -d ${JSON.stringify(JSON.stringify(JSON.parse(content)))}`, { timeout: 60_000 });
              if (result.exitCode !== 0) {
                return { content: [{ type: "text", text: `API load failed: ${result.stderr}` }], isError: true };
              }
              return { content: [{ type: "text", text: `✅ Data loaded to API (${url}). Response: ${result.stdout.slice(0, 500)}` }] };
            }
            case "database": {
              return { content: [{ type: "text", text: "Database loading requires specific connection config. Use a custom pipeline for this." }] };
            }
            default:
              return { content: [{ type: "text", text: `Unsupported destination: ${destinationType}` }], isError: true };
          }
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "etl_run_pipeline",
      description: "Run a complete ETL pipeline from inline or file-based configuration",
      inputSchema: zToJsonSchema(EtlRunPipelineSchema),
      handler: async (args) => {
        try {
          const { name, configPath, config, vars } = EtlRunPipelineSchema.parse(args);
          logger.info(`Running ETL pipeline: ${name}`);

          // Load pipeline config
          let pipelineConfig: { extract?: Record<string, unknown>; transforms?: unknown[]; load?: Record<string, unknown> };

          if (configPath) {
            if (!existsSync(configPath)) {
              return { content: [{ type: "text", text: `Config file not found: ${configPath}` }], isError: true };
            }
            pipelineConfig = JSON.parse(readFileSync(configPath, "utf-8"));
          } else if (config) {
            pipelineConfig = JSON.parse(config);
          } else {
            return { content: [{ type: "text", text: "Either configPath or config is required." }], isError: true };
          }

          // Apply variable substitution
          const applyVars = (obj: Record<string, unknown>): Record<string, string> => {
            const result: Record<string, string> = {};
            for (const [k, v] of Object.entries(obj)) {
              let val = String(v);
              if (vars) {
                for (const [vk, vv] of Object.entries(vars)) {
                  val = val.replace(`\${${vk}}`, vv);
                }
              }
              result[k] = val;
            }
            return result;
          };

          // Step 1: Extract
          const extractCfg = pipelineConfig.extract ?? {};
          const sourceType = String(extractCfg["sourceType"] ?? "json");
          const sourceConfig = applyVars(extractCfg as Record<string, unknown>);
          const data = runExtract(sourceType, sourceConfig, String(extractCfg["query"] ?? ""));

          // Step 2: Transform
          const transformRules = (pipelineConfig.transforms ?? []) as {
            field: string;
            operation: string;
            params?: Record<string, unknown>;
          }[];
          const transformed = applyTransforms(
            data,
            transformRules.map((r) => ({
              field: r.field,
              operation: r.operation as z.infer<typeof EtlTransformSchema>["rules"][number]["operation"],
              params: r.params,
            }))
          );

          // Step 3: Load
          const loadCfg = pipelineConfig.load ?? {};
          const destinationType = String(loadCfg["destinationType"] ?? "json");
          const destinationConfig = applyVars(loadCfg as Record<string, unknown>);
          const loadMode = String(loadCfg["mode"] ?? "replace");

          const outPath = destinationConfig["filePath"] || destinationConfig["path"] || `pipeline_${name}_output.${destinationType === "csv" ? "csv" : "json"}`;
          writeOutput(transformed, outPath, destinationType);

          return {
            content: [
              {
                type: "text",
                text: [
                  `✅ Pipeline "${name}" completed.`,
                  `  Extract:  ${data.length} records from ${sourceType}`,
                  `  Transform: ${transformed.length} records after ${transformRules.length} rule(s)`,
                  `  Load:     ${outPath} (${destinationType}, mode: ${loadMode})`,
                ].join("\n"),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
