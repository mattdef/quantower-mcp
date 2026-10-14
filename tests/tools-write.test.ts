import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness, type HarnessOptions } from "./helpers/harness.js";

const openHarnesses: Harness[] = [];

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop();
    if (harness !== undefined) {
      await harness.close();
    }
  }
});

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const created = await createHarness({ trading: true, ...options });
  openHarnesses.push(created);
  return created;
}

function postOrders(h: Harness) {
  return h.bridge.requests.filter((request) => request.method === "POST" && request.url.startsWith("/orders"));
}

const BASE_ORDER = {
  confirm: true,
  accountId: "ACC-DEMO-USD",
  symbolId: "EUR/USD",
  side: "buy",
  orderType: "limit",
  quantity: 0.1,
  price: 1.07,
};

describe("Tools d'écriture — enregistrement conditionnel", () => {
  it("enregistre les tools d'écriture quand QUANTOWER_TRADING_ENABLED=true", async () => {
    const h = await harness();
    const names = await h.toolNames();
    expect(names).toContain("quantower_place_order");
    expect(names).toContain("quantower_modify_order");
    expect(names).toContain("quantower_cancel_order");
    expect(names).toContain("quantower_cancel_all_orders");
    expect(names).toContain("quantower_close_position");
    expect(names).toContain("quantower_close_all_positions");
  });
});

