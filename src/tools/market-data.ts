import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { QuantowerError, jsonResult, toToolError } from "../errors.js";
import { parseIsoDateOrThrow } from "./helpers.js";
import type { ToolContext } from "./index.js";

/** Timeframes supportés par le bridge (mapping Period Quantower côté C#, plan §3). */
export const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"] as const;

const DEFAULT_DOM_DEPTH = 10;
const MAX_DOM_DEPTH = 50;

/** Tools de données de marché : quote, historique OHLCV, depth of market (plan §4.1). */
export function registerMarketDataTools(server: McpServer, ctx: ToolContext): string[] {
  const names = ["quantower_get_quote", "quantower_get_history", "quantower_get_dom"];

  server.registerTool(
    "quantower_get_quote",
    {
      title: "Cours d'un instrument",
      description:
        "Renvoie Bid / Ask / Last / volume et OHLC du jour pour un instrument donné (symbolId exact, " +
        "ex. « EUR/USD »). La quote est mise en cache une seconde côté serveur MCP.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        symbolId: z.string().min(1).describe("Identifiant de l'instrument (Symbol.Name)."),
        connectionId: z.string().min(1).optional().describe("Connexion à utiliser si l'instrument existe sur plusieurs."),
      },
    },
    async (args) => {
      try {
        const quote = await ctx.client.getQuote(args.symbolId, args.connectionId);
        return jsonResult(quote);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "quantower_get_history",
    {
      title: "Historique OHLCV",
      description:
        `Renvoie les bougies OHLCV d'un instrument (timeframes : ${TIMEFRAMES.join(", ")}). ` +
        `Le nombre de barres est plafonné à QUANTOWER_MAX_BARS (actuellement ${ctx.config.read.maxBars}). ` +
        "Cette lecture n'est pas mise en cache : réduisez limit pour les gros historiques.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        symbolId: z.string().min(1).describe("Identifiant de l'instrument (Symbol.Name)."),
        timeframe: z.enum(TIMEFRAMES).describe("Granularité des bougies."),
        from: z.string().min(1).optional().describe("Début de plage ISO 8601, ex. 2026-10-01T00:00:00Z."),
        to: z.string().min(1).optional().describe("Fin de plage ISO 8601, ex. 2026-10-13T00:00:00Z."),
        limit: z
          .number()
          .int()
          .positive()
          .max(ctx.config.read.maxBars)
          .optional()
          .describe(`Nombre maximum de barres (défaut ${ctx.config.read.defaultHistoryBars}, max ${ctx.config.read.maxBars}).`),
        connectionId: z.string().min(1).optional().describe("Connexion à utiliser si l'instrument existe sur plusieurs."),
      },
    },
    async (args) => {
      try {
        const from = parseIsoDateOrThrow(args.from, "from");
        const to = parseIsoDateOrThrow(args.to, "to");
        if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) {
          throw new QuantowerError(
            "VALIDATION_ERROR",
            `Plage invalide : from (${from}) est postérieur à to (${to}).`,
          );
        }
        const history = await ctx.client.getHistory({
          symbolId: args.symbolId,
          timeframe: args.timeframe,
          from,
          to,
          limit: args.limit ?? ctx.config.read.defaultHistoryBars,
          connectionId: args.connectionId,
        });
        return jsonResult({ ...history, count: history.bars.length });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "quantower_get_dom",
    {
      title: "Carnet d'ordres (DOM)",
      description:
        "Renvoie la profondeur de marché (Level 2) d'un instrument : listes bids/asks {price, size}. " +
        "Peut être indisponible selon la connexion ou la licence Quantower.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        symbolId: z.string().min(1).describe("Identifiant de l'instrument (Symbol.Name)."),
        depth: z
          .number()
          .int()
          .positive()
          .max(MAX_DOM_DEPTH)
          .optional()
          .describe(`Profondeur par côté (défaut ${DEFAULT_DOM_DEPTH}, max ${MAX_DOM_DEPTH}).`),
        connectionId: z.string().min(1).optional().describe("Connexion à utiliser si l'instrument existe sur plusieurs."),
      },
    },
    async (args) => {
      try {
        const dom = await ctx.client.getDom(args.symbolId, {
          depth: args.depth ?? DEFAULT_DOM_DEPTH,
          connectionId: args.connectionId,
        });
        return jsonResult({ ...dom, bidLevels: dom.bids.length, askLevels: dom.asks.length });
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
