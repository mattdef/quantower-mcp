import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { jsonResult, toToolError } from "../errors.js";
import type { ConnectionInfo } from "../bridge-types.js";
import type { ToolContext } from "./index.js";

/** quantower_status — santé du bridge + version plateforme + connexions actives (plan §4.1). */
export function registerStatusTools(server: McpServer, ctx: ToolContext): string[] {
  const toolName = "quantower_status";

  server.registerTool(
    toolName,
    {
      title: "État du bridge Quantower",
      description:
        "Vérifie que le bridge QuantowerMcpBridge répond, renvoie la version de la plateforme, " +
        "le mode du serveur MCP (read_only ou trading) et la liste des connexions actives. " +
        "À appeler en premier pour diagnostiquer un problème de connexion.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const health = await ctx.client.getHealth();
        let connections: ConnectionInfo[] = [];
        try {
          connections = await ctx.client.getConnections();
        } catch (error) {
          // Le bridge répond mais /connections échoue : on renvoie quand même l'état.
          ctx.logger.warn(`quantower_status : /connections en échec (${String(error)})`);
        }
        return jsonResult({
          mcp: {
            mode: ctx.config.trading.enabled ? "trading" : "read_only",
            readOnlyForced: ctx.config.trading.readOnlyForced,
            limits: {
              maxOrderQuantity: ctx.config.trading.maxOrderQuantity,
              maxNotional: ctx.config.trading.maxNotional,
              denyMarketOrders: ctx.config.trading.denyMarketOrders,
            },
            bridgeUrl: ctx.config.bridge.url,
          },
          bridge: health,
          connections,
        });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  ctx.logger.debug(`Tool enregistré : ${toolName}`);
  return [toolName];
}
