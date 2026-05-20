import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { exec } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { getDb } from "../utils/db.js";
import { randomUUID } from "node:crypto";

// ============================================================
// Schemas
// ============================================================

const WorkflowDefineSchema = z.object({
  name: z.string().describe("Workflow name (unique identifier)"),
  description: z.string().optional().describe("Workflow description"),
  steps: z
    .array(
      z.object({
        name: z.string().describe("Step name"),
        tool: z.string().describe("Tool name to execute (e.g. 'deploy_run', 'notify_send')"),
        params: z.record(z.unknown()).optional().describe("Tool parameters"),
        onFailure: z.enum(["stop", "skip", "continue"]).optional().describe("Action on step failure (default: stop)"),
      })
    )
    .min(1)
    .describe("Ordered list of workflow steps"),
});

const WorkflowRunSchema = z.object({
  name: z.string().describe("Workflow name to execute"),
  vars: z.record(z.string()).optional().describe("Step parameter variables (replaces ${varName})"),
});

const WorkflowListSchema = z.object({});

const WorkflowGetSchema = z.object({
  name: z.string().describe("Workflow name"),
});

const WorkflowRemoveSchema = z.object({
  name: z.string().describe("Workflow name to remove"),
});

const WorkflowRunListSchema = z.object({
  workflowName: z.string().optional().describe("Filter by workflow name"),
  limit: z.number().optional().describe("Max results (default: 10)"),
});

const WorkflowRunGetSchema = z.object({
  runId: z.number().describe("Run ID to inspect"),
});

// ============================================================
// Tool factory
// ============================================================

