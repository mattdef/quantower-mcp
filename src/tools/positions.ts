import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { jsonResult, textResult, toToolError } from "../errors.js";
import { assertConfirmed, assertTradingEnabled } from "./trading-guards.js";
import { requireAtLeastOneFilter } from "./helpers.js";
import { tradingResultToTool } from "./orders.js";
import type { ToolContext } from "./index.js";

/** Tools d'écriture « positions » : close / close_all (plan §4.2 et §4.5). */
export function registerPositionTools(server: McpServer, ctx: ToolContext): string[] {
  const names = ["quantower_close_position", "quantower_close_all_positions"];

  server.registerTool(
    "quantower_close_position",
    {
      title: "Fermer une position",
      description:
        "Ferme une position, totalement (sans quantity) ou partiellement (quantity ≤ quantité ouverte). " +
        "confirm: true obligatoire. À utiliser EXCLUSIVEMENT sur un compte démo / Trading Simulator en développement.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        confirm: z.boolean().optional().describe("Doit valoir true pour exécuter l'opération ; sinon l'appel est refusé (CONFIRMATION_REQUIRED)."),
        positionId: z.string().min(1).describe("Identifiant de la position (voir quantower_get_positions)."),
        quantity: z
          .number()
          .positive()
          .optional()
          .describe("Quantité à fermer ; omis = fermeture totale de la position."),
      },
    },
    async (args) => {
      try {
        assertTradingEnabled(ctx.config, "quantower_close_position");
        assertConfirmed(args.confirm, "quantower_close_position", "la fermeture de la position");

        ctx.logger.warn(
          `Fermeture de position ${args.positionId} (${args.quantity === undefined ? "totale" : `partielle ${args.quantity}`})`,
        );
        const result = await ctx.client.closePosition(args.positionId, args.quantity);
        return tradingResultToTool(result, {
          action: "close_position",
          positionId: args.positionId,
          quantity: args.quantity ?? "tout",
        });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "quantower_close_all_positions",
    {
      title: "Fermer toutes les positions d'un compte",
      description:
        "Ferme toutes les positions d'un compte et/ou d'une connexion (filtre obligatoire). " +
        "confirm: true obligatoire. Renvoie le détail des succès et des échecs.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        confirm: z.boolean().optional().describe("Doit valoir true pour exécuter l'opération ; sinon l'appel est refusé (CONFIRMATION_REQUIRED)."),
        connectionId: z.string().min(1).optional().describe("Filtre connexion (obligatoire si accountId absent)."),
        accountId: z.string().min(1).optional().describe("Filtre compte (obligatoire si connectionId absent)."),
      },
    },
    async (args) => {
      try {
        assertTradingEnabled(ctx.config, "quantower_close_all_positions");
        assertConfirmed(args.confirm, "quantower_close_all_positions", "la fermeture groupée de positions");
        requireAtLeastOneFilter(
          [
            { name: "connectionId", value: args.connectionId },
            { name: "accountId", value: args.accountId },
          ],
          "quantower_close_all_positions",
        );

        const positions = await ctx.client.getPositions({
          connectionId: args.connectionId,
          accountId: args.accountId,
        });
        const closed: Array<{ positionId: string; message?: string }> = [];
        const failed: Array<{ positionId: string; message: string }> = [];

        for (const position of positions) {
          try {
            const result = await ctx.client.closePosition(position.positionId);
            if (result.status === "failure") {
              failed.push({ positionId: position.positionId, message: result.message ?? "échec sans message" });
            } else {
              closed.push({ positionId: position.positionId, message: result.message });
            }
          } catch (error) {
            failed.push({ positionId: position.positionId, message: describeError(error) });
          }
        }

        const summary = {
          total: positions.length,
          closed: closed.length,
          failed,
          closedPositions: closed,
        };
        if (positions.length === 0) {
          return textResult(`Aucune position ouverte à fermer.\n${JSON.stringify(summary, null, 2)}`);
        }
        return jsonResult(summary);
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
