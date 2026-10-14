import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { QuantowerClient } from "../src/quantower-client.js";
import { startMockBridge, type FakeBridgeHandle } from "./helpers/mock-bridge.js";

const openBridges: FakeBridgeHandle[] = [];

afterEach(async () => {
  while (openBridges.length > 0) {
    const bridge = openBridges.pop();
    if (bridge !== undefined) {
      await bridge.close();
    }
  }
});

async function startBridge(): Promise<FakeBridgeHandle> {
  const bridge = await startMockBridge();
  openBridges.push(bridge);
  return bridge;
}

function createClient(
  bridge: FakeBridgeHandle,
  overrides: Partial<ReturnType<typeof loadConfig>["bridge"]> = {},
): QuantowerClient {
  const config = loadConfig({
    QUANTOWER_BRIDGE_URL: bridge.url,
    QUANTOWER_BRIDGE_TOKEN: bridge.token,
    QUANTOWER_BRIDGE_TIMEOUT_MS: "2000",
    QUANTOWER_CACHE_TTL_MS: "0",
    QUANTOWER_RETRY_COUNT: "2",
    QUANTOWER_LOG_LEVEL: "error",
  });
  return new QuantowerClient({ bridge: { ...config.bridge, ...overrides }, logger: createLogger("error") });
}

function requestsFor(bridge: FakeBridgeHandle, method: string, pathPrefix: string) {
  return bridge.requests.filter(
    (request) => request.method === method && request.url.startsWith(pathPrefix),
  );
}

describe("QuantowerClient — lecture", () => {
  it("relit les fixtures du contrat (anti-dérive des DTOs)", async () => {
    const bridge = await startBridge();
    const client = createClient(bridge);

    const connections = await client.getConnections();
    expect(connections).toEqual([
      { connectionId: "SIM-1", name: "Quantower Trading Simulator", status: "connected", type: "simulator" },
    ]);

    const accounts = await client.getAccounts();
    expect(accounts[0]?.accountId).toBe("ACC-DEMO-USD");
    expect(accounts[0]?.balance).toBe(100000);
    expect(accounts[0]?.currency).toBe("USD");

    const symbols = await client.searchSymbols({ query: "eur" });
    expect(symbols.map((symbol) => symbol.symbolId)).toEqual(["EUR/USD"]);
  });

  it("encode les symbolId contenant des caractères spéciaux dans l'URL", async () => {
    const bridge = await startBridge();
    const client = createClient(bridge);

    const quote = await client.getQuote("EUR/USD");
    expect(quote.symbolId).toBe("EUR/USD");
    expect(quote.bid).toBe(1.08425);
    expect(requestsFor(bridge, "GET", "/symbols/EUR%2FUSD/quote")).toHaveLength(1);
  });

  it("renvoie l'historique et le DOM", async () => {
    const bridge = await startBridge();
    const client = createClient(bridge);

    const history = await client.getHistory({ symbolId: "EUR/USD", timeframe: "1h", limit: 5 });
    expect(history.bars).toHaveLength(5);
    expect(history.timeframe).toBe("1h");

    const dom = await client.getDom("EUR/USD", { depth: 2 });
    expect(dom.bids).toHaveLength(2);
    expect(dom.asks).toHaveLength(2);
  });

  it("retourne NOT_FOUND avec les détails pour un instrument inconnu", async () => {
    const bridge = await startBridge();
    const client = createClient(bridge);

    await expect(client.getQuote("INCONNU/XXX")).rejects.toMatchObject({
      code: "NOT_FOUND",
      details: { symbolId: "INCONNU/XXX" },
    });
  });
});

describe("QuantowerClient — erreurs transport", () => {
  it("mappe un 401 en BRIDGE_UNAUTHORIZED avec indice de token", async () => {
    const bridge = await startBridge();
    bridge.setFailMode("unauthorized");
    const client = createClient(bridge);

    const error = await client.getConnections().catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: "BRIDGE_UNAUTHORIZED" });
    expect(String((error as Error).message)).toContain("Token manquant ou invalide");
  });

  it("mappe un bridge éteint en BRIDGE_UNAVAILABLE", async () => {
    const bridge = await startBridge();
    const client = createClient(bridge, { retryCount: 0 });
    await bridge.close();

    await expect(client.getConnections()).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
  });

  it("mappe un bridge trop lent en TIMEOUT", async () => {
    const bridge = await startBridge();
    bridge.setFailMode("timeout");
    const client = createClient(bridge, { timeoutMs: 250, retryCount: 0 });

    await expect(client.getConnections()).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("rejoue les GET sur erreur 5xx (retryCount+1 tentatives)", async () => {
    const bridge = await startBridge();
    bridge.setFailMode("server-error");
    const client = createClient(bridge);

    await expect(client.getConnections()).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
    expect(requestsFor(bridge, "GET", "/connections")).toHaveLength(3);
  });

  it("ne rejoue JAMAIS une écriture (pas d'ordre en double)", async () => {
    const bridge = await startBridge();
    bridge.setFailMode("server-error");
    const client = createClient(bridge);

    await expect(
      client.placeOrder({
        accountId: "ACC-DEMO-USD",
        symbolId: "EUR/USD",
        side: "buy",
        orderType: "limit",
        quantity: 0.01,
        price: 1.07,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
    expect(requestsFor(bridge, "POST", "/orders")).toHaveLength(1);
  });
});

describe("QuantowerClient — cache TTL", () => {
  it("sert une seconde lecture depuis le cache puis invalide après écriture", async () => {
    const bridge = await startBridge();
    const client = createClient(bridge, { cacheTtlMs: 5_000 });

    await client.getConnections();
    await client.getConnections();
    expect(requestsFor(bridge, "GET", "/connections")).toHaveLength(1);

    await client.cancelOrder("ORD-1001");
    await client.getConnections();
    expect(requestsFor(bridge, "GET", "/connections")).toHaveLength(2);
  });
});

describe("QuantowerClient — écriture", () => {
  it("renvoie le TradingOperationResult de succès avec l'orderId", async () => {
    const bridge = await startBridge();
    const client = createClient(bridge);

    const result = await client.placeOrder({
      accountId: "ACC-DEMO-USD",
      symbolId: "EUR/USD",
      side: "buy",
      orderType: "limit",
      quantity: 0.1,
      price: 1.07,
    });
    expect(result.status).toBe("success");
    expect(result.orderId).toMatch(/^ORD-\d+$/);
  });

  it("conserve le message broker brut en cas de Failure (pas d'exception)", async () => {
    const bridge = await startBridge();
    const client = createClient(bridge);

    const result = await client.placeOrder({
      accountId: "ACC-REJECT",
      symbolId: "EUR/USD",
      side: "buy",
      orderType: "market",
      quantity: 0.1,
    });
    expect(result.status).toBe("failure");
    expect(result.message).toContain("Rejected by broker");
  });

  it("propage INVALID_STATE sur une double annulation", async () => {
    const bridge = await startBridge();
    const client = createClient(bridge);

    await expect(client.cancelOrder("ORD-1001")).resolves.toMatchObject({ status: "success" });
    await expect(client.cancelOrder("ORD-1001")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});
