import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { exec } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// ============================================================
// Schemas
// ============================================================

const SecretGetSchema = z.object({
  key: z.string().describe("Secret key to retrieve"),
  profile: z.string().optional().describe("Profile/environment name (default: 'default')"),
});

const SecretSetSchema = z.object({
  key: z.string().describe("Secret key"),
  value: z.string().describe("Secret value"),
  profile: z.string().optional().describe("Profile/environment name (default: 'default')"),
});

const SecretListSchema = z.object({
  profile: z.string().optional().describe("Profile/environment name (default: all profiles)"),
});

const SecretRemoveSchema = z.object({
  key: z.string().describe("Secret key to remove"),
  profile: z.string().optional().describe("Profile/environment name (default: 'default')"),
});

// ============================================================
// Storage
// ============================================================

const DATA_DIR = join(process.env.HOME || process.cwd(), ".workflow-mcp", "secrets");
const MASTER_KEY_FILE = join(DATA_DIR, ".master");

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getMasterKey(): Buffer {
  ensureDir();
  if (!existsSync(MASTER_KEY_FILE)) {
    const key = randomBytes(32).toString("hex");
    writeFileSync(MASTER_KEY_FILE, key, "utf-8");
    // Restrict permissions
    exec(`chmod 600 '${MASTER_KEY_FILE}'`, { timeout: 5_000 });
    return Buffer.from(key, "hex");
  }
  return Buffer.from(readFileSync(MASTER_KEY_FILE, "utf-8").trim(), "hex");
}

function encrypt(plaintext: string, masterKey: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  let encrypted = cipher.update(plaintext, "utf-8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

function decrypt(encoded: string, masterKey: Buffer): string {
  const parts = encoded.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [ivHex, authTagHex, encrypted] = parts;
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf-8");
  decrypted += decipher.final("utf-8");
  return decrypted;
}

function getProfileFile(profile: string): string {
  return join(DATA_DIR, `${profile}.json`);
}

function loadProfile(profile: string): Record<string, string> {
  ensureDir();
  const file = getProfileFile(profile);
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, "utf-8");
    const encrypted = JSON.parse(raw);
    const masterKey = getMasterKey();
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(encrypted)) {
      try {
        result[k] = decrypt(v as string, masterKey);
      } catch {
        result[k] = "⚠️ (decryption failed)";
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveProfile(profile: string, secrets: Record<string, string>): void {
  ensureDir();
  const masterKey = getMasterKey();
  const encrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) {
    encrypted[k] = encrypt(v, masterKey);
  }
  writeFileSync(getProfileFile(profile), JSON.stringify(encrypted, null, 2), "utf-8");
  exec(`chmod 600 '${getProfileFile(profile)}'`, { timeout: 5_000 });
}

// ============================================================
// Tool factory
// ============================================================

export function getSecretTools(): ToolDefinition[] {
  return [
    {
      name: "secret_set",
      description: "Store a secret value (encrypted at rest with AES-256-GCM)",
      inputSchema: zToJsonSchema(SecretSetSchema),
      handler: async (args) => {
        try {
          const { key, value, profile } = SecretSetSchema.parse(args);
          const profileName = profile ?? "default";
          const secrets = loadProfile(profileName);
          secrets[key] = value;
          saveProfile(profileName, secrets);
          logger.info(`Secret "${key}" saved to profile "${profileName}"`);
          return {
            content: [{ type: "text", text: `✅ Secret "${key}" saved to profile "${profileName}".` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "secret_get",
      description: "Retrieve a secret value (reads from encrypted storage)",
      inputSchema: zToJsonSchema(SecretGetSchema),
      handler: async (args) => {
        try {
          const { key, profile } = SecretGetSchema.parse(args);
          const profileName = profile ?? "default";
          const secrets = loadProfile(profileName);
          const value = secrets[key];
          if (value === undefined) {
            return { content: [{ type: "text", text: `❌ Secret "${key}" not found in profile "${profileName}".` }], isError: true };
          }
          return { content: [{ type: "text", text: value }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "secret_list",
      description: "List all secret keys (values masked by default)",
      inputSchema: zToJsonSchema(SecretListSchema),
      handler: async (args) => {
        try {
          const { profile } = SecretListSchema.parse(args);

          if (profile) {
            const secrets = loadProfile(profile);
            const keys = Object.keys(secrets);
            if (keys.length === 0) {
              return { content: [{ type: "text", text: `Profile "${profile}" is empty.` }] };
            }
            const lines = keys.map((k) => `  🔑 ${k}`);
            return { content: [{ type: "text", text: `Profile: ${profile}\n${lines.join("\n")}` }] };
          }

          // List all profiles
          ensureDir();
          const files = exec(`ls -1 '${DATA_DIR}' 2>/dev/null | grep '\\.json$' || true`, { timeout: 5_000 });
          const profiles = files.stdout
            .split("\n")
            .filter(Boolean)
            .map((f) => f.replace(/\.json$/, ""));

          if (profiles.length === 0) {
            return { content: [{ type: "text", text: "No secrets stored." }] };
          }

          const lines: string[] = [];
          for (const p of profiles) {
            const secrets = loadProfile(p);
            const count = Object.keys(secrets).length;
            lines.push(`  📂 ${p} (${count} secret${count !== 1 ? "s" : ""})`);
          }

          return { content: [{ type: "text", text: `Secret profiles:\n${lines.join("\n")}` }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "secret_remove",
      description: "Remove a secret by key",
      inputSchema: zToJsonSchema(SecretRemoveSchema),
      handler: async (args) => {
        try {
          const { key, profile } = SecretRemoveSchema.parse(args);
          const profileName = profile ?? "default";
          const secrets = loadProfile(profileName);
          if (!(key in secrets)) {
            return { content: [{ type: "text", text: `❌ Secret "${key}" not found in profile "${profileName}".` }], isError: true };
          }
          delete secrets[key];
          saveProfile(profileName, secrets);
          logger.info(`Secret "${key}" removed from profile "${profileName}"`);
          return { content: [{ type: "text", text: `✅ Secret "${key}" removed from profile "${profileName}".` }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
