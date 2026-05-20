import { execSync, exec as execCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function exec(
  command: string,
  options?: { cwd?: string; timeout?: number }
): ExecResult {
  try {
    const stdout = execSync(command, {
      encoding: "utf-8",
      cwd: options?.cwd,
      timeout: options?.timeout ?? 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const error = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
      message?: string;
    };
    return {
      stdout: (error.stdout ?? "").toString().trim(),
      stderr: (error.stderr ?? "").toString().trim(),
      exitCode: error.status ?? 1,
    };
  }
}

export function execAsync(
  command: string,
  options?: { cwd?: string; timeout?: number }
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execCallback(
      command,
      {
        encoding: "utf-8",
        cwd: options?.cwd,
        timeout: options?.timeout ?? 120_000,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: (stdout ?? "").trim(),
          stderr: (stderr ?? "").trim(),
          exitCode: error?.code ?? 0,
        });
      }
    );
  });
}

export function findGitRoot(startPath: string = process.cwd()): string | null {
  let current = startPath;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function commandExists(command: string): boolean {
  try {
    execSync(`which ${command}`, { encoding: "utf-8", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function detectProjectToolchain(
  projectDir: string
): { linter: string | null; formatter: string | null; testRunner: string | null } {
  const result = {
    linter: null as string | null,
    formatter: null as string | null,
    testRunner: null as string | null,
  };

  // Detect linter
  if (existsSync(join(projectDir, "eslint.config.js")) || existsSync(join(projectDir, ".eslintrc.json")) || existsSync(join(projectDir, ".eslintrc.js"))) {
    result.linter = "eslint";
  } else if (existsSync(join(projectDir, "biome.json"))) {
    result.linter = "biome";
  }

  // Detect formatter
  if (existsSync(join(projectDir, ".prettierrc")) || existsSync(join(projectDir, ".prettierrc.json")) || existsSync(join(projectDir, ".prettierrc.js"))) {
    result.formatter = "prettier";
  } else if (existsSync(join(projectDir, "biome.json"))) {
    result.formatter = "biome";
  }

  // Detect test runner
  if (existsSync(join(projectDir, "vitest.config.ts")) || existsSync(join(projectDir, "vitest.config.js"))) {
    result.testRunner = "vitest";
  } else if (existsSync(join(projectDir, "jest.config.js")) || existsSync(join(projectDir, "jest.config.ts"))) {
    result.testRunner = "jest";
  }

  logger.debug("Detected project toolchain", result);
  return result;
}
