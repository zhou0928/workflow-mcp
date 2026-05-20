import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { NotificationSendSchema, NotificationSendMultiSchema, NotificationListChannelsSchema } from "../types.js";
import { exec } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConfig(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

function sendSlack(webhookUrl: string, title: string, message: string, priority?: string): Promise<string> {
  const colorMap: Record<string, string> = {
    low: "#808080",
    normal: "#3B6FD4",
    high: "#FFA500",
    critical: "#D94452",
  };

  const payload = JSON.stringify({
    attachments: [
      {
        color: colorMap[priority ?? "normal"] ?? "#3B6FD4",
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: title },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: message },
          },
        ],
      },
    ],
  });

  return httpPost(webhookUrl, payload).then(
    () => "✅ Slack notification sent",
    (err) => `❌ Slack send failed: ${err.message}`
  );
}

function httpPost(url: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const requester = isHttps ? httpsRequest : httpRequest;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      timeout: 15_000,
    };

    const req = requester(options, (res) => {
      // Drain response to free memory
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          const respBody = Buffer.concat(chunks).toString("utf-8");
          reject(new Error(`HTTP ${res.statusCode}: ${respBody.slice(0, 200)}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out after 15s"));
    });

    req.write(body);
    req.end();
  });
}

function sendEmail(smtpConfig: Record<string, string>, to: string, subject: string, body: string): string {
  // Uses system `sendmail` or `mail` command as a zero-dependency fallback
  const mailCmd = exec("which mail sendmail 2>/dev/null || echo none", { timeout: 5_000 });
  const available = mailCmd.stdout.trim();

  if (available && available !== "none") {
    const sender = smtpConfig["from"] ?? "workflow-mcp@localhost";
    const result = exec(
      `echo "${body.replace(/"/g, '\\"')}" | ${available} -s "${subject.replace(/"/g, '\\"')}" -a "From: ${sender}" "${to}"`,
      { timeout: 15_000 },
    );
    return result.exitCode === 0
      ? `✅ Email sent to ${to}`
      : `❌ Email send failed: ${result.stderr}`;
  }

  // Fallback: write to file
  const logDir = process.env.HOME ? join(process.env.HOME, ".workflow-mcp", "mail") : "/tmp/workflow-mcp-mail";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const content = [`From: ${smtpConfig["from"] ?? "workflow-mcp@localhost"}`, `To: ${to}`, `Subject: ${subject}`, "", body].join("\n");
  exec(`mkdir -p '${logDir}' && echo '${content.replace(/'/g, "'\\''")}' > '${logDir}/${timestamp}.eml'`, { timeout: 5_000 });
  return `⚠️  No mail command available. Saved draft to ${logDir}/${timestamp}.eml`;
}

function sendWecom(key: string, title: string, message: string): Promise<string> {
  const payload = JSON.stringify({
    msgtype: "markdown",
    markdown: {
      content: `## ${title}\n${message}`,
    },
  });

  const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`;
  return httpPost(url, payload).then(
    () => "✅ WeCom notification sent",
    (err) => `❌ WeCom send failed: ${err.message}`
  );
}

function resolveChannels(): Record<string, string> {
  const channels: Record<string, string> = {};
  // Slack
  const slackUrl = getConfig("NOTIFY_SLACK_WEBHOOK");
  if (slackUrl) channels["slack"] = slackUrl;
  // WeChat Work
  const wecomKey = getConfig("NOTIFY_WECOM_KEY");
  if (wecomKey) channels["wecom"] = wecomKey;
  // Email
  const smtpHost = getConfig("NOTIFY_SMTP_HOST");
  if (smtpHost) channels["email"] = smtpHost;
  return channels;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function getNotifyTools(): ToolDefinition[] {
  return [
    {
      name: "notify_send",
      description: "Send a notification (Slack, WeCom, Email) with configurable priority",
      inputSchema: zToJsonSchema(NotificationSendSchema),
      handler: async (args) => {
        try {
          const { channel, title, message, priority } = NotificationSendSchema.parse(args);
          const channels = resolveChannels();
          const channelLower = channel.toLowerCase();

          if (channelLower === "slack") {
            const url = channels["slack"] ?? getConfig("NOTIFY_SLACK_WEBHOOK");
            if (!url) return { content: [{ type: "text", text: "❌ Slack not configured. Set NOTIFY_SLACK_WEBHOOK env var." }], isError: true };
            const result = await sendSlack(url, title, message, priority);
            return { content: [{ type: "text", text: result }] };
          }

          if (channelLower === "wecom" || channelLower === "wechat" || channelLower === "企业微信") {
            const key = channels["wecom"] ?? getConfig("NOTIFY_WECOM_KEY");
            if (!key) return { content: [{ type: "text", text: "❌ WeCom not configured. Set NOTIFY_WECOM_KEY env var." }], isError: true };
            const result = await sendWecom(key, title, message);
            return { content: [{ type: "text", text: result }] };
          }

          if (channelLower === "email") {
            const to = getConfig("NOTIFY_EMAIL_TO");
            if (!to) return { content: [{ type: "text", text: "❌ Email recipient not configured. Set NOTIFY_EMAIL_TO env var." }], isError: true };
            const smtpConfig: Record<string, string> = {};
            if (process.env.NOTIFY_SMTP_HOST) smtpConfig["host"] = process.env.NOTIFY_SMTP_HOST;
            if (process.env.NOTIFY_SMTP_PORT) smtpConfig["port"] = process.env.NOTIFY_SMTP_PORT;
            if (process.env.NOTIFY_EMAIL_FROM) smtpConfig["from"] = process.env.NOTIFY_EMAIL_FROM;
            const result = sendEmail(smtpConfig, to, title, message);
            return { content: [{ type: "text", text: result }] };
          }

          // Custom webhook channel
          const webhookUrl = getConfig(`NOTIFY_WEBHOOK_${channelLower.toUpperCase()}`);
          if (webhookUrl) {
            const result = await sendSlack(webhookUrl, title, message, priority);
            return { content: [{ type: "text", text: result }] };
          }

          return {
            content: [{ type: "text", text: `❌ Unknown channel "${channel}" or not configured. Available channels: ${Object.keys(channels).join(", ")}` }],
            isError: true,
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "notify_send_multi",
      description: "Send the same notification to multiple channels at once",
      inputSchema: zToJsonSchema(NotificationSendMultiSchema),
      handler: async (args) => {
        try {
          const { channels, title, message, priority } = NotificationSendMultiSchema.parse(args);
          const results: string[] = [];

          for (const ch of channels) {
            const subResult = await getNotifyTools()[0].handler({ channel: ch, title, message, priority });
            const text = subResult.content?.[0]?.text ?? "Unknown result";
            results.push(`[${ch}] ${text}`);
          }

          return {
            content: [{ type: "text", text: results.join("\n") }],
          };
        } catch (err) {
          const msg = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
        }
      },
    },
    {
      name: "notify_list_channels",
      description: "List configured notification channels and their status",
      inputSchema: zToJsonSchema(NotificationListChannelsSchema),
      handler: async (_args) => {
        try {
          const channels = resolveChannels();
          const lines = Object.entries(channels).map(([name, _]) => `  ✅ ${name}`);
          if (lines.length === 0) {
            return { content: [{ type: "text", text: "No notification channels configured. Set NOTIFY_SLACK_WEBHOOK, NOTIFY_WECOM_KEY, or NOTIFY_SMTP_HOST env vars." }] };
          }
          return {
            content: [{ type: "text", text: `Configured channels:\n${lines.join("\n")}` }],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
        }
      },
    },
  ];
}
