import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.env.HOME || process.cwd(), ".workflow-mcp");
const DB_PATH = join(DATA_DIR, "workflow-mcp.db");

let _db: Database.Database | null = null;

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getDb(): Database.Database {
  if (_db) return _db;
  ensureDir();
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      environment TEXT NOT NULL,
      branch TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','failed','rolled_back')),
      output TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      name TEXT PRIMARY KEY,
      cron TEXT NOT NULL,
      command TEXT,
      tool TEXT,
      tool_args TEXT,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_run TEXT,
      last_result TEXT
    );

    CREATE TABLE IF NOT EXISTS secrets (
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      profile TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (key, profile)
    );

    CREATE TABLE IF NOT EXISTS workflows (
      name TEXT PRIMARY KEY,
      description TEXT,
      steps TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','failed','cancelled')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      result TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_run_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      step_index INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','success','failed','skipped')),
      input TEXT,
      output TEXT,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_deployments_env ON deployments(environment);
    CREATE INDEX IF NOT EXISTS idx_deployments_timestamp ON deployments(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_name ON workflow_runs(workflow_name);
  `);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
