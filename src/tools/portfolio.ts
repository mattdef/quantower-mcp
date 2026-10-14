import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { jsonResult, toToolError } from "../errors.js";
import { parseIsoDateOrThrow } from "./helpers.js";
import type { ToolContext } from "./index.js";

const MAX_HISTORY_LIMIT = 1000;

/** Tools portefeuille en lecture : positions, ordres, historique, exécutions (plan §4.1). */
export function registerPortfolioTools(server: McpServer, ctx: ToolContext): string[] {
  const names = [
    "quantower_get_positions",
    "quantower_get_orders",
    "quantower_get_orders_history",
    "quantower_get_trades",
  ];

  server.registerTool(
    "quantower_get_positions",
    {
      title: "Positions ouvertes",
      description:
        "Liste les positions ouvertes (positionId, symbolId, accountId, side, quantity, openPrice, NetPnL). " +
        "Filtrable par connectionId / accountId.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        connectionId: z.string().min(1).optional().describe("Filtre connexion."),
        accountId: z.string().min(1).optional().describe("Filtre compte."),
      },
    },
    async (args) => {
      try {
        const positions = await ctx.client.getPositions({
          connectionId: args.connectionId,
          accountId: args.accountId,
        });
        return jsonResult({ count: positions.length, positions });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "quantower_get_orders",
    {
      title: "Ordres en cours",
      description:
        "Liste les ordres actifs (working) : orderId, orderType, status, quantity, filledQuantity, price, triggerPrice. " +
        "Filtrable par connectionId / accountId.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        connectionId: z.string().min(1).optional().describe("Filtre connexion."),
        accountId: z.string().min(1).optional().describe("Filtre compte."),
      },
    },
    async (args) => {
      try {
        const orders = await ctx.client.getOrders({
          connectionId: args.connectionId,
          accountId: args.accountId,
        });
        return jsonResult({ count: orders.length, orders });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "quantower_get_orders_history",
    {
      title: "Historique des ordres",
      description:
        "Historique des ordres terminés (Core.GetOrdersHistory) : statuts filled/cancelled/rejected, " +
        "quantités exécutées. Filtrable par plage ISO 8601, connectionId / accountId, avec limit.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        from: z.string().min(1).optional().describe("Début de plage ISO 8601 UTC."),
        to: z.string().min(1).optional().describe("Fin de plage ISO 8601 UTC."),
        connectionId: z.string().min(1).optional().describe("Filtre connexion."),
        accountId: z.string().min(1).optional().describe("Filtre compte."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_HISTORY_LIMIT)
          .optional()
          .describe(`Nombre maximum d'ordres renvoyés (défaut ${ctx.config.read.defaultOrdersHistoryLimit}, max ${MAX_HISTORY_LIMIT}).`),
      },
    },
    async (args) => {
      try {
        const from = parseIsoDateOrThrow(args.from, "from");
        const to = parseIsoDateOrThrow(args.to, "to");
        const orders = await ctx.client.getOrdersHistory({
          connectionId: args.connectionId,
          accountId: args.accountId,
          from,
          to,
          limit: args.limit ?? ctx.config.read.defaultOrdersHistoryLimit,
        });
        return jsonResult({ count: orders.length, orders });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "quantower_get_trades",
    {
      title: "Exécutions (trades)",
      description:
        "Historique des exécutions depuis le login Quantower (Core.Trades) : tradeId, price, quantity, fee, orderId. " +
        "Filtrable par connectionId / accountId, avec limit.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        connectionId: z.string().min(1).optional().describe("Filtre connexion."),
        accountId: z.string().min(1).optional().describe("Filtre compte."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_HISTORY_LIMIT)
          .optional()
          .describe(`Nombre maximum d'exécutions renvoyées (défaut ${ctx.config.read.defaultTradesLimit}, max ${MAX_HISTORY_LIMIT}).`),
      },
    },
    async (args) => {
      try {
        const trades = await ctx.client.getTrades({
          connectionId: args.connectionId,
          accountId: args.accountId,
          limit: args.limit ?? ctx.config.read.defaultTradesLimit,
        });
        return jsonResult({ count: trades.length, trades });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  for (const name of names) {
    ctx.logger.debug(`Tool enregistré : ${name}`);
  }
  return names;
}
