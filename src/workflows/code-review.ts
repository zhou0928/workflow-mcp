import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { ReviewRunLintSchema, ReviewRunTestsSchema, ReviewGenerateReportSchema, ReviewCheckStyleSchema } from "../types.js";
import { exec, detectProjectToolchain } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { cwd } from "node:process";
import { mkdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export function getCodeReviewTools(): ToolDefinition[] {
  return [
    {
      name: "review_run_lint",
      description: "Run linter on a project directory",
      inputSchema: zToJsonSchema(ReviewRunLintSchema),
      handler: async (args) => {
        try {
          const { directory, fix } = ReviewRunLintSchema.parse(args);

          if (!existsSync(directory)) {
            return { content: [{ type: "text", text: `Directory not found: ${directory}` }], isError: true };
          }

          const toolchain = detectProjectToolchain(directory);
          const linter = toolchain.linter;

          if (!linter) {
            return {
              content: [{ type: "text", text: "No supported linter detected (ESLint or Biome). Install one to use this tool." }],
              isError: true,
            };
          }

          const fixFlag = fix ? (linter === "eslint" ? " --fix" : " --fix") : "";
          const cmd = linter === "eslint" ? `npx eslint .${fixFlag}` : `npx biome check .${fixFlag}`;

          const result = exec(cmd, { cwd: directory, timeout: 120_000 });

          const lines: string[] = [];
          if (result.exitCode === 0) {
            lines.push("✅ Lint passed with no errors.");
          } else {
            lines.push(`⚠️ Lint found issues (exit code: ${result.exitCode}):`);
          }
          if (result.stdout) lines.push(result.stdout.slice(0, 3000));
          if (result.stderr) lines.push(result.stderr.slice(0, 1000));

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "review_run_tests",
      description: "Run tests in a project directory",
      inputSchema: zToJsonSchema(ReviewRunTestsSchema),
      handler: async (args) => {
        try {
          const { directory, testPattern, coverage, command } = ReviewRunTestsSchema.parse(args);

          if (!existsSync(directory)) {
            return { content: [{ type: "text", text: `Directory not found: ${directory}` }], isError: true };
          }

          const toolchain = detectProjectToolchain(directory);

          let cmd: string;
          if (command) {
            cmd = command;
          } else if (testPattern) {
            cmd = `npx vitest run ${testPattern}`;
          } else {
            cmd = coverage
              ? `npx vitest run --coverage`
              : `npx vitest run`;
          }

          const result = exec(cmd, { cwd: directory, timeout: 300_000 });

          const lines: string[] = [];
          lines.push(result.exitCode === 0 ? "✅ Tests passed." : "❌ Tests failed.");
          if (result.stdout) lines.push(result.stdout.slice(0, 4000));
          if (result.stderr) lines.push(result.stderr.slice(0, 1000));

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "review_generate_report",
      description: "Generate a comprehensive code review report (lint + tests + deps)",
      inputSchema: zToJsonSchema(ReviewGenerateReportSchema),
      handler: async (args) => {
        try {
          const { directory, output, includeLint, includeTests, includeDeps } = ReviewGenerateReportSchema.parse(args);

          if (!existsSync(directory)) {
            return { content: [{ type: "text", text: `Directory not found: ${directory}` }], isError: true };
          }

          const toolchain = detectProjectToolchain(directory);
          const reportLines: string[] = [
            "# Code Review Report",
            `Generated: ${new Date().toISOString()}`,
            `Project: ${directory}`,
            `Toolchain: ${JSON.stringify(toolchain)}`,
            "",
          ];

          // Lint
          if (includeLint !== false && toolchain.linter) {
            reportLines.push("## Lint Results");
            const lintCmd = toolchain.linter === "eslint" ? "npx eslint ." : "npx biome check .";
            const lintResult = exec(lintCmd, { cwd: directory, timeout: 120_000 });
            reportLines.push(`Status: ${lintResult.exitCode === 0 ? "✅ Passed" : "❌ Issues found"}`);
            if (lintResult.stdout) reportLines.push(`\`\`\`\n${lintResult.stdout.slice(0, 2000)}\n\`\`\``);
            reportLines.push("");
          }

          // Tests
          if (includeTests !== false && toolchain.testRunner) {
            reportLines.push("## Test Results");
            const testResult = exec("npx vitest run 2>&1", { cwd: directory, timeout: 300_000 });
            reportLines.push(`Status: ${testResult.exitCode === 0 ? "✅ Passed" : "❌ Failed"}`);
            const testOutput = testResult.stdout || testResult.stderr;
            if (testOutput) reportLines.push(`\`\`\`\n${testOutput.slice(0, 3000)}\n\`\`\``);
            reportLines.push("");
          }

          // Dependency audit
          if (includeDeps !== false) {
            reportLines.push("## Dependency Audit");
            const auditResult = exec("npm audit --omit=dev 2>&1 || true", { cwd: directory, timeout: 60_000 });
            if (auditResult.stdout) reportLines.push(`\`\`\`\n${auditResult.stdout.slice(0, 2000)}\n\`\`\``);
            reportLines.push("");
          }

          const report = reportLines.join("\n");

          if (output) {
            const outDir = dirname(output);
            if (!existsSync(outDir)) {
              mkdirSync(outDir, { recursive: true });
            }
            writeFileSync(output, report, "utf-8");
            return { content: [{ type: "text", text: `✅ Report written to ${output}` }] };
          }

          return { content: [{ type: "text", text: report }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "review_check_style",
      description: "Check (or fix) code formatting/style with Prettier or Biome",
      inputSchema: zToJsonSchema(ReviewCheckStyleSchema),
      handler: async (args) => {
        try {
          const { directory, config, check } = ReviewCheckStyleSchema.parse(args);

          if (!existsSync(directory)) {
            return { content: [{ type: "text", text: `Directory not found: ${directory}` }], isError: true };
          }

          const toolchain = detectProjectToolchain(directory);
          const formatter = toolchain.formatter;

          if (!formatter) {
            return {
              content: [{ type: "text", text: "No supported formatter detected (Prettier or Biome)." }],
              isError: true,
            };
          }

          const configFlag = config ? (formatter === "prettier" ? ` --config ${config}` : ` --config-path ${config}`) : "";
          const checkFlag = check ? (formatter === "prettier" ? " --check" : " --ci") : "";
          const writeFlag = !check ? (formatter === "prettier" ? " --write" : " format --write") : "";

          const cmd =
            formatter === "prettier"
              ? `npx prettier .${configFlag}${checkFlag}${!check ? " --write" : ""}`
              : `npx biome ${checkFlag ? "ci" : "format"}${configFlag}${writeFlag} .`;

          const result = exec(cmd, { cwd: directory, timeout: 120_000 });

          const lines: string[] = [];
          if (result.exitCode === 0) {
            lines.push(check ? "✅ Style check passed." : "✅ Formatting applied.");
          } else {
            lines.push(`⚠️ Style issues found (exit code: ${result.exitCode}):`);
          }
          if (result.stdout) lines.push(result.stdout.slice(0, 2000));
          if (result.stderr) lines.push(result.stderr.slice(0, 1000));

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "review_ai_review",
      description: "AI-powered code review using LLM — analyzes code for architecture, security, logic, and style issues",
      inputSchema: zToJsonSchema(z.object({
        directory: z.string().describe("Project directory to review"),
        filePattern: z.string().optional().describe("File glob pattern to filter (e.g. '**/*.ts', default: all)"),
        focus: z.array(z.enum(["architecture", "security", "logic", "style", "performance", "all"])).optional().describe("Review focus areas (default: all)"),
        apiKey: z.string().optional().describe("LLM API key (or set AI_REVIEW_API_KEY env var)"),
        apiUrl: z.string().optional().describe("LLM API URL (default: OpenAI-compatible, or set AI_REVIEW_API_URL env var)"),
        model: z.string().optional().describe("Model name (default: 'gpt-4o-mini', or set AI_REVIEW_MODEL env var)"),
        output: z.string().optional().describe("Output file for the review report"),
      })),
      handler: async (args) => {
        try {
          const args_ = args as {
            directory: string;
            filePattern?: string;
            focus?: string[];
            apiKey?: string;
            apiUrl?: string;
            model?: string;
            output?: string;
          };

          const dir = args_.directory;
          if (!existsSync(dir)) {
            return { content: [{ type: "text", text: `Directory not found: ${dir}` }], isError: true };
          }

          const apiKey = args_.apiKey ?? process.env.AI_REVIEW_API_KEY;
          const apiUrl = args_.apiUrl ?? process.env.AI_REVIEW_API_URL ?? "https://api.openai.com/v1";
          const model = args_.model ?? process.env.AI_REVIEW_MODEL ?? "gpt-4o-mini";
          const pattern = args_.filePattern ?? "*";
          const focusAreas = args_.focus ?? ["all"];
          const outFile = args_.output;

          if (!apiKey) {
            return { content: [{ type: "text", text: "❌ No API key provided. Set AI_REVIEW_API_KEY env var or pass apiKey parameter." }], isError: true };
          }

          logger.info(`AI review: ${dir} (focus: ${focusAreas.join(", ")})`);

          // Collect files using fs (safe, no shell injection)
          const files: string[] = [];
          const collectFiles = (searchDir: string, patternGlob: string): void => {
            try {
              const entries = readdirSync(searchDir);
              for (const entry of entries) {
                if (entry.startsWith(".") || entry === "node_modules") continue;
                const fullPath = join(searchDir, entry);
                try {
                  const stat = statSync(fullPath);
                  if (stat.isDirectory()) {
                    if (files.length < 30) collectFiles(fullPath, patternGlob);
                  } else if (stat.isFile()) {
                    const matches = patternGlob === "*" || entry.includes(patternGlob.replace("*", ""));
                    if (matches) files.push(fullPath);
                  }
                } catch { /* skip */ }
              }
            } catch { /* skip */ }
          };
          collectFiles(dir, pattern);

          if (files.length === 0) {
            return { content: [{ type: "text", text: "No files found matching the pattern." }] };
          }

          // Build code context
          const fileContents: string[] = [];
          for (const f of files) {
            try {
              const relPath = f.replace(dir, "").replace(/^\//, "");
              const ext = f.split(".").pop()?.toLowerCase();
              // Skip binary/too-large files
              if (["jpg", "png", "gif", "svg", "ico", "woff", "ttf", "eot", "mp4", "zip", "gz", "lock"].includes(ext ?? "")) continue;
              const content = readFileSync(f, "utf-8");
              if (content.length > 50000) continue; // Skip very large files
              fileContents.push(`--- ${relPath} ---\n${content.slice(0, 8000)}`);
            } catch { /* skip unreadable */ }
          }

          if (fileContents.length === 0) {
            return { content: [{ type: "text", text: "No readable source files found." }] };
          }

          const codeBlock = fileContents.join("\n\n").slice(0, 60000);
          const focusPrompt = focusAreas.includes("all")
            ? "architecture, security, logic, performance, code style, and potential bugs"
            : focusAreas.join(", ");

          const prompt = `You are an expert code reviewer. Review the following code for ${focusPrompt}.

Provide a structured review with:
1. **Critical Issues** (bugs, security vulnerabilities, logic errors)
2. **Architecture & Design** (coupling, cohesion, patterns)
3. **Code Quality** (style, naming, duplication, complexity)
4. **Performance** (bottlenecks, optimization opportunities)
5. **Specific Suggestions** with file references

For each issue, include: severity (HIGH/MEDIUM/LOW), file, and recommended fix.

Code:
${codeBlock}`;

          // Call LLM API
          const payload = JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 4000,
            temperature: 0.1,
          });

          try {
            const parsedUrl = new URL(`${apiUrl}/chat/completions`);
            const isHttps = parsedUrl.protocol === "https:";
            const requester = isHttps ? httpsRequest : httpRequest;

            const response = await new Promise<string>((resolve, reject) => {
              const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${apiKey}`,
                  "Content-Length": Buffer.byteLength(payload).toString(),
                },
                timeout: 120_000,
              };

              const req = requester(options, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => {
                  const body = Buffer.concat(chunks).toString("utf-8");
                  const httpCode = res.statusCode ?? 0;
                  if (httpCode >= 200 && httpCode < 300) {
                    resolve(body);
                  } else {
                    reject(new Error(`HTTP ${httpCode}: ${body.slice(0, 500)}`));
                  }
                });
              });

              req.on("error", (err) => reject(err));
              req.on("timeout", () => {
                req.destroy();
                reject(new Error("Request timed out after 120s"));
              });

              req.write(payload);
              req.end();
            });

            let reviewContent: string;
            try {
              const parsed = JSON.parse(response);
              reviewContent = parsed.choices?.[0]?.message?.content ?? "No review content returned.";
            } catch {
              reviewContent = response.slice(0, 10000);
            }

            const summary = `🤖 AI Code Review\n   Files analyzed: ${fileContents.length} of ${files.length} matched\n   Focus: ${focusPrompt}\n   Model: ${model}\n\n${reviewContent}`;

            if (outFile) {
              writeFileSync(outFile, summary, "utf-8");
              return { content: [{ type: "text", text: `✅ AI review complete. Report saved to ${outFile}\n\n${summary.slice(0, 2000)}...` }] };
            }

            return { content: [{ type: "text", text: summary }] };
          } catch (apiErr) {
            return { content: [{ type: "text", text: `❌ AI review API call failed.\n${apiErr instanceof Error ? apiErr.message : String(apiErr)}` }], isError: true };
          }
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
