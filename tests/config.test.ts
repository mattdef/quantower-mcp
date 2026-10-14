import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultDataDir, loadConfig, readBridgeToken } from "../src/config.js";
import { ConfigError } from "../src/errors.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("loadConfig — valeurs par défaut sûres", () => {
  it("est en lecture seule par défaut, sur le bridge local", () => {
    const config = loadConfig({});

    expect(config.trading.enabled).toBe(false);
    expect(config.trading.readOnlyForced).toBe(false);
    expect(config.bridge.url).toBe("http://127.0.0.1:8765");
    expect(config.bridge.timeoutMs).toBe(15_000);
    expect(config.bridge.retryCount).toBe(2);
    expect(config.bridge.cacheTtlMs).toBe(1_000);
    expect(config.trading.maxOrderQuantity).toBe(50);
    expect(config.trading.maxNotional).toBe(50_000);
    expect(config.trading.denyMarketOrders).toBe(false);
    expect(config.read.maxBars).toBe(500);
    expect(config.logLevel).toBe("info");
  });

  it("résout le fichier de token par défaut dans le profil utilisateur", () => {
    const config = loadConfig({ LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" });
    expect(config.bridge.tokenFile).toBe(join("C:\\Users\\test\\AppData\\Local", "quantower-mcp", "bridge-token"));
    expect(defaultDataDir({ LOCALAPPDATA: "C:\\Temp" })).toBe(join("C:\\Temp", "quantower-mcp"));
  });
});

describe("loadConfig — activation du trading", () => {
  it("active l'écriture uniquement avec QUANTOWER_TRADING_ENABLED=true", () => {
    expect(loadConfig({ QUANTOWER_TRADING_ENABLED: "true" }).trading.enabled).toBe(true);
    expect(loadConfig({ QUANTOWER_TRADING_ENABLED: "false" }).trading.enabled).toBe(false);
    expect(loadConfig({ QUANTOWER_TRADING_ENABLED: "1" }).trading.enabled).toBe(true);
  });

  it("QUANTOWER_READ_ONLY=true force la lecture seule même si le trading est demandé", () => {
    const config = loadConfig({ QUANTOWER_TRADING_ENABLED: "true", QUANTOWER_READ_ONLY: "true" });
    expect(config.trading.enabled).toBe(false);
    expect(config.trading.readOnlyForced).toBe(true);
  });
});

describe("loadConfig — validation des entrées", () => {
  it("rejette une valeur numérique invalide en nommant la variable", () => {
    expect(() => loadConfig({ QUANTOWER_MAX_ORDER_QUANTITY: "beaucoup" })).toThrowError(ConfigError);
    try {
      loadConfig({ QUANTOWER_MAX_ORDER_QUANTITY: "beaucoup" });
    } catch (error) {
      expect((error as ConfigError).variable).toBe("QUANTOWER_MAX_ORDER_QUANTITY");
    }
  });

  it("rejette un booléen invalide", () => {
    expect(() => loadConfig({ QUANTOWER_DENY_MARKET_ORDERS: "peut-être" })).toThrowError(ConfigError);
  });

  it("rejette un niveau de log inconnu", () => {
    expect(() => loadConfig({ QUANTOWER_LOG_LEVEL: "verbose" })).toThrowError(ConfigError);
  });

  it("rejette une URL de bridge invalide", () => {
    expect(() => loadConfig({ QUANTOWER_BRIDGE_URL: "pas-une-url" })).toThrowError(ConfigError);
  });

  it("accepte 0 pour désactiver un plafond", () => {
    const config = loadConfig({ QUANTOWER_MAX_ORDER_QUANTITY: "0", QUANTOWER_MAX_NOTIONAL: "0" });
    expect(config.trading.maxOrderQuantity).toBe(0);
    expect(config.trading.maxNotional).toBe(0);
  });

  it("normalise l'URL du bridge (espaces + slash final)", () => {
    const config = loadConfig({ QUANTOWER_BRIDGE_URL: "  http://127.0.0.1:9000/  " });
    expect(config.bridge.url).toBe("http://127.0.0.1:9000");
  });
});

describe("readBridgeToken", () => {
  it("priorise QUANTOWER_BRIDGE_TOKEN sur le fichier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qt-mcp-config-"));
    cleanupDirs.push(dir);
    const tokenFile = join(dir, "bridge-token");
    await writeFile(tokenFile, "token-du-fichier\n", "utf8");

    const fromEnv = loadConfig({ QUANTOWER_BRIDGE_TOKEN: "token-env", QUANTOWER_BRIDGE_TOKEN_FILE: tokenFile });
    expect(readBridgeToken(fromEnv.bridge)).toBe("token-env");

    const fromFile = loadConfig({ QUANTOWER_BRIDGE_TOKEN_FILE: tokenFile });
    expect(readBridgeToken(fromFile.bridge)).toBe("token-du-fichier");
  });

  it("renvoie undefined si le fichier est absent", () => {
    const config = loadConfig({ QUANTOWER_BRIDGE_TOKEN_FILE: join(tmpdir(), "fichier-inexistant-qt-mcp") });
    expect(readBridgeToken(config.bridge)).toBeUndefined();
  });
});
