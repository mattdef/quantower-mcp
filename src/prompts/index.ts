/**
 * Prompts MCP (plan §4.4).
 *
 * Les prompts sont des gabarits conversationnels : ils rappellent les tools à utiliser
 * et les garde-fous à vérifier (mode read_only, confirm, plafonds).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "../tools/index.js";

export function registerAllPrompts(server: McpServer, ctx: ToolContext): string[] {
  const names = ["briefing-marche", "revue-positions", "checklist-avant-ordre"];
  const tradingMode = ctx.config.trading.enabled ? "trading (écriture autorisée)" : "read_only (lecture seule)";

  server.registerPrompt(
    "briefing-marche",
    {
      title: "Briefing marché",
      description: "Synthèse compte + positions + cours clés à partir des tools Quantower.",
      argsSchema: {
        symbol: z.string().min(1).optional().describe("Instrument à mettre en avant (ex. EUR/USD)."),
      },
    },
    ({ symbol }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Prépare un briefing marché concis pour mon activité Quantower.",
              "",
              "1. Appelle `quantower_status` pour vérifier la connexion et le mode du serveur MCP.",
              "2. Appelle `quantower_list_accounts` puis `quantower_get_positions` pour l'état du portefeuille.",
              symbol === undefined
                ? "3. Choisis 3 instruments pertinents avec `quantower_search_symbols` et récupère leurs cours avec `quantower_get_quote`."
                : `3. Récupère le cours de ${symbol} avec \`quantower_get_quote\` (et 2 autres instruments de la même connexion).`,
              "4. Termine par : synthèse, exposition nette par instrument, et tout élément anormal (PnL, position sans stop).",
              "",
              "Rappel : ne passe aucun ordre dans ce briefing, reste en lecture.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "revue-positions",
    {
      title: "Revue des positions",
      description: "Analyse les positions ouvertes et le risque associé.",
      argsSchema: {
        accountId: z.string().min(1).optional().describe("Compte à analyser (sinon tous les comptes)."),
      },
    },
    ({ accountId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Réalise une revue de risque de mes positions ouvertes Quantower.",
              "",
              `1. \`quantower_get_positions\`${accountId === undefined ? "" : ` avec accountId=${accountId}`} puis \`quantower_get_orders\` pour les protections en place.`,
              "2. Pour chaque position : sens, taille, prix d'entrée, PnL net, distance au stop éventuel.",
              "3. Signale les positions sans stop, les tailles hors norme et les doublons d'exposition sur un même symbole.",
              "4. Propose une action par position (conserver, réduire, fermer) SANS l'exécuter : demande confirmation à l'utilisateur.",
              "",
              `Mode actuel du serveur MCP : ${tradingMode}.`,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "checklist-avant-ordre",
    {
      title: "Checklist avant ordre",
      description: "Garde-fous à valider avant d'appeler quantower_place_order.",
      argsSchema: {
        symbolId: z.string().min(1).optional().describe("Instrument envisagé."),
        side: z.enum(["buy", "sell"]).optional().describe("Sens envisagé."),
        quantity: z.number().positive().optional().describe("Quantité envisagée."),
      },
    },
    ({ symbolId, side, quantity }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Passe en revue cette checklist AVANT tout envoi d'ordre :",
              "",
              `- Mode serveur MCP : ${tradingMode}. Si le mode est read_only, arrête et explique comment l'activer (QUANTOWER_TRADING_ENABLED=true).`,
              "- Compte cible : vérifie avec `quantower_list_accounts` qu'il s'agit d'un compte DÉMO / Trading Simulator.",
              symbolId === undefined
                ? "- Instrument : confirme le symbolId exact avec `quantower_search_symbols` et le cours avec `quantower_get_quote`."
                : `- Instrument : confirme ${symbolId} avec \`quantower_get_quote\` (bid/ask, tickSize).`,
              side === undefined ? "- Sens : buy ou sell ?" : `- Sens envisagé : ${side}.`,
              quantity === undefined
                ? "- Taille : compare au lotStep/minLot et aux plafonds QUANTOWER_MAX_ORDER_QUANTITY / QUANTOWER_MAX_NOTIONAL."
                : `- Taille : ${quantity} — vérifie lotStep/minLot et les plafonds QUANTOWER_MAX_ORDER_QUANTITY / QUANTOWER_MAX_NOTIONAL.`,
              "- Type d'ordre : Market interdit si QUANTOWER_DENY_MARKET_ORDERS=true ; limit/stop exigent price/triggerPrice.",
              "- SL/TP : précisés en price ou offsetTicks.",
              "- Confirmation : l'appel final doit porter `confirm: true` ET avoir été validé explicitement par l'utilisateur (récapitulatif chiffré avant envoi).",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  for (const name of names) {
    ctx.logger.debug(`Prompt enregistré : ${name}`);
  }
  return names;
}
