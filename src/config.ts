/**
 * Configuration du serveur MCP (variables d'environnement, plan §4.5).
 *
 * Garde-fous :
 * - lecture seule par défaut : les tools d'écriture ne sont enregistrés que si
 *   QUANTOWER_TRADING_ENABLED=true ET QUANTOWER_READ_ONLY≠true ;
 * - plafonds configurables : max_order_quantity / max_notional / deny_market_orders.
 */

import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { ConfigError } from "./errors.js";
import { LOG_LEVELS, isLogLevel, type LogLevel } from "./logger.js";

export interface BridgeClientConfig {
  /** URL de base du bridge, ex. http://127.0.0.1:8765 (sans slash final). */
  url: string;
  /** Token fourni directement par QUANTOWER_BRIDGE_TOKEN (prioritaire). */
  token?: string;
  /** Fichier de token écrit par le bridge (relu à chaque appel pour supporter un redémarrage). */
  tokenFile: string;
  timeoutMs: number;
  /** Nombre de retries appliqué uniquement aux appels GET idempotents. */
  retryCount: number;
  cacheTtlMs: number;
}

export interface TradingLimits {
  /** true = tools d'écriture enregistrés. */
  enabled: boolean;
  /** true si QUANTOWER_READ_ONLY=true force la lecture seule. */
  readOnlyForced: boolean;
  /** 0 = plafond désactivé. */
  maxOrderQuantity: number;
  /** 0 = plafond désactivé (devise du compte). */
  maxNotional: number;
  denyMarketOrders: boolean;
}

export interface ReadLimits {
  /** Limite maximale de barres acceptée par quantower_get_history. */
  maxBars: number;
  defaultHistoryBars: number;
  defaultOrdersHistoryLimit: number;
  defaultTradesLimit: number;
}

export interface AppConfig {
  logLevel: LogLevel;
  bridge: BridgeClientConfig;
  trading: TradingLimits;
  read: ReadLimits;
}

export const DEFAULT_BRIDGE_PORT = 8765;
/** URL par défaut : le bridge C# enregistre les variantes loopback localhost, 127.0.0.1 et [::1]. */
export const DEFAULT_BRIDGE_URL = `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;

/** Répertoire de travail du bridge/MCP : %LOCALAPPDATA%\quantower-mcp (Windows) ou équivalent XDG. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (platform() === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData !== undefined && localAppData !== "") {
      return join(localAppData, "quantower-mcp");
    }
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome !== undefined && xdgDataHome !== "") {
    return join(xdgDataHome, "quantower-mcp");
  }
  return join(homedir(), ".local", "share", "quantower-mcp");
}

export function defaultTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultDataDir(env), "bridge-token");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const bridgeUrl = normalizeBridgeUrl(env.QUANTOWER_BRIDGE_URL?.trim() || DEFAULT_BRIDGE_URL);
  const logLevelValue = env.QUANTOWER_LOG_LEVEL?.trim() || "info";
  if (!isLogLevel(logLevelValue)) {
    throw new ConfigError(
      "QUANTOWER_LOG_LEVEL",
      `valeur invalide « ${logLevelValue} » (attendu : ${LOG_LEVELS.join(", ")})`,
    );
  }

  const tradingEnabledRequested = parseBooleanEnv(
    env.QUANTOWER_TRADING_ENABLED,
    false,
    "QUANTOWER_TRADING_ENABLED",
  );
  const readOnlyForced = parseBooleanEnv(env.QUANTOWER_READ_ONLY, false, "QUANTOWER_READ_ONLY");

  return {
    logLevel: logLevelValue,
    bridge: {
      url: bridgeUrl,
      token: optionalString(env.QUANTOWER_BRIDGE_TOKEN),
      tokenFile: optionalString(env.QUANTOWER_BRIDGE_TOKEN_FILE) ?? defaultTokenFile(env),
      timeoutMs: parseNumberEnv(env.QUANTOWER_BRIDGE_TIMEOUT_MS, 15_000, "QUANTOWER_BRIDGE_TIMEOUT_MS", {
        min: 100,
        integer: true,
      }),
      retryCount: parseNumberEnv(env.QUANTOWER_RETRY_COUNT, 2, "QUANTOWER_RETRY_COUNT", {
        min: 0,
        max: 10,
        integer: true,
      }),
      cacheTtlMs: parseNumberEnv(env.QUANTOWER_CACHE_TTL_MS, 1_000, "QUANTOWER_CACHE_TTL_MS", {
        min: 0,
        integer: true,
      }),
    },
    trading: {
      enabled: tradingEnabledRequested && !readOnlyForced,
      readOnlyForced,
      maxOrderQuantity: parseNumberEnv(env.QUANTOWER_MAX_ORDER_QUANTITY, 50, "QUANTOWER_MAX_ORDER_QUANTITY", {
        min: 0,
      }),
      maxNotional: parseNumberEnv(env.QUANTOWER_MAX_NOTIONAL, 50_000, "QUANTOWER_MAX_NOTIONAL", { min: 0 }),
      denyMarketOrders: parseBooleanEnv(env.QUANTOWER_DENY_MARKET_ORDERS, false, "QUANTOWER_DENY_MARKET_ORDERS"),
    },
    read: {
      maxBars: parseNumberEnv(env.QUANTOWER_MAX_BARS, 500, "QUANTOWER_MAX_BARS", { min: 1, max: 10_000, integer: true }),
      defaultHistoryBars: 200,
      defaultOrdersHistoryLimit: 100,
      defaultTradesLimit: 100,
    },
  };
}

/**
 * Résout le token du bridge : QUANTOWER_BRIDGE_TOKEN sinon lecture du fichier écrit par le bridge.
 * Retourne undefined si aucun token n'est disponible (l'appel échouera en BRIDGE_UNAUTHORIZED).
 */
export function readBridgeToken(bridge: BridgeClientConfig): string | undefined {
  if (bridge.token !== undefined && bridge.token.trim() !== "") {
    return bridge.token.trim();
  }
  try {
    const token = readFileSync(bridge.tokenFile, "utf8").trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function normalizeBridgeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (trimmed === "") {
    throw new ConfigError("QUANTOWER_BRIDGE_URL", "URL vide");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError("QUANTOWER_BRIDGE_URL", `URL invalide « ${rawUrl} »`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("QUANTOWER_BRIDGE_URL", `protocole non supporté « ${parsed.protocol} » (attendu http ou https)`);
  }
  return trimmed;
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean, variableName: string): boolean {
  const raw = value?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  if (["true", "1", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(raw)) {
    return false;
  }
  throw new ConfigError(variableName, `booléen invalide « ${value} » (attendu : true/false)`);
}

function parseNumberEnv(
  value: string | undefined,
  defaultValue: number,
  variableName: string,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = value?.trim();
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(variableName, `nombre invalide « ${value} »`);
  }
  if (options.integer === true && !Number.isInteger(parsed)) {
    throw new ConfigError(variableName, `valeur entière attendue, reçu « ${value} »`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new ConfigError(variableName, `valeur < minimum ${options.min} (reçu ${parsed})`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new ConfigError(variableName, `valeur > maximum ${options.max} (reçu ${parsed})`);
  }
  return parsed;
}
