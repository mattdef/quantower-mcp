import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "./helpers/harness.js";

const READ_TOOLS = [
  "quantower_status",
  "quantower_list_connections",
  "quantower_list_accounts",
  "quantower_search_symbols",
  "quantower_get_quote",
  "quantower_get_history",
  "quantower_get_dom",
  "quantower_get_positions",
  "quantower_get_orders",
  "quantower_get_orders_history",
  "quantower_get_trades",
];

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

describe("Tools de lecture — enregistrement", () => {
  it("enregistre les tools de lecture et AUCUN tool d'écriture en mode read_only", async () => {
    const names = await h.toolNames();
    for (const name of READ_TOOLS) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("quantower_place_order");
    expect(names).not.toContain("quantower_modify_order");
    expect(names).not.toContain("quantower_cancel_order");
    expect(names).not.toContain("quantower_close_position");
    expect(names).not.toContain("quantower_cancel_all_orders");
    expect(names).not.toContain("quantower_close_all_positions");
  });
});

describe("Tools de lecture — happy paths", () => {
  it("quantower_status renvoie le bridge, le mode read_only et les connexions", async () => {
    const result = await h.callTool("quantower_status");
    expect(result.isError).toBe(false);

    const payload = result.json as {
      mcp: { mode: string; limits: { maxOrderQuantity: number } };
      bridge: { status: string; connectionCount: number };
      connections: unknown[];
    };
    expect(payload.mcp.mode).toBe("read_only");
    expect(payload.mcp.limits.maxOrderQuantity).toBe(50);
    expect(payload.bridge.status).toBe("ok");
    expect(payload.bridge.connectionCount).toBe(1);
    expect(payload.connections).toHaveLength(1);
  });

  it("quantower_list_connections et quantower_list_accounts renvoient les fixtures", async () => {
    const connections = await h.callTool("quantower_list_connections");
    expect((connections.json as { count: number }).count).toBe(1);

    const accounts = await h.callTool("quantower_list_accounts");
    const payload = accounts.json as { count: number; accounts: Array<{ accountId: string; balance: number }> };
    expect(payload.count).toBe(1);
    expect(payload.accounts[0]?.accountId).toBe("ACC-DEMO-USD");
    expect(payload.accounts[0]?.balance).toBe(100000);
  });

  it("quantower_search_symbols filtre par texte", async () => {
    const result = await h.callTool("quantower_search_symbols", { query: "btc" });
    const payload = result.json as { symbols: Array<{ symbolId: string }> };
    expect(payload.symbols.map((symbol) => symbol.symbolId)).toEqual(["BTC/USD"]);
  });

  it("quantower_get_quote renvoie bid/ask/last", async () => {
    const result = await h.callTool("quantower_get_quote", { symbolId: "EUR/USD" });
    const quote = result.json as { symbolId: string; bid: number; ask: number; last: number };
    expect(quote.symbolId).toBe("EUR/USD");
    expect(quote.bid).toBe(1.08425);
    expect(quote.ask).toBe(1.08435);
  });

  it("quantower_get_history renvoie les bougies demandées", async () => {
    const result = await h.callTool("quantower_get_history", { symbolId: "EUR/USD", timeframe: "1h", limit: 3 });
    const payload = result.json as { count: number; bars: Array<{ close: number }> };
    expect(payload.count).toBe(3);
    expect(payload.bars).toHaveLength(3);
  });

  it("quantower_get_dom renvoie les niveaux bid/ask", async () => {
    const result = await h.callTool("quantower_get_dom", { symbolId: "EUR/USD", depth: 2 });
    const payload = result.json as { bids: unknown[]; asks: unknown[]; bidLevels: number };
    expect(payload.bids).toHaveLength(2);
    expect(payload.asks).toHaveLength(2);
    expect(payload.bidLevels).toBe(2);
  });

  it("quantower_get_positions / _get_orders / _get_trades / _get_orders_history répondent", async () => {
    const positions = await h.callTool("quantower_get_positions", { accountId: "ACC-DEMO-USD" });
    expect((positions.json as { count: number }).count).toBe(1);

    const orders = await h.callTool("quantower_get_orders");
    expect((orders.json as { count: number }).count).toBe(1);

    const trades = await h.callTool("quantower_get_trades", { limit: 1 });
    expect((trades.json as { count: number }).count).toBe(1);

    const history = await h.callTool("quantower_get_orders_history", { limit: 10 });
    expect((history.json as { count: number }).count).toBe(2);
  });
});

describe("Tools de lecture — cas limites", () => {
  it("renvoie une erreur NOT_FOUND explicite pour un instrument inconnu", async () => {
    const result = await h.callTool("quantower_get_quote", { symbolId: "INCONNU/XXX" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[NOT_FOUND]");
    expect(result.text).toContain("INCONNU/XXX");
  });

  it("refuse une plage historique inversée (from > to)", async () => {
    const result = await h.callTool("quantower_get_history", {
      symbolId: "EUR/USD",
      timeframe: "1h",
      from: "2026-10-13T00:00:00Z",
      to: "2026-10-01T00:00:00Z",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[VALIDATION_ERROR]");
  });

  it("refuse une date non ISO 8601", async () => {
    const result = await h.callTool("quantower_get_orders_history", { from: "hier" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[VALIDATION_ERROR]");
  });

  it("refuse un limit d'historique au-dessus de QUANTOWER_MAX_BARS", async () => {
    const result = await h.callTool("quantower_get_history", { symbolId: "EUR/USD", timeframe: "1h", limit: 501 });
    expect(result.isError).toBe(true);
  });
});

describe("Tools de lecture — bridge indisponible", () => {
  it("quantower_status renvoie BRIDGE_UNAVAILABLE avec l'indice Quantower", async () => {
    await h.bridge.close();
    const result = await h.callTool("quantower_status");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[BRIDGE_UNAVAILABLE]");
    expect(result.text).toContain("Quantower est-il lancé");
  });

  it("les autres tools remontent aussi BRIDGE_UNAVAILABLE", async () => {
    await h.bridge.close();
    const result = await h.callTool("quantower_list_accounts");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[BRIDGE_UNAVAILABLE]");
  });
});
