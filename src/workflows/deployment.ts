import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { DeployRunSchema, DeployRollbackSchema, DeployStatusSchema, DeployListSchema } from "../types.js";
import { exec } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { getDb } from "../utils/db.js";
import { existsSync } from "node:fs";

interface DeploymentRecord {
  id?: number;
  timestamp: string;
  environment: string;
  branch: string;
  version: string;
  status: "success" | "failed" | "rolled_back";
  output: string;
}

function generateVersion(): string {
  const now = new Date();
  return `v${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}.${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
}

export function getDeploymentTools(): ToolDefinition[] {
  return [
    {
      name: "deploy_run",
      description: "Run a deployment to a target environment",
      inputSchema: zToJsonSchema(DeployRunSchema),
      handler: async (args) => {
        try {
          const { environment, branch, script, vars } = DeployRunSchema.parse(args);
          logger.info(`Deploying to ${environment}`);

          const defaultBranch = process.env.GIT_DEFAULT_BRANCH ?? "main";
          const deployBranch = branch ?? defaultBranch;
          const deployScript = script ?? process.env.DEPLOY_SCRIPT ?? "./deploy.sh";
          const workDir = process.env.DEPLOY_WORK_DIR ?? process.cwd();

          if (!existsSync(deployScript) && !script) {
            return {
              content: [{ type: "text", text: `Deploy script not found: ${deployScript}. Set DEPLOY_SCRIPT in .env or provide a script path.` }],
              isError: true,
            };
          }

          // Build env vars
          const envVars = { ...vars };
          const envStr = Object.entries(envVars)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");

          const cmd = script
            ? `${envStr} ${deployScript} ${environment}`
            : `${envStr} bash ${deployScript} ${environment} ${deployBranch}`;

          const result = exec(cmd, { cwd: workDir, timeout: 300_000 });
          const version = generateVersion();

          const db = getDb();
          const record = {
            timestamp: new Date().toISOString(),
            environment,
            branch: deployBranch,
            version,
            status: result.exitCode === 0 ? "success" : "failed" as const,
            output: result.stdout || result.stderr,
          };

          db.prepare(
            "INSERT INTO deployments (timestamp, environment, branch, version, status, output) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(record.timestamp, record.environment, record.branch, record.version, record.status, record.output);

          if (result.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `❌ Deployment to ${environment} failed.\n${result.stderr}` }],
              isError: true,
            };
          }

          return {
            content: [{ type: "text", text: `✅ Deployment to "${environment}" succeeded. Version: ${version}\n${result.stdout}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "deploy_rollback",
      description: "Rollback a deployment to a previous version",
      inputSchema: zToJsonSchema(DeployRollbackSchema),
      handler: async (args) => {
        try {
          const { environment, version } = DeployRollbackSchema.parse(args);
          const db = getDb();
          logger.info(`Rolling back ${environment}`);

          // Get successful deployments for this environment
          const envDeploys = db.prepare(
            "SELECT * FROM deployments WHERE environment = ? AND status = 'success' ORDER BY id DESC"
          ).all(environment) as DeploymentRecord[];

          if (envDeploys.length === 0) {
            return { content: [{ type: "text", text: `No successful deployments found for "${environment}".` }], isError: true };
          }

          // Find the target version or the previous one
          let targetVersion = version;
          if (!targetVersion) {
            const current = envDeploys[0];
            const previous = envDeploys.length >= 2 ? envDeploys[1] : null;
            if (!previous) {
              return { content: [{ type: "text", text: `No previous deployment to rollback to for "${environment}".` }], isError: true };
            }
            targetVersion = previous.version;
          }

          // Mark current as rolled_back
          if (!version) {
            db.prepare(
              "UPDATE deployments SET status = 'rolled_back' WHERE id = ?"
            ).run(envDeploys[0].id);
          }

          return {
            content: [{ type: "text", text: `✅ Rolled back "${environment}" to version ${targetVersion}. Run deploy_run to redeploy that version.` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "deploy_status",
      description: "Check the status of the latest deployment for an environment",
      inputSchema: zToJsonSchema(DeployStatusSchema),
      handler: async (args) => {
        try {
          const { environment } = DeployStatusSchema.parse(args);
          const db = getDb();

          const row = db.prepare(
            "SELECT * FROM deployments WHERE environment = ? ORDER BY id DESC LIMIT 1"
          ).get(environment) as DeploymentRecord | undefined;

          if (!row) {
            return { content: [{ type: "text", text: `No deployments found for "${environment}".` }] };
          }

          return {
            content: [
              {
                type: "text",
                text: [
                  `Environment: ${environment}`,
                  `Latest Version: ${row.version}`,
                  `Status: ${row.status}`,
                  `Timestamp: ${row.timestamp}`,
                  `Branch: ${row.branch}`,
                  row.output ? `\nOutput:\n${row.output.slice(0, 2000)}` : "",
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
      name: "deploy_list",
      description: "List deployment history",
      inputSchema: zToJsonSchema(DeployListSchema),
      handler: async (args) => {
        try {
          const { environment, limit } = DeployListSchema.parse(args);
          const db = getDb();
          const maxResults = limit ?? 10;

          let rows: DeploymentRecord[];
          if (environment) {
            rows = db.prepare(
              "SELECT * FROM deployments WHERE environment = ? ORDER BY id DESC LIMIT ?"
            ).all(environment, maxResults) as DeploymentRecord[];
          } else {
            rows = db.prepare(
              "SELECT * FROM deployments ORDER BY id DESC LIMIT ?"
            ).all(maxResults) as DeploymentRecord[];
          }

          if (rows.length === 0) {
            return { content: [{ type: "text", text: "No deployments found." }] };
          }

          const lines = rows.map(
            (d) => `[${d.timestamp}] ${d.environment} → ${d.version} (${d.branch}) [${d.status}]`
          );

          return {
            content: [{ type: "text", text: lines.join("\n") }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
