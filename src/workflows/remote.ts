import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { execSafe } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

// ============================================================
// Schemas
// ============================================================

const RemoteExecSchema = z.object({
  host: z.string().describe("Remote host (hostname or IP)"),
  command: z.string().describe("Command to execute"),
  port: z.number().optional().describe("SSH port (default: 22)"),
  username: z.string().optional().describe("SSH username (default: current user)"),
  keyPath: z.string().optional().describe("Path to SSH private key"),
  timeout: z.number().optional().describe("Command timeout in seconds (default: 60)"),
});

const RemoteCopySchema = z.object({
  host: z.string().describe("Remote host (hostname or IP)"),
  source: z.string().describe("Source file path (local for upload, remote for download)"),
  destination: z.string().describe("Destination file path (remote for upload, local for download)"),
  direction: z.enum(["upload", "download"]).describe("Transfer direction"),
  port: z.number().optional().describe("SSH port (default: 22)"),
  username: z.string().optional().describe("SSH username (default: current user)"),
  keyPath: z.string().optional().describe("Path to SSH private key"),
});

const RemoteScriptSchema = z.object({
  host: z.string().describe("Remote host (hostname or IP)"),
  scriptPath: z.string().describe("Path to local script file"),
  args: z.string().optional().describe("Arguments to pass to the script"),
  port: z.number().optional().describe("SSH port (default: 22)"),
  username: z.string().optional().describe("SSH username (default: current user)"),
  keyPath: z.string().optional().describe("Path to SSH private key"),
  timeout: z.number().optional().describe("Script timeout in seconds (default: 120)"),
});

const RemoteTunnelSchema = z.object({
  host: z.string().describe("Remote host (hostname or IP)"),
  localPort: z.number().describe("Local port for the tunnel"),
  remoteHost: z.string().describe("Remote bind host"),
  remotePort: z.number().describe("Remote bind port"),
  port: z.number().optional().describe("SSH port (default: 22)"),
  username: z.string().optional().describe("SSH username (default: current user)"),
  keyPath: z.string().optional().describe("Path to SSH private key"),
  background: z.boolean().optional().describe("Run tunnel in background (default: true)"),
});

// ============================================================
// Helpers
// ============================================================

function buildSshArgs(host: string, port?: number, username?: string, keyPath?: string): string[] {
  const args: string[] = [];
  if (port && port !== 22) args.push("-p", String(port));
  if (keyPath) args.push("-i", keyPath);
  args.push("-o", "StrictHostKeyChecking=accept-new");
  args.push("-o", "ConnectTimeout=10");
  const user = username ?? process.env.USER;
  args.push("-T", `${user}@${host}`);
  return args;
}

// ============================================================
// Tool factory
// ============================================================

