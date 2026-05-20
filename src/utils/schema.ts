import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Converts a Zod schema to a JSON Schema object compatible with MCP's
 * ToolDefinition.inputSchema format.
 */
export function zToJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  return zodToJsonSchema(schema, {
    target: "openApi3",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}
