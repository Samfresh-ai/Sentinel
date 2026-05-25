import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "@operaiq/shared";
import { getAgentEnv } from "./env.js";

const logger = createLogger("operaiq-mcp");

type McpContentItem = { type: string; text?: string };
type McpToolResult = { content: McpContentItem[]; isError?: boolean };

let clientPromise: Promise<Client> | undefined;

function mcpServerCommand(): { command: string; args: string[] } {
  const command = process.env.MONGODB_MCP_SERVER_COMMAND;
  if (command && command.trim().length > 0) {
    return { command, args: [] };
  }
  return { command: "pnpm", args: ["--filter", "@operaiq/agent", "exec", "mongodb-mcp-server"] };
}

async function connectMcpClient(): Promise<Client> {
  const env = getAgentEnv();
  const client = new Client({ name: "operaiq-agent", version: "0.1.0" });
  const commandConfig = mcpServerCommand();
  const transport = new StdioClientTransport({
    command: commandConfig.command,
    args: commandConfig.args,
    env: {
      ...getDefaultEnvironment(),
      MDB_MCP_CONNECTION_STRING: env.MONGODB_ATLAS_URI,
      MDB_MCP_LOG_PATH: process.env.MDB_MCP_LOG_PATH ?? "/tmp/operaiq-mongodb-mcp"
    },
    stderr: "pipe"
  });

  const stderr = transport.stderr;
  if (stderr) {
    stderr.on("data", (chunk: Buffer) => {
      logger.debug({ message: chunk.toString("utf8") }, "MongoDB MCP stderr");
    });
  }

  await client.connect(transport);
  const connectResult: unknown = await client.callTool(
    { name: "connect", arguments: { connectionStringOrClusterName: env.MONGODB_ATLAS_URI } },
    CallToolResultSchema
  );
  if (!isMcpToolResult(connectResult) || connectResult.isError) {
    throw new Error("MongoDB MCP connect failed");
  }
  logger.info("MongoDB MCP client connected to configured Atlas URI");
  return client;
}

export function getMcpClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connectMcpClient();
  }
  return clientPromise;
}

export async function closeMcpClient(): Promise<void> {
  if (!clientPromise) {
    return;
  }
  const client = await clientPromise.catch(() => undefined);
  clientPromise = undefined;
  await client?.close();
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isMcpToolResult(value: unknown): value is McpToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export async function callMcpTool(name: string, argumentsObject: Record<string, unknown>): Promise<McpToolResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const client = await getMcpClient();
      const rawResult: unknown = await client.callTool({ name, arguments: argumentsObject }, CallToolResultSchema);
      if (!isMcpToolResult(rawResult)) {
        throw new Error(`MongoDB MCP tool ${name} returned an unsupported result`);
      }
      const result = rawResult;
      if (result.isError) {
        throw new Error(textFromMcpResult(result).join("\n"));
      }
      return result;
    } catch (error: unknown) {
      lastError = error;
      logger.warn({ tool: name, attempt, error }, "MongoDB MCP tool call failed");
      clientPromise = undefined;
      if (attempt < 3) {
        await delay(250 * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`MongoDB MCP tool ${name} failed`);
}

export function textFromMcpResult(result: McpToolResult): string[] {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text);
}

export function documentsFromMcpResult(result: McpToolResult): Record<string, unknown>[] {
  return textFromMcpResult(result)
    .slice(1)
    .map((text) => {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      throw new Error("MongoDB MCP returned a non-document payload");
    });
}

export async function mongoFind(args: {
  database: string;
  collection: string;
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  limit?: number;
  sort?: Record<string, unknown>;
}): Promise<Record<string, unknown>[]> {
  const result = await callMcpTool("find", args);
  return documentsFromMcpResult(result);
}

export async function mongoAggregate(args: {
  database: string;
  collection: string;
  pipeline: Record<string, unknown>[];
  limit?: number;
}): Promise<Record<string, unknown>[]> {
  const result = await callMcpTool("aggregate", args);
  return documentsFromMcpResult(result);
}
