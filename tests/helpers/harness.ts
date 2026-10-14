/**
 * Harnais de test : bridge factice + serveur MCP complet reliés par InMemoryTransport.
 * Permet de tester les tools/resources/prompts exactement comme le ferait un client MCP.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig, type AppConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import { startMockBridge, type FakeBridgeFailMode, type FakeBridgeHandle } from "./mock-bridge.js";

export interface HarnessOptions {
  trading?: boolean;
  denyMarketOrders?: boolean;
  maxOrderQuantity?: number;
  maxNotional?: number;
  maxBars?: number;
  bridgeFailMode?: FakeBridgeFailMode;
  bridgeLatencyMs?: number;
  bridgeTimeoutMs?: number;
  cacheTtlMs?: number;
}

export interface ToolCallResult {
  text: string;
  isError: boolean;
  /** true si l'appel a levé côté client (ex. erreur de validation JSON-RPC). */
  thrown: boolean;
  json?: unknown;
}

export interface Harness {
  config: AppConfig;
  bridge: FakeBridgeHandle;
  client: Client;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  readResource(uri: string): Promise<string>;
  getPrompt(name: string, args?: Record<string, string>): Promise<string>;
  toolNames(): Promise<string[]>;
  close(): Promise<void>;
}

function extractText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) =>
      part !== null && typeof part === "object" && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const bridge = await startMockBridge({
    latencyMs: options.bridgeLatencyMs,
    failMode: options.bridgeFailMode,
  });

  const env: NodeJS.ProcessEnv = {
    QUANTOWER_BRIDGE_URL: bridge.url,
    QUANTOWER_BRIDGE_TOKEN: bridge.token,
    QUANTOWER_LOG_LEVEL: "error",
    QUANTOWER_TRADING_ENABLED: options.trading === true ? "true" : "false",
    QUANTOWER_BRIDGE_TIMEOUT_MS: String(options.bridgeTimeoutMs ?? 5_000),
    QUANTOWER_CACHE_TTL_MS: String(options.cacheTtlMs ?? 0),
    QUANTOWER_MAX_ORDER_QUANTITY: String(options.maxOrderQuantity ?? 50),
    QUANTOWER_MAX_NOTIONAL: String(options.maxNotional ?? 50_000),
    QUANTOWER_DENY_MARKET_ORDERS: options.denyMarketOrders === true ? "true" : "false",
    QUANTOWER_MAX_BARS: String(options.maxBars ?? 500),
  };
  const config = loadConfig(env);
  const { server } = createServer(config);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "quantower-mcp-tests", version: "0.0.0" });
  await client.connect(clientTransport);

  const harness: Harness = {
    config,
    bridge,
    client,

    async callTool(name, args = {}) {
      try {
        const result = await client.callTool({ name, arguments: args });
        const text = extractText(result);
        return { text, isError: result.isError === true, thrown: false, json: parseJsonOrUndefined(text) };
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
          thrown: true,
        };
      }
    },

    async readResource(uri) {
      const result = await client.readResource({ uri });
      const contents = (result as { contents?: unknown }).contents;
      if (!Array.isArray(contents) || contents.length === 0) {
        return "";
      }
      const first = contents[0] as { text?: unknown };
      return String(first.text ?? "");
    },

    async getPrompt(name, args = {}) {
      const result = await client.getPrompt({ name, arguments: args });
      const messages = (result as { messages?: unknown }).messages;
      if (!Array.isArray(messages)) {
        return "";
      }
      return messages
        .map((message) => {
          const content = (message as { content?: { text?: unknown } }).content;
          return content === undefined ? "" : String(content.text ?? "");
        })
        .join("\n");
    },

    async toolNames() {
      const result = await client.listTools();
      return result.tools.map((tool) => tool.name);
    },

    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await bridge.close().catch(() => undefined);
    },
  };

  return harness;
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
