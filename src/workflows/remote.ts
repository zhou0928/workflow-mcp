import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { exec } from "../utils/exec.js";
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

function buildSshBase(host: string, port?: number, username?: string, keyPath?: string): string {
  const parts: string[] = ["ssh"];
  if (port && port !== 22) parts.push(`-p ${port}`);
  if (keyPath) parts.push(`-i '${keyPath}'`);
  parts.push("-o StrictHostKeyChecking=accept-new");
  parts.push("-o ConnectTimeout=10");
  const user = username ?? process.env.USER;
  parts.push(`-T ${user}@${host}`);
  return parts.join(" ");
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

          const sshBase = buildSshBase(host, port, username, keyPath);
          const cmd = `${sshBase} ${JSON.stringify(command)}`;

          logger.info(`Remote exec: ${host} — ${command.slice(0, 100)}`);
          const result = exec(cmd, { timeout: t });

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
          const portFlag = port && port !== 22 ? `-P ${port}` : "";
          const keyFlag = keyPath ? `-i '${keyPath}'` : "";

          let cmd: string;
          if (direction === "upload") {
            if (!existsSync(source)) {
              return { content: [{ type: "text", text: `❌ Local file not found: ${source}` }], isError: true };
            }
            cmd = `scp ${portFlag} ${keyFlag} -o StrictHostKeyChecking=accept-new -r '${source}' ${user}@${host}:'${destination}'`;
          } else {
            cmd = `scp ${portFlag} ${keyFlag} -o StrictHostKeyChecking=accept-new -r ${user}@${host}:'${source}' '${destination}'`;
          }

          logger.info(`Remote copy: ${direction} ${source} → ${host}:${destination}`);
          const result = exec(cmd, { timeout: 120_000 });

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
          const portFlag = port && port !== 22 ? `-P ${port}` : "";
          const keyFlag = keyPath ? `-i '${keyPath}'` : "";
          const sshOpts = "-o StrictHostKeyChecking=accept-new";

          // Upload script
          const uploadCmd = `scp ${portFlag} ${keyFlag} ${sshOpts} '${scriptPath}' ${user}@${host}:'${remotePath}'`;
          const uploadResult = exec(uploadCmd, { timeout: 30_000 });

          if (uploadResult.exitCode !== 0) {
            return { content: [{ type: "text", text: `❌ Script upload failed.\n${uploadResult.stderr}` }], isError: true };
          }

          // Execute remote script
          const sshBase = buildSshBase(host, port, username, keyPath);
          const execCmd = `${sshBase} "chmod +x '${remotePath}' && '${remotePath}' ${scriptArgs ?? ""}"`;
          logger.info(`Remote script: ${host} — ${scriptPath}`);

          const result = exec(execCmd, { timeout: t });

          // Cleanup
          exec(`${sshBase} "rm -f '${remotePath}'"`, { timeout: 10_000 });

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
          const sshPort = port && port !== 22 ? `-p ${port}` : "";
          const keyFlag = keyPath ? `-i '${keyPath}'` : "";
          const bgFlag = bg ? "-f" : "";
          const sshOpts = "-o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes";

          const cmd = `ssh ${sshPort} ${keyFlag} ${sshOpts} ${bgFlag} -L ${localPort}:${remoteHost}:${remotePort} ${user}@${host} -N`;

          logger.info(`SSH tunnel: localhost:${localPort} → ${host}:${remotePort}`);
          const result = exec(cmd, { timeout: bg ? 15_000 : 300_000 });

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
