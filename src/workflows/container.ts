import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { exec, commandExists } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// Docker Build Schema
// ============================================================
const DockerBuildSchema = z.object({
  directory: z.string().describe("Project directory with Dockerfile"),
  tag: z.string().describe("Image tag (e.g. myapp:latest)"),
  dockerfile: z.string().optional().describe("Dockerfile path relative to directory (default: Dockerfile)"),
  buildArgs: z.record(z.string()).optional().describe("Build arguments (e.g. NODE_VERSION=18)"),
  noCache: z.boolean().optional().describe("Disable layer caching"),
});

// ============================================================
// Docker Push Schema
// ============================================================
const DockerPushSchema = z.object({
  tag: z.string().describe("Image tag to push (e.g. myapp:latest or registry.example.com/myapp:latest)"),
  registry: z.string().optional().describe("Registry URL for login (if not logged in)"),
  username: z.string().optional().describe("Registry username"),
  password: z.string().optional().describe("Registry password / token"),
});

// ============================================================
// Docker Compose Up Schema
// ============================================================
const DockerComposeUpSchema = z.object({
  directory: z.string().describe("Project directory with docker-compose.yml"),
  services: z.array(z.string()).optional().describe("Specific services to start (default: all)"),
  detach: z.boolean().optional().describe("Run in detached mode (default: true)"),
  envFile: z.string().optional().describe("Environment file path"),
  build: z.boolean().optional().describe("Build images before starting"),
});

// ============================================================
// Docker Compose Down Schema
// ============================================================
const DockerComposeDownSchema = z.object({
  directory: z.string().describe("Project directory with docker-compose.yml"),
  removeVolumes: z.boolean().optional().describe("Remove named volumes"),
  removeImages: z.boolean().optional().describe("Remove images used by services"),
});

// ============================================================
// Tool factory
// ============================================================

export function getContainerTools(): ToolDefinition[] {
  return [
    {
      name: "docker_build",
      description: "Build a Docker image from a Dockerfile",
      inputSchema: zToJsonSchema(DockerBuildSchema),
      handler: async (args) => {
        try {
          if (!commandExists("docker")) {
            return { content: [{ type: "text", text: "❌ Docker is not installed or not in PATH." }], isError: true };
          }

          const { directory, tag, dockerfile, buildArgs, noCache } = DockerBuildSchema.parse(args);

          if (!existsSync(directory)) {
            return { content: [{ type: "text", text: `❌ Directory not found: ${directory}` }], isError: true };
          }

          let cmd = "docker build";

          if (dockerfile) {
            const dfPath = join(directory, dockerfile);
            if (!existsSync(dfPath)) {
              return { content: [{ type: "text", text: `❌ Dockerfile not found: ${dfPath}` }], isError: true };
            }
            cmd += ` -f '${dockerfile}'`;
          }

          if (noCache) cmd += " --no-cache";

          if (buildArgs) {
            for (const [k, v] of Object.entries(buildArgs)) {
              cmd += ` --build-arg '${k}=${v}'`;
            }
          }

          cmd += ` -t '${tag}' '${directory}'`;

          logger.info(`Building Docker image: ${tag}`);
          const result = exec(cmd, { timeout: 600_000 });

          if (result.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `❌ Build failed.\n${result.stderr}` }],
              isError: true,
            };
          }

          return {
            content: [{ type: "text", text: `✅ Docker image built successfully: ${tag}\n${result.stdout}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "docker_push",
      description: "Push a Docker image to a registry",
      inputSchema: zToJsonSchema(DockerPushSchema),
      handler: async (args) => {
        try {
          if (!commandExists("docker")) {
            return { content: [{ type: "text", text: "❌ Docker is not installed or not in PATH." }], isError: true };
          }

          const { tag, registry, username, password } = DockerPushSchema.parse(args);

          // Login if credentials provided
          if (registry && username && password) {
            logger.info(`Logging into ${registry}`);
            const loginResult = exec(`echo '${password}' | docker login '${registry}' -u '${username}' --password-stdin`, { timeout: 30_000 });
            if (loginResult.exitCode !== 0) {
              return { content: [{ type: "text", text: `❌ Registry login failed: ${loginResult.stderr}` }], isError: true };
            }
          }

          logger.info(`Pushing image: ${tag}`);
          const result = exec(`docker push '${tag}'`, { timeout: 600_000 });

          if (result.exitCode !== 0) {
            return { content: [{ type: "text", text: `❌ Push failed.\n${result.stderr}` }], isError: true };
          }

          return {
            content: [{ type: "text", text: `✅ Docker image pushed successfully: ${tag}\n${result.stdout}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "docker_compose_up",
      description: "Start services defined in docker-compose.yml",
      inputSchema: zToJsonSchema(DockerComposeUpSchema),
      handler: async (args) => {
        try {
          if (!commandExists("docker")) {
            return { content: [{ type: "text", text: "❌ Docker is not installed or not in PATH." }], isError: true };
          }

          const { directory, services, detach, envFile, build } = DockerComposeUpSchema.parse(args);

          if (!existsSync(directory)) {
            return { content: [{ type: "text", text: `❌ Directory not found: ${directory}` }], isError: true };
          }

          let cmd = `docker compose -f '${join(directory, "docker-compose.yml")}'`;

          if (envFile) {
            cmd += ` --env-file '${envFile}'`;
          }

          cmd += " up";
          if (detach !== false) cmd += " -d";
          if (build) cmd += " --build";
          if (services && services.length > 0) cmd += ` ${services.join(" ")}`;

          logger.info(`Starting Docker Compose services in ${directory}`);
          const result = exec(cmd, { timeout: 300_000 });

          if (result.exitCode !== 0) {
            return { content: [{ type: "text", text: `❌ Compose up failed.\n${result.stderr}` }], isError: true };
          }

          return {
            content: [{ type: "text", text: `✅ Docker Compose services started.\n${result.stdout}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "docker_compose_down",
      description: "Stop and remove Docker Compose services",
      inputSchema: zToJsonSchema(DockerComposeDownSchema),
      handler: async (args) => {
        try {
          if (!commandExists("docker")) {
            return { content: [{ type: "text", text: "❌ Docker is not installed or not in PATH." }], isError: true };
          }

          const { directory, removeVolumes, removeImages } = DockerComposeDownSchema.parse(args);

          if (!existsSync(directory)) {
            return { content: [{ type: "text", text: `❌ Directory not found: ${directory}` }], isError: true };
          }

          let cmd = `docker compose -f '${join(directory, "docker-compose.yml")}' down`;

          if (removeVolumes) cmd += " -v";
          if (removeImages) cmd += " --rmi all";

          logger.info(`Stopping Docker Compose services in ${directory}`);
          const result = exec(cmd, { timeout: 120_000 });

          if (result.exitCode !== 0) {
            return { content: [{ type: "text", text: `❌ Compose down failed.\n${result.stderr}` }], isError: true };
          }

          return {
            content: [{ type: "text", text: `✅ Docker Compose services stopped.\n${result.stdout}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
