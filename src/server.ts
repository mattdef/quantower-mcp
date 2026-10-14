/**
 * Bootstrap du serveur MCP Quantower (transport stdio, plan §2.1 B).
 *
 * stdout est réservé au protocole JSON-RPC : tous les logs vont sur stderr.
 */

import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, readBridgeToken, type AppConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { QuantowerClient } from "./quantower-client.js";
import { registerAllPrompts } from "./prompts/index.js";
import { registerAllResources } from "./resources/index.js";
import { registerAllTools, type ToolContext } from "./tools/index.js";

export const SERVER_NAME = "quantower-mcp";
export const SERVER_VERSION = "0.1.0";

export interface ServerBundle {
  server: McpServer;
  client: QuantowerClient;
  config: AppConfig;
  logger: Logger;
}

/** Construit le serveur MCP complet (tools + resources + prompts) à partir d'une config. */
export function createServer(config: AppConfig): ServerBundle {
  const logger = createLogger(config.logLevel);
  const client = new QuantowerClient({ bridge: config.bridge, logger });
  const context: ToolContext = { client, config, logger };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Serveur MCP local pour Quantower. Commencez par quantower_status pour vérifier le bridge. " +
        "Respectez le mode read_only (par défaut) : les tools d'écriture ne sont disponibles que si " +
        "QUANTOWER_TRADING_ENABLED=true, exigent confirm: true et restent soumis aux plafonds configurés. " +
        "N'utilisez les outils d'écriture que sur un compte démo / Trading Simulator.",
    },
  );

  const tools = registerAllTools(server, context);
  const resources = registerAllResources(server, context);
  registerAllPrompts(server, context);

  logger.info(
    `Serveur ${SERVER_NAME} v${SERVER_VERSION} : ${tools.length} tools, ${resources.length} resources, ` +
      `mode=${config.trading.enabled ? "trading" : "read_only"}, bridge=${config.bridge.url}`,
  );

  return { server, client, config, logger };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const { server, logger } = createServer(config);

  if (readBridgeToken(config.bridge) === undefined) {
    logger.warn(
      `Aucun token bridge trouvé (ni QUANTOWER_BRIDGE_TOKEN ni ${config.bridge.tokenFile}) : ` +
        "les appels échoueront en BRIDGE_UNAUTHORIZED tant que le bridge n'aura pas écrit son token.",
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Transport stdio connecté, en attente du client MCP.");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Signal ${signal} reçu, arrêt du serveur MCP.`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    // Le logger n'est pas disponible si loadConfig() a jeté : fallback stderr direct.
    process.stderr.write(`[quantower-mcp] Erreur fatale : ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
