import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "./helpers/harness.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

describe("Resources MCP", () => {
  it("expose les ressources de snapshot du plan §4.3", async () => {
    const result = await h.client.listResources();
    const uris = result.resources.map((resource) => resource.uri);
    expect(uris).toContain("quantower://connections");
    expect(uris).toContain("quantower://accounts");
    expect(uris).toContain("quantower://positions");
    expect(uris).toContain("quantower://orders");
  });

  it("quantower://accounts renvoie le JSON des comptes", async () => {
    const text = await h.readResource("quantower://accounts");
    const accounts = JSON.parse(text) as Array<{ accountId: string; balance: number }>;
    expect(accounts[0]?.accountId).toBe("ACC-DEMO-USD");
    expect(accounts[0]?.balance).toBe(100000);
  });

  it("quantower://positions renvoie le JSON des positions", async () => {
    const text = await h.readResource("quantower://positions");
    const positions = JSON.parse(text) as Array<{ positionId: string; symbolId: string }>;
    expect(positions[0]?.positionId).toBe("POS-1");
    expect(positions[0]?.symbolId).toBe("EUR/USD");
  });

  it("quantower://symbols/{connectionId}/{symbolId} résout un symbole simple", async () => {
    const text = await h.readResource("quantower://symbols/SIM-1/AAPL");
    const payload = JSON.parse(text) as { symbolId: string; connectionId: string; quote: { last: number } };
    expect(payload.symbolId).toBe("AAPL");
    expect(payload.connectionId).toBe("SIM-1");
    expect(payload.quote.last).toBe(231.18);
  });

  it("quantower://symbols/{connectionId}/{symbolId} accepte un symbolId encodé (EUR%2FUSD)", async () => {
    const text = await h.readResource("quantower://symbols/SIM-1/EUR%2FUSD");
    const payload = JSON.parse(text) as { symbolId: string };
    expect(payload.symbolId).toBe("EUR/USD");
  });

  it("échoue proprement quand le bridge est indisponible", async () => {
    await h.bridge.close();
    await expect(h.readResource("quantower://accounts")).rejects.toThrowError(/BRIDGE_UNAVAILABLE/);
  });
});

describe("Prompts MCP", () => {
  it("expose les trois prompts du plan §4.4", async () => {
    const result = await h.client.listPrompts();
    const names = result.prompts.map((prompt) => prompt.name);
    expect(names).toContain("briefing-marche");
    expect(names).toContain("revue-positions");
    expect(names).toContain("checklist-avant-ordre");
  });

  it("briefing-marche cite les tools de lecture et le symbole demandé", async () => {
    const text = await h.getPrompt("briefing-marche", { symbol: "EUR/USD" });
    expect(text).toContain("quantower_status");
    expect(text).toContain("quantower_get_positions");
    expect(text).toContain("EUR/USD");
  });

  it("revue-positions rappelle le mode read_only par défaut", async () => {
    const text = await h.getPrompt("revue-positions");
    expect(text).toContain("read_only");
    expect(text).toContain("quantower_get_positions");
  });

  it("checklist-avant-ordre rappelle confirm: true et les plafonds", async () => {
    const text = await h.getPrompt("checklist-avant-ordre", { symbolId: "EUR/USD", side: "buy" });
    expect(text).toContain("confirm: true");
    expect(text).toContain("QUANTOWER_MAX_ORDER_QUANTITY");
    expect(text).toContain("QUANTOWER_TRADING_ENABLED");
    expect(text).toContain("DÉMO");
  });
});
