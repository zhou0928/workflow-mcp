import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { ScheduleAddSchema, ScheduleRemoveSchema, ScheduleListSchema, ScheduleRunNowSchema } from "../types.js";
import { exec } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

interface ScheduledTask {
  name: string;
  cron: string;
  command?: string;
  tool?: string;
  toolArgs?: Record<string, unknown>;
  description?: string;
  createdAt: string;
  lastRun?: string;
  lastResult?: string;
}

const DATA_DIR = join(process.env.HOME || process.cwd(), ".workflow-mcp");
const TASKS_FILE = join(DATA_DIR, "scheduled-tasks.json");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadTasks(): ScheduledTask[] {
  ensureDataDir();
  if (!existsSync(TASKS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TASKS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveTasks(tasks: ScheduledTask[]): void {
  ensureDataDir();
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8");
}

/**
 * Parse cron expression to a human-readable description.
 * Uses the cron-parser package (validates expression).
 */
function describeCron(expression: string): string {
  try {
    // Use cron-parser for validation; fallback description if we can't parse
    const parser = require("cron-parser");
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

          const tasks = loadTasks();

          // Check for duplicate names
          if (tasks.some((t) => t.name === name)) {
            return { content: [{ type: "text", text: `A task named "${name}" already exists.` }], isError: true };
          }

          // Validate cron expression
          try {
            const parser = require("cron-parser");
            parser.parseExpression(cron);
          } catch {
            return { content: [{ type: "text", text: `Invalid cron expression: "${cron}". Use standard 5-field cron syntax (e.g., "0 9 * * 1-5").` }], isError: true };
          }

          if (!command && !tool) {
            return { content: [{ type: "text", text: "Either command or tool must be specified." }], isError: true };
          }

          const task: ScheduledTask = {
            name,
            cron,
            command,
            tool,
            toolArgs,
            description,
            createdAt: new Date().toISOString(),
          };

          tasks.push(task);
          saveTasks(tasks);

          return {
            content: [
              {
                type: "text",
                text: [
                  `✅ Task "${name}" added.`,
                  describeCron(cron),
                  description ? `Description: ${description}` : "",
                  `Type: ${command ? "shell command" : "MCP tool"}`,
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
          const tasks = loadTasks();
          const idx = tasks.findIndex((t) => t.name === name);

          if (idx === -1) {
            return { content: [{ type: "text", text: `Task "${name}" not found.` }], isError: true };
          }

          tasks.splice(idx, 1);
          saveTasks(tasks);

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

          const lines = tasks.map((t) => {
            const nextRun = describeCron(t.cron);
            const lastRun = t.lastRun ? `Last run: ${t.lastRun}` : "Never run";
            const type = t.command ? "Shell" : "MCP Tool";
            return [
              `📋 ${t.name}`,
              `   ${nextRun}`,
              `   ${lastRun}`,
              `   Type: ${type}`,
              t.description ? `   Description: ${t.description}` : "",
            ]
              .filter(Boolean)
              .join("\n");
          });

          return {
            content: [{ type: "text", text: [`${tasks.length} scheduled task(s):`, "", ...lines].join("\n") }],
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
          const tasks = loadTasks();
          const task = tasks.find((t) => t.name === name);

          if (!task) {
            return { content: [{ type: "text", text: `Task "${name}" not found.` }], isError: true };
          }

          logger.info(`Running task: ${name}`);

          let result: string;
          if (task.command) {
            const r = exec(task.command, { timeout: 300_000 });
            result = r.exitCode === 0 ? (r.stdout || "Completed.").slice(0, 2000) : `Failed: ${r.stderr}`;
          } else if (task.tool) {
            // For MCP tools, we just log what would be called (actual tool invocation
            // would require access to the server's tool registry at runtime)
            result = `MCP tool "${task.tool}" would be invoked with args: ${JSON.stringify(task.toolArgs ?? {})}`;
          } else {
            result = "No command or tool configured.";
          }

          // Update last run info
          task.lastRun = new Date().toISOString();
          task.lastResult = result.slice(0, 500);
          saveTasks(tasks);

          return {
            content: [{ type: "text", text: [`✅ Task "${name}" executed.`, "", result].join("\n") }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
