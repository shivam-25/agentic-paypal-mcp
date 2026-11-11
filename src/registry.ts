/**
 * The agent's tools by name, so the chat console can run the same tools the
 * MCP server offers. index.ts fills this in as it registers each tool.
 */

export type ToolResult = { content: { type: "text"; text: string }[] };
export type ToolHandler = (args: any) => Promise<ToolResult>;

export const TOOLS = new Map<string, ToolHandler>();
