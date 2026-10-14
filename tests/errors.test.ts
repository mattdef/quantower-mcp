import { describe, expect, it } from "vitest";

import {
  BridgeUnavailableError,
  QuantowerError,
  TimeoutError,
  confirmationRequiredError,
  errorFromHttpResponse,
  formatError,
  isRetryableError,
  normalizeError,
  toToolError,
  tradingDisabledError,
} from "../src/errors.js";

describe("errorFromHttpResponse", () => {
  it("mappe le code métier du bridge quand il est connu", () => {
    const error = errorFromHttpResponse(409, { error: { code: "INVALID_STATE", message: "Ordre déjà annulé" } }, "http://x");
    expect(error.code).toBe("INVALID_STATE");
    expect(error.message).toBe("Ordre déjà annulé");
  });

  it("mappe TRADING_LIMIT_EXCEEDED du bridge vers LIMIT_EXCEEDED", () => {
    const error = errorFromHttpResponse(403, { error: { code: "TRADING_LIMIT_EXCEEDED", message: "trop gros" } }, "http://x");
    expect(error.code).toBe("LIMIT_EXCEEDED");
  });

  it("retombe sur le code HTTP quand le corps est vide", () => {
    expect(errorFromHttpResponse(401, undefined, "http://x").code).toBe("BRIDGE_UNAUTHORIZED");
    expect(errorFromHttpResponse(404, undefined, "http://x").code).toBe("NOT_FOUND");
    expect(errorFromHttpResponse(400, undefined, "http://x").code).toBe("VALIDATION_ERROR");
    expect(errorFromHttpResponse(503, undefined, "http://x").code).toBe("PLATFORM_ERROR");
  });

  it("marque les erreurs 5xx comme retryables (GET uniquement côté client)", () => {
    expect(isRetryableError(errorFromHttpResponse(503, undefined, "http://x"))).toBe(true);
    expect(isRetryableError(errorFromHttpResponse(404, undefined, "http://x"))).toBe(false);
  });

  it("conserve les détails fournis par le bridge", () => {
    const error = errorFromHttpResponse(
      404,
      { error: { code: "NOT_FOUND", message: "Instrument inconnu", details: { symbolId: "XXX/YYY" } } },
      "http://x",
    );
    expect(error.details).toEqual({ symbolId: "XXX/YYY" });
  });
});

describe("erreurs typées", () => {
  it("fournit un indice actionnable pour BRIDGE_UNAVAILABLE", () => {
    const error = new BridgeUnavailableError("bridge injoignable");
    expect(error.code).toBe("BRIDGE_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(formatError(error)).toContain("Quantower est-il lancé");
  });

  it("TimeoutError est retryable", () => {
    expect(new TimeoutError("trop long").retryable).toBe(true);
  });

  it("TRADING_DISABLED explique comment activer l'écriture", () => {
    const error = tradingDisabledError("quantower_place_order");
    expect(error.code).toBe("TRADING_DISABLED");
    expect(formatError(error)).toContain("QUANTOWER_TRADING_ENABLED=true");
  });

  it("CONFIRMATION_REQUIRED demande confirm: true", () => {
    const error = confirmationRequiredError("quantower_cancel_order", "l'annulation de l'ordre");
    expect(error.code).toBe("CONFIRMATION_REQUIRED");
    expect(formatError(error)).toContain("confirm: true");
  });
});

describe("normalizeError / toToolError", () => {
  it("convertit une Error quelconque en INTERNAL_ERROR", () => {
    expect(normalizeError(new Error("boom")).code).toBe("INTERNAL_ERROR");
    expect(normalizeError("boom").code).toBe("INTERNAL_ERROR");
  });

  it("produit un résultat MCP isError avec le code et l'indice", () => {
    const result = toToolError(new QuantowerError("NOT_FOUND", "Position inconnue", { details: { positionId: "POS-9" } }));
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("[NOT_FOUND] Position inconnue");
    expect(text).toContain("Indice :");
    expect(text).toContain("POS-9");
  });
});
