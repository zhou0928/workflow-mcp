import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ToolDefinition, ToolResult } from "./types.js";
import { getGitWorkflowTools } from "./workflows/git-workflow.js";
import { getFileProcessingTools } from "./workflows/file-processing.js";
import { getDeploymentTools } from "./workflows/deployment.js";
import { getCodeReviewTools } from "./workflows/code-review.js";
import { getEtlTools } from "./workflows/etl.js";
import { getSchedulerTools } from "./workflows/scheduler.js";
import { getNotifyTools } from "./workflows/notify.js";
import { getContainerTools } from "./workflows/container.js";
import { getScaffoldTools } from "./workflows/scaffold.js";
import { getSecretTools } from "./workflows/secrets.js";
import { getWebhookTools } from "./workflows/webhook.js";
import { getWorkflowTools } from "./workflows/workflow-orchestrator.js";
import { getDatabaseTools } from "./workflows/database.js";
import { getRemoteTools } from "./workflows/remote.js";
import { getLogTools } from "./workflows/log-manager.js";
import { startDaemon } from "./workflows/scheduler.js";

// ---------------------------------------------------------------------------
// Collect all tools from the workflow modules
// ---------------------------------------------------------------------------
const allTools: ToolDefinition[] = [
  ...getGitWorkflowTools(),
  ...getFileProcessingTools(),
  ...getDeploymentTools(),
  ...getCodeReviewTools(),
  ...getEtlTools(),
  ...getSchedulerTools(),
  ...getNotifyTools(),
  ...getContainerTools(),
  ...getScaffoldTools(),
  ...getSecretTools(),
  ...getWebhookTools(),
  ...getWorkflowTools(),
  ...getDatabaseTools(),
  ...getRemoteTools(),
  ...getLogTools(),
];

// ---------------------------------------------------------------------------
// Build a name → handler lookup for the CallTool handler
// ---------------------------------------------------------------------------
const handlerMap = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
for (const tool of allTools) {
  handlerMap.set(tool.name, tool.handler);
}

// ---------------------------------------------------------------------------
// Create the MCP server
// ---------------------------------------------------------------------------
const server = new Server(
  {
    name: "workflow-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ---------------------------------------------------------------------------
// ListTools handler — return all tool definitions (minus the handler fn,
// which is never serialised over the wire)
// ---------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools.map(({ handler: _handler, ...rest }) => ({
    ...rest,
    inputSchema: rest.inputSchema as Record<string, unknown>,
  })),
}));

// ---------------------------------------------------------------------------
// CallTool handler — dispatch by name, error on unknown tools
// ---------------------------------------------------------------------------
server.setRequestHandler(
  CallToolRequestSchema,
  async (request): Promise<ToolResult> => {
    const { name, arguments: args } = request.params;

    const handler = handlerMap.get(name);
    if (!handler) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      return await handler(args ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error executing tool "${name}": ${message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Start the server on stdio transport
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log startup info to stderr (stdio-safe)
  console.error(`[workflow-mcp] Server started — ${allTools.length} tools registered`);
  for (const tool of allTools) {
    console.error(`[workflow-mcp]   ➜ ${tool.name}: ${tool.description}`);
  }
}

main().catch((err) => {
  console.error("[workflow-mcp] Fatal startup error:", err);
  process.exit(1);
});
