import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { DeployRunSchema, DeployRollbackSchema, DeployStatusSchema, DeployListSchema } from "../types.js";
import { exec } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface DeploymentRecord {
  timestamp: string;
  environment: string;
  branch: string;
  version: string;
  status: "success" | "failed" | "rolled_back";
  output: string;
}

const DATA_DIR = join(process.env.HOME || process.cwd(), ".workflow-mcp");
const DEPLOYS_FILE = join(DATA_DIR, "deployments.json");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadDeployments(): DeploymentRecord[] {
  ensureDataDir();
  if (!existsSync(DEPLOYS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(DEPLOYS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveDeployments(deploys: DeploymentRecord[]): void {
  ensureDataDir();
  writeFileSync(DEPLOYS_FILE, JSON.stringify(deploys, null, 2), "utf-8");
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
            : `bash ${deployScript} ${environment} ${deployBranch}`;

          const result = exec(cmd, { cwd: workDir, timeout: 300_000 });
          const version = generateVersion();

          const record: DeploymentRecord = {
            timestamp: new Date().toISOString(),
            environment,
            branch: deployBranch,
            version,
            status: result.exitCode === 0 ? "success" : "failed",
            output: result.stdout || result.stderr,
          };

          const deploys = loadDeployments();
          deploys.push(record);
          saveDeployments(deploys);

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
          logger.info(`Rolling back ${environment}`);

          const deploys = loadDeployments();
          const envDeploys = deploys.filter((d) => d.environment === environment && d.status === "success");

          if (envDeploys.length === 0) {
            return { content: [{ type: "text", text: `No successful deployments found for "${environment}".` }], isError: true };
          }

          // Find the target version or the previous one
          let targetVersion = version;
          if (!targetVersion) {
            const current = envDeploys[envDeploys.length - 1];
            const previous = envDeploys.length >= 2 ? envDeploys[envDeploys.length - 2] : null;
            if (!previous) {
              return { content: [{ type: "text", text: `No previous deployment to rollback to for "${environment}".` }], isError: true };
            }
            targetVersion = previous.version;
          }

          // Mark current as rolled_back
          if (!version) {
            const current = envDeploys[envDeploys.length - 1];
            current.status = "rolled_back";
            saveDeployments(deploys);
          }

          return {
            content: [{ type: "text", text: `✅ Rolled back "${environment}" to version ${targetVersion}. Run your deploy script to redeploy that version.` }],
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
          const deploys = loadDeployments();
          const envDeploys = deploys.filter((d) => d.environment === environment);

          if (envDeploys.length === 0) {
            return { content: [{ type: "text", text: `No deployments found for "${environment}".` }] };
          }

          const latest = envDeploys[envDeploys.length - 1];
          return {
            content: [
              {
                type: "text",
                text: [
                  `Environment: ${environment}`,
                  `Latest Version: ${latest.version}`,
                  `Status: ${latest.status}`,
                  `Timestamp: ${latest.timestamp}`,
                  `Branch: ${latest.branch}`,
                  latest.output ? `\nOutput:\n${latest.output.slice(0, 2000)}` : "",
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
          let deploys = loadDeployments();

          if (environment) {
            deploys = deploys.filter((d) => d.environment === environment);
          }

          deploys.reverse();
          const maxResults = limit ?? 10;
          const sliced = deploys.slice(0, maxResults);

          if (sliced.length === 0) {
            return { content: [{ type: "text", text: "No deployments found." }] };
          }

          const lines = sliced.map(
            (d) =>
              `[${d.timestamp}] ${d.environment} → ${d.version} (${d.branch}) [${d.status}]`
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
