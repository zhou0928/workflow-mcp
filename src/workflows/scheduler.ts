import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { ScheduleAddSchema, ScheduleRemoveSchema, ScheduleListSchema, ScheduleRunNowSchema } from "../types.js";
import { exec } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { getDb } from "../utils/db.js";
import cronParser from "cron-parser";
import { randomUUID } from "node:crypto";

interface ScheduledTask {
  name: string;
  cron: string;
  command?: string;
  tool?: string;
  toolArgs?: Record<string, unknown>;
  description?: string;
  enabled: number;
  createdAt: string;
  lastRun?: string;
  lastResult?: string;
}

// ============================================================
// Daemon state (background heartbeat loop)
// ============================================================

let daemonTimer: ReturnType<typeof setInterval> | null = null;
let daemonStartedAt: string | null = null;
let daemonTickCount = 0;

export function startDaemon(intervalMs = 60_000): void {
  if (daemonTimer) return; // already running

  daemonStartedAt = new Date().toISOString();
  daemonTimer = setInterval(() => {
    daemonTickCount++;
    try {
      const db = getDb();
      const tasks = db.prepare("SELECT * FROM scheduled_tasks WHERE enabled = 1").all() as ScheduledTask[];
      const now = new Date();

      for (const task of tasks) {
        try {
          const interval = cronParser.parseExpression(task.cron);
          const prev = interval.prev().toDate();
          const lastRun = task.lastRun ? new Date(task.lastRun) : null;

          // Run if the cron should have fired since last run (or never run)
          if (!lastRun || prev > lastRun) {
            logger.info(`[Daemon] Triggering task: ${task.name}`);

            let result: string;
            if (task.command) {
              const r = exec(task.command, { timeout: 300_000 });
              result = r.exitCode === 0 ? (r.stdout || "Completed.").slice(0, 2000) : `Failed: ${r.stderr}`;
            } else if (task.tool) {
              result = `[simulated] Tool "${task.tool}" would run with: ${JSON.stringify(task.toolArgs ?? {})}`;
            } else {
              result = "No command or tool configured.";
            }

            db.prepare(
              "UPDATE scheduled_tasks SET last_run = datetime('now'), last_result = ? WHERE name = ?"
            ).run(result.slice(0, 500), task.name);
          }
        } catch {
          // Skip tasks with invalid cron
        }
      }
    } catch (err) {
      logger.error(`[Daemon] Error in heartbeat: ${String(err)}`);
    }
  }, intervalMs);

  logger.info(`[Daemon] Scheduler daemon started (interval: ${intervalMs}ms)`);
}

export function stopDaemon(): void {
  if (daemonTimer) {
    clearInterval(daemonTimer);
    daemonTimer = null;
    daemonStartedAt = null;
    logger.info("[Daemon] Scheduler daemon stopped");
  }
}

export function isDaemonRunning(): boolean {
  return daemonTimer !== null;
}

// ============================================================
// Task storage (backed by SQLite)
// ============================================================

function loadTasks(): ScheduledTask[] {
  try {
    const db = getDb();
    return db.prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC").all() as ScheduledTask[];
  } catch {
    return [];
  }
}

function saveTask(task: ScheduledTask): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO scheduled_tasks (name, cron, command, tool, tool_args, description, enabled, created_at, last_run, last_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    task.name,
    task.cron,
    task.command ?? null,
    task.tool ?? null,
    task.toolArgs ? JSON.stringify(task.toolArgs) : null,
    task.description ?? null,
    task.enabled ?? 1,
    task.createdAt,
    task.lastRun ?? null,
    task.lastResult ?? null
  );
}

function deleteTask(name: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM scheduled_tasks WHERE name = ?").run(name);
  return result.changes > 0;
}

/**
 * Parse cron expression to a human-readable description.
 * Uses the cron-parser package (validates expression).
 */