export function getRemoteTools(): ToolDefinition[] {
  return [
    {
      name: "remote_exec",
      description: "Execute a command on a remote host via SSH",
      inputSchema: zToJsonSchema(RemoteExecSchema),
      handler: async (args) => {
        try {
          const { host, command, port, username, keyPath, timeout } = RemoteExecSchema.parse(args);
          const t = (timeout ?? 60) * 1000;

          const sshArgs = buildSshArgs(host, port, username, keyPath);
          sshArgs.push(command);

          logger.info(`Remote exec: ${host} — ${command.slice(0, 100)}`);
          const result = execSafe("ssh", sshArgs, { timeout: t });

          if (result.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `❌ Remote command failed on ${host} (exit: ${result.exitCode}).\n${result.stderr.slice(0, 2000)}` }],
              isError: true,
            };
          }

          return {
            content: [{ type: "text", text: `✅ ${host} — Exit: ${result.exitCode}\n\n${result.stdout.slice(0, 5000)}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "remote_copy",
      description: "Copy files to/from a remote host via SCP",
      inputSchema: zToJsonSchema(RemoteCopySchema),
      handler: async (args) => {
        try {
          const { host, source, destination, direction, port, username, keyPath } = RemoteCopySchema.parse(args);

          const user = username ?? process.env.USER;
          const scpArgs: string[] = [];
          if (port && port !== 22) scpArgs.push("-P", String(port));
          if (keyPath) scpArgs.push("-i", keyPath);
          scpArgs.push("-o", "StrictHostKeyChecking=accept-new", "-r");

          if (direction === "upload") {
            if (!existsSync(source)) {
              return { content: [{ type: "text", text: `❌ Local file not found: ${source}` }], isError: true };
            }
            scpArgs.push(source, `${user}@${host}:${destination}`);
          } else {
            scpArgs.push(`${user}@${host}:${source}`, destination);
          }

          logger.info(`Remote copy: ${direction} ${source} → ${host}:${destination}`);
          const result = execSafe("scp", scpArgs, { timeout: 120_000 });

          if (result.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `❌ Copy failed.\n${result.stderr.slice(0, 2000)}` }],
              isError: true,
            };
          }

          return { content: [{ type: "text", text: `✅ Copied ${source} → ${host}:${destination}` }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "remote_script",
      description: "Upload and execute a local script on a remote host",
      inputSchema: zToJsonSchema(RemoteScriptSchema),
      handler: async (args) => {
        try {
          const { host, scriptPath, args: scriptArgs, port, username, keyPath, timeout } = RemoteScriptSchema.parse(args);
          const t = (timeout ?? 120) * 1000;

          if (!existsSync(scriptPath)) {
            return { content: [{ type: "text", text: `❌ Script not found: ${scriptPath}` }], isError: true };
          }

          const user = username ?? process.env.USER;
          const remotePath = `/tmp/remote_script_${randomUUID().slice(0, 8)}.sh`;
          const scpArgs: string[] = [];
          if (port && port !== 22) scpArgs.push("-P", String(port));
          if (keyPath) scpArgs.push("-i", keyPath);
          scpArgs.push("-o", "StrictHostKeyChecking=accept-new", scriptPath, `${user}@${host}:${remotePath}`);

          // Upload script
          logger.info(`Uploading script to ${host}:${remotePath}`);
          const uploadResult = execSafe("scp", scpArgs, { timeout: 30_000 });

          if (uploadResult.exitCode !== 0) {
            return { content: [{ type: "text", text: `❌ Script upload failed.\n${uploadResult.stderr}` }], isError: true };
          }

          // Execute remote script
          const sshArgs = buildSshArgs(host, port, username, keyPath);
          const remoteCmd = `chmod +x '${remotePath}' && '${remotePath}' ${scriptArgs ?? ""}`;
          sshArgs.push(remoteCmd);
          logger.info(`Remote script: ${host} — ${scriptPath}`);

          const result = execSafe("ssh", sshArgs, { timeout: t });

          // Cleanup
          const cleanupArgs = buildSshArgs(host, port, username, keyPath);
          cleanupArgs.push(`rm -f '${remotePath}'`);
          execSafe("ssh", cleanupArgs, { timeout: 10_000 });

          if (result.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `❌ Script failed on ${host} (exit: ${result.exitCode}).\n${result.stderr.slice(0, 2000)}` }],
              isError: true,
            };
          }

          return {
            content: [{ type: "text", text: `✅ Script executed on ${host} (exit: ${result.exitCode})\n\n${result.stdout.slice(0, 5000)}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "remote_tunnel",
      description: "Create an SSH tunnel (local port forwarding)",
      inputSchema: zToJsonSchema(RemoteTunnelSchema),
      handler: async (args) => {
        try {
          const { host, localPort, remoteHost, remotePort, port, username, keyPath, background } = RemoteTunnelSchema.parse(args);
          const bg = background ?? true;

          const user = username ?? process.env.USER;
          const tunnelArgs: string[] = [];
          if (port && port !== 22) tunnelArgs.push("-p", String(port));
          if (keyPath) tunnelArgs.push("-i", keyPath);
          tunnelArgs.push("-o", "StrictHostKeyChecking=accept-new");
          tunnelArgs.push("-o", "ExitOnForwardFailure=yes");
          if (bg) tunnelArgs.push("-f");
          tunnelArgs.push("-L", `${localPort}:${remoteHost}:${remotePort}`);
          tunnelArgs.push("-N", `${user}@${host}`);

          logger.info(`SSH tunnel: localhost:${localPort} → ${host}:${remotePort}`);
          const result = execSafe("ssh", tunnelArgs, { timeout: bg ? 15_000 : 300_000 });

          if (result.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `❌ Tunnel setup failed.\n${result.stderr.slice(0, 1000)}` }],
              isError: true,
            };
          }

          return {
            content: [{ type: "text", text: `✅ SSH tunnel established: localhost:${localPort} → ${host}:${remotePort} → ${remoteHost}:${remotePort}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
