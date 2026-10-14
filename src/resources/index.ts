/**
 * Ressources MCP (plan §4.3).
 *
 * Snapshots JSON relus à chaque lecture ; le bridge reste la source de vérité.
 * Les notifications `notifications/resources/updated` sont hors scope v1 (WS = phase 4+/v2).
 */

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { toRpcError } from "../errors.js";
import { safeDecodeURIComponent } from "../tools/helpers.js";
import type { ToolContext } from "../tools/index.js";

const JSON_MIME = "application/json";

function jsonContents(uri: URL, data: unknown) {
  return {
    contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(data, null, 2) }],
  };
}

export function registerAllResources(server: McpServer, ctx: ToolContext): string[] {
  const uris = [
    "quantower://connections",
    "quantower://accounts",
    "quantower://positions",
    "quantower://orders",
    "quantower://symbols/{connectionId}/{symbolId}",
  ];

  server.registerResource(
    "quantower-connections",
    "quantower://connections",
    {
      title: "Connexions Quantower",
      description: "Snapshot JSON des connexions actives (connectionId, nom, état).",
      mimeType: JSON_MIME,
    },
    async (uri) => {
      try {
        return jsonContents(uri, await ctx.client.getConnections());
      } catch (error) {
        throw toRpcError(error);
      }
    },
  );

  server.registerResource(
    "quantower-accounts",
    "quantower://accounts",
    {
      title: "Comptes Quantower",
      description: "Snapshot JSON des comptes (balance, devise, PnL).",
      mimeType: JSON_MIME,
    },
    async (uri) => {
      try {
        return jsonContents(uri, await ctx.client.getAccounts());
      } catch (error) {
        throw toRpcError(error);
      }
    },
  );

  server.registerResource(
    "quantower-positions",
    "quantower://positions",
    {
      title: "Positions ouvertes",
      description: "Snapshot JSON des positions ouvertes (quantité, PnL, prix d'entrée).",
      mimeType: JSON_MIME,
    },
    async (uri) => {
      try {
        return jsonContents(uri, await ctx.client.getPositions());
      } catch (error) {
        throw toRpcError(error);
      }
    },
  );

  server.registerResource(
    "quantower-orders",
    "quantower://orders",
    {
      title: "Ordres en cours",
      description: "Snapshot JSON des ordres actifs.",
      mimeType: JSON_MIME,
    },
    async (uri) => {
      try {
        return jsonContents(uri, await ctx.client.getOrders());
      } catch (error) {
        throw toRpcError(error);
      }
    },
  );

  server.registerResource(
    "quantower-symbol",
    new ResourceTemplate("quantower://symbols/{connectionId}/{symbolId}", { list: undefined }),
    {
      title: "Instrument et cours",
      description: "Cours courant d'un instrument pour une connexion donnée (Bid/Ask/Last).",
      mimeType: JSON_MIME,
    },
    async (uri, variables) => {
      try {
        const connectionId = safeDecodeURIComponent(String(variables.connectionId ?? ""));
        const symbolId = safeDecodeURIComponent(String(variables.symbolId ?? ""));
        const quote = await ctx.client.getQuote(symbolId, connectionId === "" ? undefined : connectionId);
        return jsonContents(uri, { connectionId: connectionId === "" ? undefined : connectionId, symbolId, quote });
      } catch (error) {
        throw toRpcError(error);
      }
    },
  );

  for (const uri of uris) {
    ctx.logger.debug(`Resource enregistrée : ${uri}`);
  }
  return uris;
}
