import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { execSafe } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { getDb } from "../utils/db.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";

// ============================================================
// Schemas
// ============================================================

const DbQuerySchema = z.object({
  type: z.enum(["sqlite", "postgres", "mysql", "mariadb"]).describe("Database type"),
  query: z.string().describe("SQL query to execute"),
  connection: z.string().optional().describe("Connection string or file path (for SQLite: path to DB file)"),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Query parameters (positional)"),
});

const DbListTablesSchema = z.object({
  type: z.enum(["sqlite", "postgres", "mysql", "mariadb"]).describe("Database type"),
  connection: z.string().optional().describe("Connection string or file path"),
});

const DbExportSchema = z.object({
  type: z.enum(["sqlite", "postgres", "mysql", "mariadb"]).describe("Database type"),
  query: z.string().describe("SQL query to export"),
  output: z.string().optional().describe("Output file path (default: stdout)"),
  format: z.enum(["json", "csv"]).optional().describe("Output format (default: json)"),
  connection: z.string().optional().describe("Connection string or file path"),
});

const DbImportSchema = z.object({
  type: z.enum(["sqlite", "postgres", "mysql", "mariadb"]).describe("Database type"),
  table: z.string().describe("Target table name"),
  input: z.string().describe("Input file path (CSV or JSON)"),
  connection: z.string().optional().describe("Connection string or file path"),
  mode: z.enum(["append", "replace"]).optional().describe("Import mode (default: append)"),
});

// ============================================================
// Helpers
// ============================================================

function runSqliteQuery(dbPath: string, query: string, params?: unknown[]): { rows: Record<string, unknown>[]; affected: number } {
  const db = new Database(dbPath);
  try {
    const stmt = db.prepare(query);
    if (query.trim().toUpperCase().startsWith("SELECT") || query.trim().toUpperCase().startsWith("WITH")) {
      const rows = params ? stmt.all(...params) : stmt.all();
      const result = (rows as Record<string, unknown>[]).map((r) => ({ ...r }));
      return { rows: result, affected: 0 };
    } else {
      const info = params ? stmt.run(...params) : stmt.run();
      return { rows: [], affected: info.changes };
    }
  } finally {
    db.close();
  }
}

function runExternalDb(type: string, query: string, connection: string, params?: unknown[]): { rows: Record<string, unknown>[]; affected: number } {
  // Use CLI tools for external databases — no shell to avoid injection
  let result: import("../utils/exec.js").ExecResult;

  switch (type) {
    case "postgres": {
      result = execSafe("psql", [connection, "-c", query, "--csv", "-t"], { timeout: 30_000 });
      break;
    }
    case "mysql":
    case "mariadb": {
      // connection format: host:port (e.g. localhost:3306)
      const [host, portStr] = connection ? connection.split(":") : ["localhost", "3306"];
      const args = ["-h", host];
      if (portStr) args.push("-P", portStr);
      args.push("-e", query);
      result = execSafe("mysql", args, { timeout: 30_000 });
      break;
    }
    default:
      throw new Error(`Unsupported database type: ${type}`);
  }

  if (result.exitCode !== 0) {
    throw new Error(`Database query failed: ${result.stderr || result.stdout}`);
  }

  return {
    rows: query.trim().toUpperCase().startsWith("SELECT") ? [{ result: result.stdout.slice(0, 5000) }] : [],
    affected: 0,
  };
}

// ============================================================
// Tool factory
// ============================================================

