import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock exec utilities before importing the module under test
vi.mock("../utils/exec.js", () => ({
  exec: vi.fn(),
  findGitRoot: vi.fn(),
  execAsync: vi.fn(),
}));

import { exec, findGitRoot } from "../utils/exec.js";
import { getGitWorkflowTools } from "../workflows/git-workflow.js";
import type { ToolDefinition } from "../types.js";

const tools: ToolDefinition[] = getGitWorkflowTools();

beforeEach(() => {
  vi.resetAllMocks();
  findGitRoot.mockReturnValue("/fake/repo");
});

describe("getGitWorkflowTools", () => {
  it("should return 5 tools", () => {
    expect(tools).toHaveLength(5);
  });

  it("should have correctly named tools", () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "git_create_branch",
      "git_create_pr",
      "git_merge_branch",
      "git_auto_commit",
      "git_sync_fork",
    ]);
  });

  it("should have descriptions for all tools", () => {
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe("string");
    }
  });

  it("should have valid inputSchema for all tools", () => {
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema).toBe("object");
    }
  });

  it("should have a handler function for all tools", () => {
    for (const tool of tools) {
      expect(typeof tool.handler).toBe("function");
    }
  });
});

describe("git_create_branch", () => {
  const tool = tools.find((t) => t.name === "git_create_branch")!;

  it("should fail if not in a git repo", async () => {
    findGitRoot.mockReturnValue(null);
    const result = await tool.handler({
      baseBranch: "main",
      newBranchName: "feature/test",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Git repository");
  });

  it("should fail with invalid args", async () => {
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error");
  });

  it("should succeed when all git commands pass", async () => {
    exec.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });
    const result = await tool.handler({
      baseBranch: "main",
      newBranchName: "feature/test",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("feature/test");
    // Should have done: fetch, checkout, pull, checkout -b
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it("should fail if fetch fails", async () => {
    exec.mockReturnValueOnce({ stdout: "", stderr: "fetch error", exitCode: 1 });
    const result = await tool.handler({
      baseBranch: "main",
      newBranchName: "feature/test",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("fetch");
  });
});

describe("git_create_pr", () => {
  const tool = tools.find((t) => t.name === "git_create_pr")!;

  it("should fail if not in a git repo", async () => {
    findGitRoot.mockReturnValue(null);
    const result = await tool.handler({
      title: "My PR",
      head: "feature",
      base: "main",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Git repository");
  });

  it("should fail with invalid args", async () => {
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
  });

  it("should create a PR successfully", async () => {
    exec.mockReturnValue({ stdout: "https://github.com/example/pull/1", stderr: "", exitCode: 0 });
    const result = await tool.handler({
      title: "My PR",
      body: "Description",
      head: "feature",
      base: "main",
      draft: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("PR created");
  });

  it("should handle gh CLI failure", async () => {
    exec.mockReturnValue({ stdout: "", stderr: "gh not logged in", exitCode: 1 });
    const result = await tool.handler({
      title: "My PR",
      head: "feature",
      base: "main",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed");
  });
});

describe("git_merge_branch", () => {
  const tool = tools.find((t) => t.name === "git_merge_branch")!;

  it("should succeed with default merge method", async () => {
    exec.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });
    const result = await tool.handler({
      sourceBranch: "feature",
      targetBranch: "main",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Merged");
    expect(exec).toHaveBeenCalled();
  });

  it("should handle squash merge", async () => {
    exec.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });
    const result = await tool.handler({
      sourceBranch: "feature",
      targetBranch: "main",
      method: "squash",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Merged");
  });

  it("should handle merge conflicts", async () => {
    exec
      .mockReturnValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // checkout
      .mockReturnValueOnce({ stdout: "", stderr: "", exitCode: 0 }) // pull
      .mockReturnValueOnce({ stdout: "", stderr: "conflict", exitCode: 1 }); // merge
    const result = await tool.handler({
      sourceBranch: "feature",
      targetBranch: "main",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("conflict");
  });
});

describe("git_auto_commit", () => {
  const tool = tools.find((t) => t.name === "git_auto_commit")!;

  it("should report no changes when status is empty", async () => {
    exec.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });
    const result = await tool.handler({});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No changes");
  });

  it("should commit with auto-generated message", async () => {
    exec
      .mockReturnValueOnce({ stdout: " M src/index.ts\n", stderr: "", exitCode: 0 }) // status
      .mockReturnValueOnce({ stdout: "1 file changed", stderr: "", exitCode: 0 }); // commit
    const result = await tool.handler({ addAll: true });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Committed");
  });

  it("should use provided type and message", async () => {
    exec
      .mockReturnValueOnce({ stdout: " M src/index.ts\n", stderr: "", exitCode: 0 }) // status
      .mockReturnValueOnce({ stdout: "1 file changed", stderr: "", exitCode: 0 }); // commit
    const result = await tool.handler({
      type: "feat",
      message: "add new feature",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("feat: add new feature");
  });
});

describe("git_sync_fork", () => {
  const tool = tools.find((t) => t.name === "git_sync_fork")!;

  it("should sync fork successfully", async () => {
    exec.mockReturnValue({ stdout: "", stderr: "", exitCode: 0 });
    const result = await tool.handler({ upstreamRemote: "upstream" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Fork synced");
  });

  it("should fail on fetch error", async () => {
    exec.mockReturnValueOnce({ stdout: "", stderr: "fetch failed", exitCode: 1 });
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("fetch");
  });
});
