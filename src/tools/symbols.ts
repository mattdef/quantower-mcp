import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { jsonResult, toToolError } from "../errors.js";
import type { ToolContext } from "./index.js";

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 500;

/** quantower_search_symbols — recherche d'instruments (plan §4.1, Core.Symbols). */
export function registerSymbolTools(server: McpServer, ctx: ToolContext): string[] {
  const toolName = "quantower_search_symbols";

  server.registerTool(
    toolName,
    {
      title: "Rechercher des instruments",
      description:
        "Recherche des instruments Quantower par texte (nom/code, insensible à la casse). " +
        "Renvoie symbolId, connectionId, tickSize, lotStep, minLot/maxLot. " +
        "Utilisez ensuite quantower_get_quote / quantower_get_history avec le symbolId exact.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().min(1).describe("Texte recherché, ex. « EUR », « BTC », « AAPL »."),
        connectionId: z.string().min(1).optional().describe("Restreint la recherche à une connexion."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_SEARCH_LIMIT)
          .optional()
          .describe(`Nombre maximum de résultats (défaut ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`),
      },
    },
    async (args) => {
      try {
        const symbols = await ctx.client.searchSymbols({
          query: args.query,
          connectionId: args.connectionId,
          limit: args.limit ?? DEFAULT_SEARCH_LIMIT,
        });
        return jsonResult({ count: symbols.length, symbols });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  ctx.logger.debug(`Tool enregistré : ${toolName}`);
  return [toolName];
}