describe("quantower_place_order — garde-fous", () => {
  it("place un ordre limit et renvoie le récapitulatif + le résultat brut", async () => {
    const h = await harness();
    const result = await h.callTool("quantower_place_order", BASE_ORDER);

    expect(result.isError).toBe(false);
    const payload = result.json as {
      ok: boolean;
      summary: { orderType: string; accountId: string; estimatedNotional?: number };
      raw: { status: string; orderId: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.summary.orderType).toBe("limit");
    expect(payload.summary.accountId).toBe("ACC-DEMO-USD");
    expect(payload.raw.status).toBe("success");
    expect(payload.raw.orderId).toMatch(/^ORD-\d+$/);

    const sent = postOrders(h);
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body as Record<string, unknown>;
    expect(body.symbolId).toBe("EUR/USD");
    expect(body.quantity).toBe(0.1);
    expect(body.price).toBe(1.07);
    // Le champ de garde-fou MCP ne doit jamais être transmis au bridge.
    expect(body.confirm).toBeUndefined();
  });

  it("refuse l'ordre sans confirm: true et n'appelle PAS le bridge", async () => {
    const h = await harness();
    const withoutConfirm = { ...BASE_ORDER } as Record<string, unknown>;
    delete withoutConfirm.confirm;

    const result = await h.callTool("quantower_place_order", withoutConfirm);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[CONFIRMATION_REQUIRED]");
    expect(result.text).toContain("confirm: true");
    expect(postOrders(h)).toHaveLength(0);
  });

  it("refuse confirm: false", async () => {
    const h = await harness();
    const result = await h.callTool("quantower_place_order", { ...BASE_ORDER, confirm: false });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[CONFIRMATION_REQUIRED]");
    expect(postOrders(h)).toHaveLength(0);
  });

  it("refuse une quantité au-dessus du plafond QUANTOWER_MAX_ORDER_QUANTITY", async () => {
    const h = await harness({ maxOrderQuantity: 1 });
    const result = await h.callTool("quantower_place_order", { ...BASE_ORDER, quantity: 5 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[LIMIT_EXCEEDED]");
    expect(result.text).toContain("QUANTOWER_MAX_ORDER_QUANTITY=1");
    expect(postOrders(h)).toHaveLength(0);
  });

  it("refuse le notionnel au-dessus du plafond pour un ordre limit", async () => {
    // Plafond quantité volontairement large : on isole bien le contrôle de notionnel.
    const h = await harness({ maxOrderQuantity: 200, maxNotional: 10 });
    const result = await h.callTool("quantower_place_order", { ...BASE_ORDER, quantity: 100, price: 2 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[LIMIT_EXCEEDED]");
    expect(result.text).toContain("QUANTOWER_MAX_NOTIONAL=10");
    expect(postOrders(h)).toHaveLength(0);
  });

  it("contrôle le notionnel d'un ordre Market via le carnet (ask)", async () => {
    const h = await harness({ maxNotional: 5 });
    const result = await h.callTool("quantower_place_order", {
      confirm: true,
      accountId: "ACC-DEMO-USD",
      symbolId: "EUR/USD",
      side: "buy",
      orderType: "market",
      quantity: 10,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[LIMIT_EXCEEDED]");
    expect(postOrders(h)).toHaveLength(0);
  });

  it("interdit les ordres Market quand QUANTOWER_DENY_MARKET_ORDERS=true", async () => {
    const h = await harness({ denyMarketOrders: true });
    const result = await h.callTool("quantower_place_order", {
      confirm: true,
      accountId: "ACC-DEMO-USD",
      symbolId: "EUR/USD",
      side: "sell",
      orderType: "market",
      quantity: 0.1,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[LIMIT_EXCEEDED]");
    expect(result.text).toContain("QUANTOWER_DENY_MARKET_ORDERS");
    expect(postOrders(h)).toHaveLength(0);
  });

  it("refuse un ordre limit sans price et un stop sans triggerPrice", async () => {
    const h = await harness();
    const noPrice = await h.callTool("quantower_place_order", { ...BASE_ORDER, price: undefined });
    expect(noPrice.isError).toBe(true);
    expect(noPrice.text).toContain("[VALIDATION_ERROR]");

    const stopNoTrigger = await h.callTool("quantower_place_order", {
      confirm: true,
      accountId: "ACC-DEMO-USD",
      symbolId: "EUR/USD",
      side: "sell",
      orderType: "stop",
      quantity: 0.1,
    });
    expect(stopNoTrigger.isError).toBe(true);
    expect(stopNoTrigger.text).toContain("[VALIDATION_ERROR]");
    expect(postOrders(h)).toHaveLength(0);
  });

  it("remonte l'échec broker (TradingOperationResult Failure) en isError avec le message brut", async () => {
    const h = await harness();
    const result = await h.callTool("quantower_place_order", {
      confirm: true,
      accountId: "ACC-REJECT",
      symbolId: "EUR/USD",
      side: "buy",
      orderType: "market",
      quantity: 0.1,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[TRADING_OPERATION_FAILED]");
    expect(result.text).toContain("Rejected by broker");
  });
});

describe("quantower_modify_order / quantower_cancel_order", () => {
  it("modifie un ordre actif", async () => {
    const h = await harness();
    const result = await h.callTool("quantower_modify_order", {
      confirm: true,
      orderId: "ORD-1001",
      quantity: 0.5,
    });
    expect(result.isError).toBe(false);
    expect((result.json as { raw: { status: string } }).raw.status).toBe("success");
  });

  it("refuse une modification sans aucun champ", async () => {
    const h = await harness();
    const result = await h.callTool("quantower_modify_order", { confirm: true, orderId: "ORD-1001" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[VALIDATION_ERROR]");
  });

  it("refuse une modification au-dessus du plafond", async () => {
    const h = await harness({ maxOrderQuantity: 1 });
    const result = await h.callTool("quantower_modify_order", {
      confirm: true,
      orderId: "ORD-1001",
      quantity: 5000,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[LIMIT_EXCEEDED]");
    expect(result.text).toContain("QUANTOWER_MAX_ORDER_QUANTITY=1");
    // Le refus doit intervenir avant tout appel réseau au bridge.
    expect(h.bridge.requests.filter((request) => request.method === "PATCH")).toHaveLength(0);
  });

  it("annule un ordre puis détecte la double annulation en INVALID_STATE", async () => {
    const h = await harness();

    const first = await h.callTool("quantower_cancel_order", { confirm: true, orderId: "ORD-1001" });
    expect(first.isError).toBe(false);

    const second = await h.callTool("quantower_cancel_order", { confirm: true, orderId: "ORD-1001" });
    expect(second.isError).toBe(true);
    expect(second.text).toContain("[INVALID_STATE]");
  });

  it("renvoie NOT_FOUND pour un ordre inconnu", async () => {
    const h = await harness();
    const result = await h.callTool("quantower_cancel_order", { confirm: true, orderId: "ORD-9999" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[NOT_FOUND]");
  });
});

describe("Opérations groupées", () => {
  it("cancel_all_orders exige connectionId ou accountId", async () => {
    const h = await harness();
    const result = await h.callTool("quantower_cancel_all_orders", { confirm: true });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[VALIDATION_ERROR]");
  });

  it("cancel_all_orders annule les ordres du compte et renvoie un détail", async () => {
    const h = await harness();
    const result = await h.callTool("quantower_cancel_all_orders", { confirm: true, accountId: "ACC-DEMO-USD" });
    const payload = result.json as { total: number; cancelled: number; failed: unknown[] };
    expect(result.isError).toBe(false);
    expect(payload.total).toBe(1);
    expect(payload.cancelled).toBe(1);
    expect(payload.failed).toHaveLength(0);
  });

  it("close_all_positions exige un filtre puis ferme les positions du compte", async () => {
    const h = await harness();
    const missingFilter = await h.callTool("quantower_close_all_positions", { confirm: true });
    expect(missingFilter.isError).toBe(true);

    const result = await h.callTool("quantower_close_all_positions", { confirm: true, accountId: "ACC-DEMO-USD" });
    const payload = result.json as { total: number; closed: number };
    expect(payload.total).toBe(1);
    expect(payload.closed).toBe(1);
  });
});

describe("quantower_close_position", () => {
  it("ferme une position partiellement puis totalement", async () => {
    const h = await harness();

    const partial = await h.callTool("quantower_close_position", {
      confirm: true,
      positionId: "POS-1",
      quantity: 0.2,
    });
    expect(partial.isError).toBe(false);

    const total = await h.callTool("quantower_close_position", { confirm: true, positionId: "POS-1" });
    expect(total.isError).toBe(false);

    const positions = await h.callTool("quantower_get_positions");
    expect((positions.json as { count: number }).count).toBe(0);
  });

  it("refuse une quantité supérieure à la position ouverte", async () => {
    const h = await harness();
    const result = await h.callTool("quantower_close_position", {
      confirm: true,
      positionId: "POS-1",
      quantity: 5,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[VALIDATION_ERROR]");
  });

  it("renvoie NOT_FOUND pour une position inconnue", async () => {
    const h = await harness();
    const result = await h.callTool("quantower_close_position", { confirm: true, positionId: "POS-999" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[NOT_FOUND]");
  });
});
