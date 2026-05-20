import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { exec } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { createServer, IncomingMessage, ServerResponse, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHmac, timingSafeEqual } from "node:crypto";

// ============================================================
// Schemas
// ============================================================

const WebhookListenSchema = z.object({
  port: z.number().optional().describe("Port to listen on (default: 8080)"),
  path: z.string().optional().describe("Webhook path (default: /webhook)"),
  timeout: z.number().optional().describe("Listen duration in seconds (default: 300, max: 3600)"),
  secret: z.string().optional().describe("HMAC-SHA256 secret for signature verification"),
});

const WebhookFireSchema = z.object({
  url: z.string().describe("Webhook target URL"),
  payload: z.record(z.unknown()).describe("JSON payload to send"),
  headers: z.record(z.string()).optional().describe("Custom headers to include"),
  secret: z.string().optional().describe("HMAC-SHA256 secret for signing the payload"),
  method: z.enum(["POST", "PUT", "PATCH"]).optional().describe("HTTP method (default: POST)"),
});

// ============================================================
// Tool factory
// ============================================================

export function getWebhookTools(): ToolDefinition[] {
  return [
    {
      name: "webhook_listen",
      description: "Start a temporary HTTP server to receive webhook requests",
      inputSchema: zToJsonSchema(WebhookListenSchema),
      handler: async (args) => {
        try {
          const { port, path, timeout, secret } = WebhookListenSchema.parse(args);
          const listenPort = port ?? 8080;
          const listenPath = path ?? "/webhook";
          const maxDuration = Math.min(timeout ?? 300, 3600) * 1000;
          const received: string[] = [];

          return new Promise((resolve) => {
            const server = createServer((req: IncomingMessage, res: ServerResponse) => {
              if (req.url !== listenPath || req.method !== "POST") {
                res.writeHead(404);
                res.end("Not found");
                return;
              }

              const chunks: Buffer[] = [];
              req.on("data", (chunk: Buffer) => chunks.push(chunk));
              req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf-8");

                // Verify signature if secret provided
                if (secret) {
                  const signature = req.headers["x-hub-signature-256"] as string;
                  if (signature) {
                    const hmac = createHmac("sha256", secret).update(body).digest("hex");
                    const expected = `sha256=${hmac}`;
                    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
                      res.writeHead(401);
                      res.end("Signature mismatch");
                      received.push(`[${new Date().toISOString()}] ❌ INVALID SIGNATURE`);
                      return;
                    }
                  }
                  // GitHub also sends x-hub-signature (SHA1)
                  const sig1 = req.headers["x-hub-signature"] as string;
                  if (sig1) {
                    const hmac1 = createHmac("sha1", secret).update(body).digest("hex");
                    const expected1 = `sha1=${hmac1}`;
                    if (!timingSafeEqual(Buffer.from(sig1), Buffer.from(expected1))) {
                      res.writeHead(401);
                      res.end("Signature mismatch");
                      received.push(`[${new Date().toISOString()}] ❌ INVALID SIGNATURE`);
                      return;
                    }
                  }
                }

                const event = req.headers["x-github-event"] ?? req.headers["x-event"] ?? "unknown";
                const summary = `[${new Date().toISOString()}] Event: ${event} | Body: ${body.slice(0, 1000)}`;
                received.push(summary);
                logger.info(`Webhook received: ${event}`);

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "ok", received: received.length }));
              });
            });

            server.listen(listenPort, () => {
              logger.info(`Webhook listener started on port ${listenPort}, path ${listenPath}`);
            });

            // Auto-stop after timeout
            const timer = setTimeout(() => {
              server.close();
              if (received.length === 0) {
                resolve({ content: [{ type: "text", text: `⏱️ Webhook listener on port ${listenPort} timed out after ${maxDuration / 1000}s with no requests.` }] });
              } else {
                resolve({
                  content: [
                    {
                      type: "text",
                      text: [
                        `⏱️ Webhook listener closed after ${maxDuration / 1000}s.`,
                        `Received ${received.length} request(s):`,
                        ...received.map((r) => `  ${r}`),
                      ].join("\n"),
                    },
                  ],
                });
              }
            }, maxDuration);

            // Allow early stop via a special request
            server.on("request", (req, res) => {
              if (req.url === `${listenPath}/stop` && req.method === "POST") {
                clearTimeout(timer);
                server.close();
                res.end(JSON.stringify({ status: "stopped" }));
                resolve({
                  content: [{ type: "text", text: `⏹️ Webhook listener on port ${listenPort} stopped manually after ${received.length} request(s).\n${received.map((r) => `  ${r}`).join("\n")}` }],
                });
              }
            });
          });
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "webhook_fire",
      description: "Send a webhook request to an external endpoint",
      inputSchema: zToJsonSchema(WebhookFireSchema),
      handler: async (args) => {
        try {
          const { url, payload, headers, secret, method } = WebhookFireSchema.parse(args);
          const httpMethod = method ?? "POST";

          const bodyStr = JSON.stringify(payload);

          // Build headers
          const reqHeaders: Record<string, string> = {
            "Content-Type": "application/json",
          };

          // Add HMAC signature if secret provided
          if (secret) {
            const hmac = createHmac("sha256", secret).update(bodyStr).digest("hex");
            reqHeaders["X-Hub-Signature-256"] = `sha256=${hmac}`;
            reqHeaders["X-Hub-Signature"] = `sha1=${createHmac("sha1", secret).update(bodyStr).digest("hex")}`;
          }

          // Custom headers
          if (headers) {
            for (const [k, v] of Object.entries(headers)) {
              reqHeaders[k] = v;
            }
          }

          // Parse URL
          const parsedUrl = new URL(url);

          const isHttps = parsedUrl.protocol === "https:";
          const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: httpMethod,
            headers: reqHeaders,
            timeout: 30_000,
          };

          return await new Promise<ToolResult>((resolve) => {
            const requester = isHttps ? httpsRequest : httpRequest;
            const req = requester(options, (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.on("end", () => {
                const responseBody = Buffer.concat(chunks).toString("utf-8");
                const statusCode = res.statusCode ?? 0;
                const isSuccess = statusCode >= 200 && statusCode < 400;

                resolve({
                  content: [
                    {
                      type: "text",
                      text: [
                        isSuccess ? `✅ Webhook ${httpMethod} ${url} → ${statusCode}` : `⚠️ Webhook ${httpMethod} ${url} → ${statusCode}`,
                        responseBody ? `Response: ${responseBody.slice(0, 2000)}` : "",
                      ]
                        .filter(Boolean)
                        .join("\n"),
                    },
                  ],
                });
              });
            });

            req.on("error", (err) => {
              resolve({
                content: [{ type: "text", text: `❌ Webhook request failed.\n${err.message}` }],
                isError: true,
              });
            });

            req.on("timeout", () => {
              req.destroy();
              resolve({
                content: [{ type: "text", text: `❌ Webhook request timed out after 30s.` }],
                isError: true,
              });
            });

            req.write(bodyStr);
            req.end();
          });
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
