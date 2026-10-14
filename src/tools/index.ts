/**
 * Enregistrement des tools MCP.
 *
 * Règle de sécurité (plan §4.5) : les tools d'écriture ne sont enregistrés que si
 * `config.trading.enabled` est vrai (QUANTOWER_TRADING_ENABLED=true et QUANTOWER_READ_ONLY≠true).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { QuantowerClient } from "../quantower-client.js";
import { registerAccountTools } from "./accounts.js";
import { registerConnectionTools } from "./connections.js";
import { registerMarketDataTools } from "./market-data.js";
import { registerOrderTools } from "./orders.js";
import { registerPortfolioTools } from "./portfolio.js";
import { registerPositionTools } from "./positions.js";
import { registerStatusTools } from "./status.js";
import { registerSymbolTools } from "./symbols.js";

/** Dépendances injectées dans chaque tool (facilite les tests). */
export interface ToolContext {
  client: QuantowerClient;
  config: AppConfig;
  logger: Logger;
}

export function registerAllTools(server: McpServer, ctx: ToolContext): string[] {
  const readTools = [
    ...registerStatusTools(server, ctx),
    ...registerConnectionTools(server, ctx),
    ...registerAccountTools(server, ctx),
    ...registerSymbolTools(server, ctx),
    ...registerMarketDataTools(server, ctx),
    ...registerPortfolioTools(server, ctx),
  ];

  if (!ctx.config.trading.enabled) {
    ctx.logger.info(
      "Mode read_only : tools d'écriture non enregistrés (QUANTOWER_TRADING_ENABLED absent ou QUANTOWER_READ_ONLY=true).",
    );
    return readTools;
  }

  const writeTools = [...registerOrderTools(server, ctx), ...registerPositionTools(server, ctx)];
  ctx.logger.warn(`Mode trading ACTIVÉ : ${writeTools.length} tools d'écriture enregistrés.`);
  return [...readTools, ...writeTools];
}
