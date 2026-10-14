import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { QuantowerError, jsonResult, textResult, toToolError } from "../errors.js";
import type { PlaceOrderPayload, TradingOperationResult } from "../bridge-types.js";
import { assertConfirmed, assertOrderWithinLimits, assertQuantityWithinLimit, assertTradingEnabled } from "./trading-guards.js";
import { requireAtLeastOneFilter } from "./helpers.js";
import type { ToolContext } from "./index.js";

/** Tools d'écriture « ordres » : place / modify / cancel / cancel_all (plan §4.2 et §4.5). */
export function registerOrderTools(server: McpServer, ctx: ToolContext): string[] {
  const names = [
    "quantower_place_order",
    "quantower_modify_order",
    "quantower_cancel_order",
    "quantower_cancel_all_orders",
  ];

  server.registerTool(
    "quantower_place_order",
    {
      title: "Passer un ordre",
      description:
        "Passe un ordre réel sur Quantower (Market / Limit / Stop / StopLimit) avec SL/TP optionnels. " +
        "Garde-fous : confirm: true obligatoire, plafonds QUANTOWER_MAX_ORDER_QUANTITY / QUANTOWER_MAX_NOTIONAL, " +
        "ordres Market éventuellement interdits (QUANTOWER_DENY_MARKET_ORDERS). " +
        "À utiliser EXCLUSIVEMENT sur un compte démo / Trading Simulator pendant le développement.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Doit valoir true. Preuve de validation explicite des paramètres par l'utilisateur ; " +
              "sinon l'appel est refusé (CONFIRMATION_REQUIRED).",
          ),
        accountId: z.string().min(1).describe("Compte cible (voir quantower_list_accounts)."),
        symbolId: z.string().min(1).describe("Instrument (Symbol.Name, ex. EUR/USD)."),
        side: z.enum(["buy", "sell"]).describe("Sens de l'ordre."),
        orderType: z.enum(["market", "limit", "stop", "stop_limit"]).describe("Type d'ordre Quantower."),
        quantity: z.number().positive().describe("Quantité en lots (respecte lotStep/minLot du symbole)."),
        price: z.number().positive().optional().describe("Prix limite (requis pour limit et stop_limit)."),
        triggerPrice: z.number().positive().optional().describe("Prix déclencheur (requis pour stop et stop_limit)."),
        timeInForce: z.enum(["day", "gtc", "gtd", "ioc", "fok"]).optional().describe("Durée de vie (défaut plateforme)."),
        connectionId: z.string().min(1).optional().describe("Obligatoire si l'instrument existe sur plusieurs connexions."),
        stopLoss: protectionSchema().optional().describe("Stop loss : price ou offsetTicks."),
        takeProfit: protectionSchema().optional().describe("Take profit : price ou offsetTicks."),
        comment: z.string().max(200).optional().describe("Commentaire attaché à l'ordre."),
      },
    },
    async (args) => {
      try {
        assertTradingEnabled(ctx.config, "quantower_place_order");
        assertConfirmed(args.confirm, "quantower_place_order", "le placement de l'ordre");

        const payload: PlaceOrderPayload = {
          accountId: args.accountId,
          symbolId: args.symbolId,
          side: args.side,
          orderType: args.orderType,
          quantity: args.quantity,
          price: args.price,
          triggerPrice: args.triggerPrice,
          timeInForce: args.timeInForce,
          connectionId: args.connectionId,
          stopLoss: args.stopLoss,
          takeProfit: args.takeProfit,
          comment: args.comment,
        };
        validateOrderShape(payload);

        const estimate = await assertOrderWithinLimits(ctx.config, ctx.client, payload);
        ctx.logger.warn(
          `Envoi d'ordre ${payload.orderType} ${payload.side} ${payload.quantity} ${payload.symbolId} (compte ${payload.accountId})`,
        );

        const result = await ctx.client.placeOrder(payload);
        return tradingResultToTool(result, {
          action: "place_order",
          accountId: payload.accountId,
          symbolId: payload.symbolId,
          side: payload.side,
          orderType: payload.orderType,
          quantity: payload.quantity,
          price: payload.price,
          triggerPrice: payload.triggerPrice,
          ...estimate,
        });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "quantower_modify_order",
    {
      title: "Modifier un ordre en cours",
      description:
        "Modifie un ordre actif (quantité, prix, prix déclencheur, time in force). " +
        "confirm: true obligatoire. Au moins un champ de modification doit être fourni.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        confirm: z.boolean().optional().describe("Doit valoir true pour exécuter l'opération ; sinon l'appel est refusé (CONFIRMATION_REQUIRED)."),
        orderId: z.string().min(1).describe("Identifiant de l'ordre (voir quantower_get_orders)."),
        quantity: z.number().positive().optional().describe("Nouvelle quantité."),
        price: z.number().positive().optional().describe("Nouveau prix limite."),
        triggerPrice: z.number().positive().optional().describe("Nouveau prix déclencheur."),
        timeInForce: z.enum(["day", "gtc", "gtd", "ioc", "fok"]).optional().describe("Nouvelle durée de vie."),
      },
    },
    async (args) => {
      try {
        assertTradingEnabled(ctx.config, "quantower_modify_order");
        assertConfirmed(args.confirm, "quantower_modify_order", "la modification de l'ordre");

        const changes = {
          quantity: args.quantity,
          price: args.price,
          triggerPrice: args.triggerPrice,
          timeInForce: args.timeInForce,
        };
        if (Object.values(changes).every((value) => value === undefined)) {
          throw new QuantowerError(
            "VALIDATION_ERROR",
            "Aucune modification fournie : renseignez au moins quantity, price, triggerPrice ou timeInForce.",
          );
        }

        // Même plafond que le placement : refus avant tout appel réseau (plan §4.5).
        if (args.quantity !== undefined) {
          assertQuantityWithinLimit(ctx.config, args.quantity);
        }

        const result = await ctx.client.modifyOrder(args.orderId, changes);
        return tradingResultToTool(result, { action: "modify_order", orderId: args.orderId, changes });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "quantower_cancel_order",
    {
      title: "Annuler un ordre",
      description: "Annule un ordre actif par son orderId. confirm: true obligatoire.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: {
        confirm: z.boolean().optional().describe("Doit valoir true pour exécuter l'opération ; sinon l'appel est refusé (CONFIRMATION_REQUIRED)."),
        orderId: z.string().min(1).describe("Identifiant de l'ordre à annuler."),
      },
    },
    async (args) => {
      try {
        assertTradingEnabled(ctx.config, "quantower_cancel_order");
        assertConfirmed(args.confirm, "quantower_cancel_order", "l'annulation de l'ordre");

        const result = await ctx.client.cancelOrder(args.orderId);
        return tradingResultToTool(result, { action: "cancel_order", orderId: args.orderId });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "quantower_cancel_all_orders",
    {
      title: "Annuler tous les ordres d'un compte",
      description:
        "Annule tous les ordres actifs d'un compte et/ou d'une connexion (filtre obligatoire). " +
        "confirm: true obligatoire. Renvoie le détail des succès et des échecs.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: {
        confirm: z.boolean().optional().describe("Doit valoir true pour exécuter l'opération ; sinon l'appel est refusé (CONFIRMATION_REQUIRED)."),
        connectionId: z.string().min(1).optional().describe("Filtre connexion (obligatoire si accountId absent)."),
        accountId: z.string().min(1).optional().describe("Filtre compte (obligatoire si connectionId absent)."),
      },
    },
    async (args) => {
      try {
        assertTradingEnabled(ctx.config, "quantower_cancel_all_orders");
        assertConfirmed(args.confirm, "quantower_cancel_all_orders", "l'annulation groupée d'ordres");
        requireAtLeastOneFilter(
          [
            { name: "connectionId", value: args.connectionId },
            { name: "accountId", value: args.accountId },
          ],
          "quantower_cancel_all_orders",
        );
        ctx.logger.debug(
          `quantower_cancel_all_orders : connectionId=${args.connectionId ?? "-"} accountId=${args.accountId ?? "-"}`,
        );

        const orders = await ctx.client.getOrders({
          connectionId: args.connectionId,
          accountId: args.accountId,
        });
        const cancelled: string[] = [];
        const failed: Array<{ orderId: string; message: string }> = [];

        for (const order of orders) {
          try {
            const result = await ctx.client.cancelOrder(order.orderId);
            if (result.status === "failure") {
              failed.push({ orderId: order.orderId, message: result.message ?? "échec sans message" });
            } else {
              cancelled.push(order.orderId);
            }
          } catch (error) {
            // Une erreur sur un ordre ne doit pas interrompre l'annulation des autres.
            failed.push({ orderId: order.orderId, message: describeError(error) });
          }
        }

        const summary = { total: orders.length, cancelled: cancelled.length, failed, cancelledOrderIds: cancelled };
        if (orders.length === 0) {
          return textResult(`Aucun ordre actif à annuler.\n${JSON.stringify(summary, null, 2)}`);
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

/** Schéma SL/TP commun : prix absolu ou offset en ticks (plan §4.2). */
function protectionSchema() {
  return z
    .object({
      price: z.number().positive().optional().describe("Prix absolu de protection."),
      offsetTicks: z.number().int().describe("Offset en ticks par rapport au prix d'entrée.").optional(),
    })
    .describe("Renseignez price ou offsetTicks (au moins un).")
    .refine((value) => value.price !== undefined || value.offsetTicks !== undefined, {
      message: "Renseignez price ou offsetTicks.",
    });
}

/** Cohérence des champs requis par type d'ordre. */
function validateOrderShape(payload: PlaceOrderPayload): void {
  if ((payload.orderType === "limit" || payload.orderType === "stop_limit") && payload.price === undefined) {
    throw new QuantowerError("VALIDATION_ERROR", `orderType « ${payload.orderType} » exige un champ price.`);
  }
  if ((payload.orderType === "stop" || payload.orderType === "stop_limit") && payload.triggerPrice === undefined) {
    throw new QuantowerError("VALIDATION_ERROR", `orderType « ${payload.orderType} » exige un champ triggerPrice.`);
  }
}

/** Mapping TradingOperationResult -> résultat d'outil (plan §4.5 et §7). */
export function tradingResultToTool(
  result: TradingOperationResult,
  summary: Record<string, unknown>,
): ReturnType<typeof jsonResult> {
  if (result.status === "failure") {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `[TRADING_OPERATION_FAILED] Le broker a refusé l'opération : ${result.message ?? "aucun message fourni"}\n` +
            `Contexte : ${JSON.stringify(summary, null, 2)}\n` +
            `Résultat brut : ${JSON.stringify(result, null, 2)}`,
        },
      ],
      isError: true,
    };
  }
  return jsonResult({ ok: true, summary, raw: result });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
