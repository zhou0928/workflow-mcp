import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import {
  GitCreateBranchSchema,
  GitCreatePRSchema,
  GitMergeBranchSchema,
  GitAutoCommitSchema,
  GitSyncForkSchema,
} from "../types.js";
import { execSafe, findGitRoot } from "../utils/exec.js";
import { logger } from "../utils/logger.js";

function ensureGitRepo(cwd?: string): string {
  const root = findGitRoot(cwd);
  if (!root) {
    throw new Error("Not inside a Git repository");
  }
  return root;
}

export function getGitWorkflowTools(): ToolDefinition[] {
  return [
    {
      name: "git_create_branch",
      description: "Create a new Git branch from a base branch",
      inputSchema: zToJsonSchema(GitCreateBranchSchema),
      handler: async (args) => {
        try {
          const { baseBranch, newBranchName } = GitCreateBranchSchema.parse(args);
          const gitRoot = ensureGitRepo();
          logger.info(`Creating branch ${newBranchName} from ${baseBranch}`);

          // Fetch latest and checkout base
          const fetchResult = execSafe("git", ["fetch", "origin", baseBranch], { cwd: gitRoot });
          if (fetchResult.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `Failed to fetch: ${fetchResult.stderr}` }],
              isError: true,
            };
          }

          const checkoutResult = execSafe("git", ["checkout", baseBranch], { cwd: gitRoot });
          if (checkoutResult.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `Failed to checkout ${baseBranch}: ${checkoutResult.stderr}` }],
              isError: true,
            };
          }

          const pullResult = execSafe("git", ["pull", "origin", baseBranch], { cwd: gitRoot });
          if (pullResult.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `Failed to pull: ${pullResult.stderr}` }],
              isError: true,
            };
          }

          const branchResult = execSafe("git", ["checkout", "-b", newBranchName], { cwd: gitRoot });
          if (branchResult.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `Failed to create branch: ${branchResult.stderr}` }],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `✅ Branch "${newBranchName}" created from "${baseBranch}" and checked out.`,
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
      name: "git_create_pr",
      description: "Create a Pull Request via GitHub CLI",
      inputSchema: zToJsonSchema(GitCreatePRSchema),
      handler: async (args) => {
        try {
          const { title, body, head, base, draft } = GitCreatePRSchema.parse(args);
          const gitRoot = ensureGitRepo();
          logger.info(`Creating PR: ${title}`);

          const ghArgs = ["pr", "create", "--title", title, "--base", base, "--head", head];
          if (body) { ghArgs.push("--body", body); }
          if (draft) { ghArgs.push("--draft"); }
          const ghResult = execSafe("gh", ghArgs, { cwd: gitRoot });

          if (ghResult.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `Failed to create PR: ${ghResult.stderr}` }],
              isError: true,
            };
          }

          return {
            content: [{ type: "text", text: `✅ PR created: ${ghResult.stdout}` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "git_merge_branch",
      description: "Merge one branch into another",
      inputSchema: zToJsonSchema(GitMergeBranchSchema),
      handler: async (args) => {
        try {
          const { sourceBranch, targetBranch, method } = GitMergeBranchSchema.parse(args);
          const gitRoot = ensureGitRepo();
          logger.info(`Merging ${sourceBranch} into ${targetBranch}`);

          // Ensure we are on target branch and it's up-to-date
          let r = execSafe("git", ["checkout", targetBranch], { cwd: gitRoot });
          if (r.exitCode !== 0) {
            return { content: [{ type: "text", text: `Failed to checkout ${targetBranch}: ${r.stderr}` }], isError: true };
          }

          r = execSafe("git", ["pull", "origin", targetBranch], { cwd: gitRoot });
          if (r.exitCode !== 0) {
            return { content: [{ type: "text", text: `Failed to pull ${targetBranch}: ${r.stderr}` }], isError: true };
          }

          const mergeMethod = method ?? "merge";
          let mergeResult: ReturnType<typeof execSafe>;
          if (mergeMethod === "squash") {
            mergeResult = execSafe("git", ["merge", "--squash", sourceBranch], { cwd: gitRoot });
            if (mergeResult.exitCode === 0) {
              execSafe("git", ["commit", "-m", `squash: merge ${sourceBranch} into ${targetBranch}`], { cwd: gitRoot });
            }
          } else if (mergeMethod === "rebase") {
            mergeResult = execSafe("git", ["rebase", sourceBranch], { cwd: gitRoot });
          } else {
            mergeResult = execSafe("git", ["merge", sourceBranch, "--no-ff"], { cwd: gitRoot });
          }

          if (mergeResult.exitCode !== 0) {
            return {
              content: [{ type: "text", text: `Merge failed (conflicts): ${mergeResult.stderr}\n${mergeResult.stdout}` }],
              isError: true,
            };
          }

          return {
            content: [{ type: "text", text: `✅ Merged "${sourceBranch}" into "${targetBranch}" using ${mergeMethod}.` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "git_auto_commit",
      description: "Auto-stage and commit changes with conventional commit style",
      inputSchema: zToJsonSchema(GitAutoCommitSchema),
      handler: async (args) => {
        try {
          const { message, files, type, addAll } = GitAutoCommitSchema.parse(args);
          const gitRoot = ensureGitRepo();
          logger.info("Auto-committing changes");

          if (addAll) {
            const addResult = execSafe("git", ["add", "-A"], { cwd: gitRoot });
            if (addResult.exitCode !== 0) {
              return { content: [{ type: "text", text: `Failed to stage files: ${addResult.stderr}` }], isError: true };
            }
          }

          // Check if there's anything to commit
          const statusResult = execSafe("git", ["status", "--porcelain"], { cwd: gitRoot });
          if (!statusResult.stdout) {
            return { content: [{ type: "text", text: "No changes to commit." }] };
          }

          // Generate commit message
          const commitType = type ?? "chore";
          const commitMsg = message ?? `Auto-commit: ${new Date().toISOString().split("T")[0]}`;
          const fullMsg = `${commitType}: ${commitMsg}`;

          const commitResult = execSafe("git", ["commit", "-m", fullMsg], { cwd: gitRoot });
          if (commitResult.exitCode !== 0) {
            return { content: [{ type: "text", text: `Commit failed: ${commitResult.stderr}` }], isError: true };
          }

          return {
            content: [{ type: "text", text: `✅ Committed: "${fullMsg}"` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "git_sync_fork",
      description: "Sync a fork with its upstream repository",
      inputSchema: zToJsonSchema(GitSyncForkSchema),
      handler: async (args) => {
        try {
          const { upstreamRemote, branch } = GitSyncForkSchema.parse(args);
          const gitRoot = ensureGitRepo();
          const targetBranch = branch ?? execSafe("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: gitRoot }).stdout;
          logger.info(`Syncing fork from ${upstreamRemote}`);

          let r = execSafe("git", ["fetch", upstreamRemote, targetBranch], { cwd: gitRoot });
          if (r.exitCode !== 0) {
            return { content: [{ type: "text", text: `Failed to fetch upstream: ${r.stderr}` }], isError: true };
          }

          r = execSafe("git", ["checkout", targetBranch], { cwd: gitRoot });
          if (r.exitCode !== 0) {
            return { content: [{ type: "text", text: `Failed to checkout ${targetBranch}: ${r.stderr}` }], isError: true };
          }

          r = execSafe("git", ["merge", `${upstreamRemote}/${targetBranch}`], { cwd: gitRoot });
          if (r.exitCode !== 0) {
            return { content: [{ type: "text", text: `Merge failed: ${r.stderr}` }], isError: true };
          }

          return {
            content: [{ type: "text", text: `✅ Fork synced: ${targetBranch} is up to date with ${upstreamRemote}/${targetBranch}.` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