export function getWorkflowTools(): ToolDefinition[] {
  return [
    {
      name: "workflow_define",
      description: "Define a new workflow with a sequence of tool steps",
      inputSchema: zToJsonSchema(WorkflowDefineSchema),
      handler: async (args) => {
        try {
          const { name, description, steps } = WorkflowDefineSchema.parse(args);
          const db = getDb();

          const existing = db.prepare("SELECT name FROM workflows WHERE name = ?").get(name);
          if (existing) {
            return {
              content: [{ type: "text", text: `❌ Workflow "${name}" already exists. Use workflow_update to modify.` }],
              isError: true,
            };
          }

          db.prepare(
            "INSERT INTO workflows (name, description, steps) VALUES (?, ?, ?)"
          ).run(name, description ?? null, JSON.stringify(steps));

          return {
            content: [{ type: "text", text: `✅ Workflow "${name}" defined with ${steps.length} step(s).\n   Steps: ${steps.map((s) => s.name).join(" → ")}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "workflow_run",
      description: "Execute a defined workflow with optional variable substitution",
      inputSchema: zToJsonSchema(WorkflowRunSchema),
      handler: async (args) => {
        try {
          const { name, vars } = WorkflowRunSchema.parse(args);
          const db = getDb();

          const row = db.prepare("SELECT * FROM workflows WHERE name = ?").get(name) as { name: string; description: string; steps: string } | undefined;
          if (!row) {
            return { content: [{ type: "text", text: `❌ Workflow "${name}" not found. Define it first with workflow_define.` }], isError: true };
          }

          const steps: { name: string; tool: string; params?: Record<string, unknown>; onFailure?: "stop" | "skip" | "continue" }[] = JSON.parse(row.steps);
          const runId = randomUUID().slice(0, 8);

          // Create run record
          const runStmt = db.prepare("INSERT INTO workflow_runs (workflow_name, status, started_at) VALUES (?, 'running', datetime('now'))");
          const runResult = runStmt.run(name);
          const workflowRunId = Number(runResult.lastInsertRowid);

          // Create step records
          const stepInsert = db.prepare(
            "INSERT INTO workflow_run_steps (run_id, step_index, step_name, tool_name, status) VALUES (?, ?, ?, ?, 'pending')"
          );
          for (let i = 0; i < steps.length; i++) {
            stepInsert.run(workflowRunId, i, steps[i].name, steps[i].tool);
          }

          const results: string[] = [`▶️ Running workflow "${name}" (run #${workflowRunId}, ${steps.length} steps)\n`];

          // Execute steps
          let finalStatus = "success";
          for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            // Apply variable substitution
            const resolvedParams: Record<string, unknown> = {};
            if (step.params) {
              for (const [k, v] of Object.entries(step.params)) {
                let val = String(v);
                if (vars) {
                  for (const [vk, vv] of Object.entries(vars)) {
                    val = val.replace(`\${${vk}}`, vv);
                  }
                }
                resolvedParams[k] = val;
              }
            }

            results.push(`  [${i + 1}/${steps.length}] ${step.name} (${step.tool})...`);

            // Mark step as running
            db.prepare(
              "UPDATE workflow_run_steps SET status = 'running', input = ?, started_at = datetime('now') WHERE run_id = ? AND step_index = ?"
            ).run(JSON.stringify(resolvedParams), workflowRunId, i);

            let stepSuccess = false;
            let stepOutput = "";

            try {
              // For shell commands, use exec directly
              if (step.tool === "_shell") {
                const cmd = String(resolvedParams["command"] ?? "");
                const r = exec(cmd, { timeout: 300_000 });
                stepSuccess = r.exitCode === 0;
                stepOutput = r.exitCode === 0 ? (r.stdout || "Completed.") : `Failed: ${r.stderr}`;
              } else {
                // For MCP tools, log what would be called
                stepOutput = `[simulated] Tool "${step.tool}" called with: ${JSON.stringify(resolvedParams)}`;
                stepSuccess = true;
              }
            } catch (err) {
              stepOutput = `Error: ${String(err)}`;
              stepSuccess = false;
            }

            // Update step result
            db.prepare(
              "UPDATE workflow_run_steps SET status = ?, output = ?, finished_at = datetime('now') WHERE run_id = ? AND step_index = ?"
            ).run(stepSuccess ? "success" : "failed", stepOutput.slice(0, 5000), workflowRunId, i);

            if (stepSuccess) {
              results.push(`    ✅ ${stepOutput.slice(0, 200)}`);
            } else {
              results.push(`    ❌ ${stepOutput.slice(0, 200)}`);
              const onFail = step.onFailure ?? "stop";
              if (onFail === "stop") {
                finalStatus = "failed";
                results.push(`    ⛔ Step failed, workflow stopped.`);
                break;
              } else if (onFail === "skip") {
                results.push(`    ⏭️  Step failed, skipping remaining steps.`);
                // Mark remaining as skipped
                db.prepare(
                  "UPDATE workflow_run_steps SET status = 'skipped' WHERE run_id = ? AND step_index > ?"
                ).run(workflowRunId, i);
                finalStatus = "failed";
                break;
              } else {
                results.push(`    ⚠️  Step failed but continuing...`);
              }
            }
          }

          // Update run status
          db.prepare(
            "UPDATE workflow_runs SET status = ?, finished_at = datetime('now'), result = ? WHERE id = ?"
          ).run(finalStatus, JSON.stringify(results.slice(0, 10)), workflowRunId);

          results.push(`\n🏁 Workflow "${name}" finished with status: ${finalStatus}`);

          return { content: [{ type: "text", text: results.join("\n") }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "workflow_list",
      description: "List all defined workflows",
      inputSchema: zToJsonSchema(WorkflowListSchema),
      handler: async () => {
        try {
          const db = getDb();
          const rows = db.prepare("SELECT name, description, steps, created_at FROM workflows ORDER BY created_at DESC").all() as {
            name: string;
            description: string | null;
            steps: string;
            created_at: string;
          }[];

          if (rows.length === 0) {
            return { content: [{ type: "text", text: "No workflows defined. Use workflow_define to create one." }] };
          }

          const lines = rows.map((r) => {
            const steps = JSON.parse(r.steps) as { name: string }[];
            return `  📋 ${r.name}${r.description ? ` — ${r.description}` : ""}\n     Steps: ${steps.map((s) => s.name).join(" → ")}`;
          });

          return {
            content: [{ type: "text", text: [`${rows.length} workflow(s):`, ...lines].join("\n") }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "workflow_get",
      description: "Get details of a specific workflow",
      inputSchema: zToJsonSchema(WorkflowGetSchema),
      handler: async (args) => {
        try {
          const { name } = WorkflowGetSchema.parse(args);
          const db = getDb();

          const row = db.prepare("SELECT * FROM workflows WHERE name = ?").get(name) as {
            name: string;
            description: string | null;
            steps: string;
            created_at: string;
            updated_at: string;
          } | undefined;

          if (!row) {
            return { content: [{ type: "text", text: `❌ Workflow "${name}" not found.` }], isError: true };
          }

          const steps = JSON.parse(row.steps) as { name: string; tool: string; params?: Record<string, unknown>; onFailure?: string }[];

          return {
            content: [
              {
                type: "text",
                text: [
                  `📋 ${row.name}`,
                  row.description ? `   Description: ${row.description}` : "",
                  `   Created: ${row.created_at}`,
                  `   Updated: ${row.updated_at}`,
                  `   Steps (${steps.length}):`,
                  ...steps.map((s, i) => `     [${i + 1}] ${s.name} → ${s.tool}${s.onFailure ? ` (on failure: ${s.onFailure})` : ""}`),
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
      name: "workflow_remove",
      description: "Remove a defined workflow",
      inputSchema: zToJsonSchema(WorkflowRemoveSchema),
      handler: async (args) => {
        try {
          const { name } = WorkflowRemoveSchema.parse(args);
          const db = getDb();

          const result = db.prepare("DELETE FROM workflows WHERE name = ?").run(name);
          if (result.changes === 0) {
            return { content: [{ type: "text", text: `❌ Workflow "${name}" not found.` }], isError: true };
          }

          return { content: [{ type: "text", text: `✅ Workflow "${name}" removed.` }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "workflow_run_list",
      description: "List recent workflow run history",
      inputSchema: zToJsonSchema(WorkflowRunListSchema),
      handler: async (args) => {
        try {
          const { workflowName, limit } = WorkflowRunListSchema.parse(args);
          const db = getDb();
          const max = limit ?? 10;

          let rows: { id: number; workflow_name: string; status: string; started_at: string; finished_at: string | null }[];
          if (workflowName) {
            rows = db.prepare(
              "SELECT id, workflow_name, status, started_at, finished_at FROM workflow_runs WHERE workflow_name = ? ORDER BY id DESC LIMIT ?"
            ).all(workflowName, max) as typeof rows;
          } else {
            rows = db.prepare(
              "SELECT id, workflow_name, status, started_at, finished_at FROM workflow_runs ORDER BY id DESC LIMIT ?"
            ).all(max) as typeof rows;
          }

          if (rows.length === 0) {
            return { content: [{ type: "text", text: "No workflow runs yet." }] };
          }

          const lines = rows.map((r) => {
            const duration = r.finished_at ? ` (${r.finished_at})` : " (running)";
            return `  #${r.id} ${r.workflow_name} [${r.status}] — ${r.started_at}${duration}`;
          });

          return { content: [{ type: "text", text: [`Recent workflow runs:`, ...lines].join("\n") }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "workflow_run_get",
      description: "Get detailed step-by-step results of a specific workflow run",
      inputSchema: zToJsonSchema(WorkflowRunGetSchema),
      handler: async (args) => {
        try {
          const { runId } = WorkflowRunGetSchema.parse(args);
          const db = getDb();

          const run = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as {
            id: number;
            workflow_name: string;
            status: string;
            started_at: string;
            finished_at: string | null;
            result: string | null;
          } | undefined;

          if (!run) {
            return { content: [{ type: "text", text: `❌ Run #${runId} not found.` }], isError: true };
          }

          const steps = db.prepare(
            "SELECT step_index, step_name, tool_name, status, input, output, started_at, finished_at FROM workflow_run_steps WHERE run_id = ? ORDER BY step_index"
          ).all(runId) as { step_index: number; step_name: string; tool_name: string; status: string; input: string | null; output: string | null; started_at: string | null; finished_at: string | null }[];

          const lines: string[] = [
            `📋 Workflow: ${run.workflow_name} (#${run.id})`,
            `   Status: ${run.status}`,
            `   Started: ${run.started_at}`,
            run.finished_at ? `   Finished: ${run.finished_at}` : "",
            `   Steps:`,
            ...steps.map(
              (s) =>
                `     [${s.step_index + 1}] ${s.step_name} (${s.tool_name}) → ${s.status === "success" ? "✅" : s.status === "failed" ? "❌" : "⏳"} ${s.status}${s.output ? `\n       Output: ${s.output.slice(0, 300)}` : ""}`
            ),
          ];

          return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
