import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { ReviewRunLintSchema, ReviewRunTestsSchema, ReviewGenerateReportSchema, ReviewCheckStyleSchema } from "../types.js";
import { exec, detectProjectToolchain } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { mkdirSync } from "node:fs";

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
  ];
}

function dirname(p: string): string {
  const lastSep = p.lastIndexOf("/");
  return lastSep >= 0 ? p.slice(0, lastSep) || "/" : ".";
}
