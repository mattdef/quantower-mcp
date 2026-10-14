import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { jsonResult, toToolError } from "../errors.js";
import type { ToolContext } from "./index.js";

/** quantower_list_accounts — comptes, balances, PnL (plan §4.1, Core.Accounts). */
export function registerAccountTools(server: McpServer, ctx: ToolContext): string[] {
  const toolName = "quantower_list_accounts";

  server.registerTool(
    toolName,
    {
      title: "Lister les comptes Quantower",
      description:
        "Liste les comptes Quantower (accountId, connectionId, balance, devise, PnL). " +
        "Filtrable par connectionId. À utiliser uniquement avec des comptes démo pendant le développement.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        connectionId: z.string().min(1).optional().describe("Filtre sur une connexion (voir quantower_list_connections)."),
      },
    },
    async (args) => {
      try {
        const accounts = await ctx.client.getAccounts({ connectionId: args.connectionId });
        return jsonResult({ count: accounts.length, accounts });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  ctx.logger.debug(`Tool enregistré : ${toolName}`);
  return [toolName];
}