export function getDatabaseTools(): ToolDefinition[] {
  return [
    {
      name: "db_query",
      description: "Execute a SQL query against a database (SQLite, PostgreSQL, MySQL, MariaDB)",
      inputSchema: zToJsonSchema(DbQuerySchema),
      handler: async (args) => {
        try {
          const { type, query, connection, params } = DbQuerySchema.parse(args);

          let rows: Record<string, unknown>[] = [];
          let affected = 0;

          if (type === "sqlite") {
            const dbPath = connection ?? join(process.cwd(), "data.db");
            const result = runSqliteQuery(dbPath, query, params);
            rows = result.rows;
            affected = result.affected;
          } else {
            if (!connection) {
              return { content: [{ type: "text", text: `Connection string required for ${type}.` }], isError: true };
            }
            const result = runExternalDb(type, query, connection, params);
            rows = result.rows;
            affected = result.affected;
          }

          if (query.trim().toUpperCase().startsWith("SELECT") || query.trim().toUpperCase().startsWith("WITH")) {
            const preview = JSON.stringify(rows.slice(0, 20), null, 2);
            const total = rows.length;
            return {
              content: [{ type: "text", text: `✅ Query returned ${total} row(s).\n\nPreview (${Math.min(total, 20)} shown):\n${preview}` }],
            };
          } else {
            return { content: [{ type: "text", text: `✅ Query executed. ${affected} row(s) affected.` }] };
          }
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "db_list_tables",
      description: "List all tables in a database",
      inputSchema: zToJsonSchema(DbListTablesSchema),
      handler: async (args) => {
        try {
          const { type, connection } = DbListTablesSchema.parse(args);

          let tables: string[] = [];

          if (type === "sqlite") {
            const dbPath = connection ?? join(process.cwd(), "data.db");
            const result = runSqliteQuery(dbPath, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
            tables = result.rows.map((r) => String(r.name));
          } else {
            if (!connection) {
              return { content: [{ type: "text", text: `Connection string required for ${type}.` }], isError: true };
            }
            const q = type === "postgres"
              ? "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
              : "SHOW TABLES";
            const result = runExternalDb(type, q, connection);
            tables = result.rows.map((r) => String(r.table_name || r.result || ""));
          }

          if (tables.length === 0) {
            return { content: [{ type: "text", text: "No tables found." }] };
          }

          return {
            content: [{ type: "text", text: [`${type} — ${tables.length} table(s):`, ...tables.map((t) => `  📋 ${t}`)].join("\n") }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "db_export",
      description: "Export query results to JSON or CSV file",
      inputSchema: zToJsonSchema(DbExportSchema),
      handler: async (args) => {
        try {
          const { type, query, output, format, connection } = DbExportSchema.parse(args);
          const outFormat = format ?? "json";

          let rows: Record<string, unknown>[] = [];

          if (type === "sqlite") {
            const dbPath = connection ?? join(process.cwd(), "data.db");
            const result = runSqliteQuery(dbPath, query);
            rows = result.rows;
          } else {
            if (!connection) {
              return { content: [{ type: "text", text: `Connection string required for ${type}.` }], isError: true };
            }
            const result = runExternalDb(type, query, connection);
            rows = result.rows;
          }

          const outPath = output ?? `export_${Date.now()}.${outFormat}`;

          const dir = dirname(outPath);
          if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

          if (outFormat === "csv") {
            if (rows.length === 0) {
              writeFileSync(outPath, "", "utf-8");
            } else {
              const headers = Object.keys(rows[0]);
              const csvLines = [
                headers.join(","),
                ...rows.map((r) => headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(",")),
              ];
              writeFileSync(outPath, csvLines.join("\n"), "utf-8");
            }
          } else {
            writeFileSync(outPath, JSON.stringify(rows, null, 2), "utf-8");
          }

          return { content: [{ type: "text", text: `✅ Exported ${rows.length} row(s) to ${outPath} (${outFormat})` }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "db_import",
      description: "Import data from CSV or JSON file into a database table",
      inputSchema: zToJsonSchema(DbImportSchema),
      handler: async (args) => {
        try {
          const { type, table, input, connection, mode } = DbImportSchema.parse(args);
          const importMode = mode ?? "append";

          if (!existsSync(input)) {
            return { content: [{ type: "text", text: `Input file not found: ${input}` }], isError: true };
          }

          const content = readFileSync(input, "utf-8");
          let data: Record<string, unknown>[];

          if (input.endsWith(".csv")) {
            const lines = content.split("\n").filter((l) => l.trim());
            if (lines.length < 2) {
              return { content: [{ type: "text", text: "CSV file must have at least a header row and one data row." }], isError: true };
            }
            const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
            data = lines.slice(1).map((line) => {
              const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
              const row: Record<string, unknown> = {};
              headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
              return row;
            });
          } else {
            data = JSON.parse(content);
            if (!Array.isArray(data)) {
              data = [data];
            }
          }

          if (data.length === 0) {
            return { content: [{ type: "text", text: "No data to import." }], isError: true };
          }

          if (type === "sqlite") {
            const dbPath = connection ?? join(process.cwd(), "data.db");
            const db = new Database(dbPath);
            try {
              if (importMode === "replace") {
                db.exec(`DELETE FROM "${table}"`);
              }

              const headers = Object.keys(data[0]);
              const placeholders = headers.map(() => "?").join(",");
              const columns = headers.map((h) => `"${h}"`).join(",");
              const insert = db.prepare(`INSERT INTO "${table}" (${columns}) VALUES (${placeholders})`);

              const insertMany = db.transaction((rows: Record<string, unknown>[]) => {
                for (const row of rows) {
                  insert.run(...headers.map((h) => row[h] ?? null));
                }
              });

              insertMany(data);

              return { content: [{ type: "text", text: `✅ Imported ${data.length} row(s) into "${table}" (mode: ${importMode})` }] };
            } finally {
              db.close();
            }
          } else {
            return { content: [{ type: "text", text: `External DB import for ${type} not yet supported. Use the CLI tools directly.` }] };
          }
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}