function describeCron(expression: string): string {
  try {
    // Use cron-parser for validation; fallback description if we can't parse
    const parser = cronParser;
    const interval = parser.parseExpression(expression);
    const next = interval.next().toDate();
    return `Cron: ${expression} (next run: ${next.toISOString()})`;
  } catch {
    return `Cron: ${expression}`;
  }
}

export function getSchedulerTools(): ToolDefinition[] {
  return [
    {
      name: "schedule_add",
      description: "Add a new scheduled task with a cron expression",
      inputSchema: zToJsonSchema(ScheduleAddSchema),
      handler: async (args) => {
        try {
          const { name, cron, command, tool, toolArgs, description } = ScheduleAddSchema.parse(args);
          const db = getDb();

          // Check for duplicate names
          const existing = db.prepare("SELECT name FROM scheduled_tasks WHERE name = ?").get(name);
          if (existing) {
            return { content: [{ type: "text", text: `A task named "${name}" already exists.` }], isError: true };
          }

          // Validate cron expression
          try {
            cronParser.parseExpression(cron);
          } catch {
            return { content: [{ type: "text", text: `Invalid cron expression: "${cron}". Use standard 5-field cron syntax (e.g., "0 9 * * 1-5").` }], isError: true };
          }

          if (!command && !tool) {
            return { content: [{ type: "text", text: "Either command or tool must be specified." }], isError: true };
          }

          db.prepare(
            "INSERT INTO scheduled_tasks (name, cron, command, tool, tool_args, description, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))"
          ).run(name, cron, command ?? null, tool ?? null, toolArgs ? JSON.stringify(toolArgs) : null, description ?? null);

          return {
            content: [
              {
                type: "text",
                text: [
                  `✅ Task "${name}" added.`,
                  describeCron(cron),
                  description ? `Description: ${description}` : "",
                  `Type: ${command ? "shell command" : "MCP tool"}`,
                  daemonTimer ? "Daemon is running — task will auto-trigger." : "⚠️ Daemon is NOT running. Use schedule_start to enable auto-trigger.",
                ]
                  .filter(Boolean)
                  .join("\n"),
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
      name: "schedule_remove",
      description: "Remove a scheduled task",
      inputSchema: zToJsonSchema(ScheduleRemoveSchema),
      handler: async (args) => {
        try {
          const { name } = ScheduleRemoveSchema.parse(args);
          const result = deleteTask(name);
          if (!result) {
            return { content: [{ type: "text", text: `Task "${name}" not found.` }], isError: true };
          }
          return { content: [{ type: "text", text: `✅ Task "${name}" removed.` }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "schedule_list",
      description: "List all scheduled tasks",
      inputSchema: zToJsonSchema(ScheduleListSchema),
      handler: async () => {
        try {
          const tasks = loadTasks();

          if (tasks.length === 0) {
            return { content: [{ type: "text", text: "No scheduled tasks. Use schedule_add to create one." }] };
          }

          const daemonStatus = daemonTimer ? `🟢 Running (since ${daemonStartedAt}, ${daemonTickCount} ticks)` : "🔴 Stopped";
          const lines = [`Daemon: ${daemonStatus}`, "", ...tasks.map((t) => {
            const nextRun = describeCron(t.cron);
            const lastRun = t.lastRun ? `Last run: ${t.lastRun}` : "Never run";
            const type = t.command ? "Shell" : "MCP Tool";
            const enabled = t.enabled ? "✅" : "⛔";
            return [
              `${enabled} ${t.name}`,
              `   ${nextRun}`,
              `   ${lastRun}`,
              `   Type: ${type}`,
              t.description ? `   Description: ${t.description}` : "",
            ].filter(Boolean).join("\n");
          })];

          return {
            content: [{ type: "text", text: [`${tasks.length} scheduled task(s):`, ...lines].join("\n") }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "schedule_run_now",
      description: "Manually trigger a scheduled task immediately",
      inputSchema: zToJsonSchema(ScheduleRunNowSchema),
      handler: async (args) => {
        try {
          const { name } = ScheduleRunNowSchema.parse(args);
          const db = getDb();
          const task = db.prepare("SELECT * FROM scheduled_tasks WHERE name = ?").get(name) as ScheduledTask | undefined;

          if (!task) {
            return { content: [{ type: "text", text: `Task "${name}" not found.` }], isError: true };
          }

          logger.info(`Running task: ${name}`);

          let result: string;
          if (task.command) {
            const r = exec(task.command, { timeout: 300_000 });
            result = r.exitCode === 0 ? (r.stdout || "Completed.").slice(0, 2000) : `Failed: ${r.stderr}`;
          } else if (task.tool) {
            result = `[simulated] Tool "${task.tool}" would run with: ${JSON.stringify(task.toolArgs ?? {})}`;
          } else {
            result = "No command or tool configured.";
          }

          db.prepare(
            "UPDATE scheduled_tasks SET last_run = datetime('now'), last_result = ? WHERE name = ?"
          ).run(result.slice(0, 500), name);

          return {
            content: [{ type: "text", text: [`✅ Task "${name}" executed.`, "", result].join("\n") }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    // === Daemon control tools ===
    {
      name: "schedule_start",
      description: "Start the scheduler daemon (background heartbeat that auto-triggers tasks by cron)",
      inputSchema: zToJsonSchema(z.object({
        interval: z.number().optional().describe("Check interval in seconds (default: 60)"),
      })),
      handler: async (args) => {
        try {
          const { interval } = args as { interval?: number };
          if (daemonTimer) {
            return { content: [{ type: "text", text: "⚠️ Daemon is already running. Use schedule_stop first to restart." }] };
          }
          startDaemon((interval ?? 60) * 1000);
          return { content: [{ type: "text", text: `✅ Scheduler daemon started (check interval: ${interval ?? 60}s). Tasks will auto-trigger by their cron schedule.` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${String(err)}` }], isError: true };
        }
      },
    },
    {
      name: "schedule_stop",
      description: "Stop the scheduler daemon",
      inputSchema: zToJsonSchema(z.object({})),
      handler: async () => {
        try {
          if (!daemonTimer) {
            return { content: [{ type: "text", text: "⚠️ Daemon is not running." }] };
          }
          const runs = daemonTickCount;
          stopDaemon();
          return { content: [{ type: "text", text: `✅ Scheduler daemon stopped. ${runs} heartbeat ticks executed.` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${String(err)}` }], isError: true };
        }
      },
    },
    {
      name: "schedule_status",
      description: "Check if the scheduler daemon is running",
      inputSchema: zToJsonSchema(z.object({})),
      handler: async () => {
        try {
          if (!daemonTimer) {
            return { content: [{ type: "text", text: "🔴 Daemon is NOT running. Use schedule_start to start it." }] };
          }
          const since = daemonStartedAt ?? "unknown";
          return { content: [{ type: "text", text: `🟢 Daemon is running\n   Started: ${since}\n   Heartbeat ticks: ${daemonTickCount}\n   Tasks will auto-trigger on their cron schedule.` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${String(err)}` }], isError: true };
        }
      },
    },
    {
      name: "schedule_toggle",
      description: "Enable or disable a scheduled task without removing it",
      inputSchema: zToJsonSchema(z.object({
        name: z.string().describe("Task name"),
        enabled: z.boolean().describe("true to enable, false to disable"),
      })),
      handler: async (args) => {
        try {
          const { name, enabled } = args as { name: string; enabled: boolean };
          const db = getDb();
          const result = db.prepare("UPDATE scheduled_tasks SET enabled = ? WHERE name = ?").run(enabled ? 1 : 0, name);
          if (result.changes === 0) {
            return { content: [{ type: "text", text: `❌ Task "${name}" not found.` }], isError: true };
          }
          return { content: [{ type: "text", text: `✅ Task "${name}" ${enabled ? "enabled" : "disabled"}.` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${String(err)}` }], isError: true };
        }
      },
    },
  ];
}
