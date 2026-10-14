import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { jsonResult, toToolError } from "../errors.js";
import type { ToolContext } from "./index.js";

/** quantower_list_connections — connexions broker/data feed et leur état (plan §4.1). */
export function registerConnectionTools(server: McpServer, ctx: ToolContext): string[] {
  const toolName = "quantower_list_connections";

  server.registerTool(
    toolName,
    {
      title: "Lister les connexions Quantower",
      description:
        "Liste les connexions actives de Quantower (brokers / flux de données) avec leur connectionId. " +
        "Le connectionId est requis ou utile pour la plupart des autres tools (multi-connexion, plan §1.1).",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      try {
        const connections = await ctx.client.getConnections();
        return jsonResult({ count: connections.length, connections });
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  ctx.logger.debug(`Tool enregistré : ${toolName}`);
  return [toolName];
}
