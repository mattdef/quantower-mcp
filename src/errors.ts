/**
 * Erreurs typées et mapping bridge -> MCP.
 *
 * Contrat du plan §3 et §7 :
 * - le bridge renvoie `{ error: { code, message, details } }` avec des codes HTTP standards ;
 * - le serveur MCP convertit systématiquement en `isError: true` + message actionnable.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Codes d'erreur stables exposés par le serveur MCP (voir plan §7). */
export const ERROR_CODES = [
  "BRIDGE_UNAVAILABLE",
  "BRIDGE_UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "INVALID_STATE",
  "TIMEOUT",
  "PLATFORM_ERROR",
  "INVALID_RESPONSE",
  "TRADING_DISABLED",
  "CONFIRMATION_REQUIRED",
  "LIMIT_EXCEEDED",
  "UNSUPPORTED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface QuantowerErrorOptions {
  details?: unknown;
  hint?: string;
  retryable?: boolean;
  cause?: unknown;
}

/** Erreur de base du projet : porte toujours un code stable et un indice actionnable. */
export class QuantowerError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly hint?: string;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: QuantowerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "QuantowerError";
    this.code = code;
    this.details = options.details;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
  }
}

/** Erreur de configuration (variable d'environnement invalide, etc.). */
export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(`${variable} : ${message}`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

/** Bridge injoignable (Quantower fermé, module non chargé, port incorrect). */
export class BridgeUnavailableError extends QuantowerError {
  constructor(message: string, options: QuantowerErrorOptions = {}) {
    super("BRIDGE_UNAVAILABLE", message, { retryable: true, ...options });
  }
}

/** Timeout d'un appel bridge. */
export class TimeoutError extends QuantowerError {
  constructor(message: string, options: QuantowerErrorOptions = {}) {
    super("TIMEOUT", message, { retryable: true, ...options });
  }
}

const ERROR_HINTS: Partial<Record<ErrorCode, string>> = {
  BRIDGE_UNAVAILABLE:
    "Quantower est-il lancé avec le module QuantowerMcpBridge chargé ? Vérifiez aussi que QUANTOWER_BRIDGE_URL pointe sur le bon port et que le bridge répond sur /health.",
  BRIDGE_UNAUTHORIZED:
    "Token absent ou invalide. Copiez le contenu du fichier %LOCALAPPDATA%\\quantower-mcp\\bridge-token dans QUANTOWER_BRIDGE_TOKEN, ou vérifiez QUANTOWER_BRIDGE_TOKEN_FILE.",
  FORBIDDEN:
    "Requête refusée par le bridge (sécurité ou mode trading désactivé côté bridge). Consultez bridge/README.md.",
  NOT_FOUND:
    "Vérifiez les identifiants fournis (connectionId, accountId, symbolId, orderId, positionId) avec quantower_list_connections / quantower_search_symbols.",
  VALIDATION_ERROR:
    "Le bridge a rejeté le payload. Corrigez les paramètres signalés dans les détails.",
  INVALID_STATE:
    "L'entité n'est plus dans un état compatible (ordinateur déjà annulé/terminé). Rechargez l'état avec quantower_get_orders / quantower_get_positions avant de réessayer.",
  TIMEOUT:
    "Réduisez le nombre de barres demandées (limit) ou augmentez QUANTOWER_BRIDGE_TIMEOUT_MS.",
  PLATFORM_ERROR:
    "Quantower a renvoyé une erreur. Consultez les logs du bridge (%LOCALAPPDATA%\\quantower-mcp\\audit.log) pour le détail côté plateforme.",
  INVALID_RESPONSE:
    "Le bridge a renvoyé une réponse illisible. Vérifiez la version du bridge (phase 0/1) et réessayez.",
  TRADING_DISABLED:
    "Définissez QUANTOWER_TRADING_ENABLED=true (et QUANTOWER_READ_ONLY=false) puis redémarrez le serveur MCP. Si le refus vient du bridge, activez aussi son écriture : QUANTOWER_BRIDGE_TRADING_ENABLED=true. Testez uniquement sur un compte démo ou le Trading Simulator.",
  CONFIRMATION_REQUIRED:
    "Renvoyez l'appel avec confirm: true après avoir vérifié explicitement les paramètres de l'opération.",
  LIMIT_EXCEEDED:
    "Réduisez la taille de l'ordre ou ajustez les plafonds QUANTOWER_MAX_ORDER_QUANTITY / QUANTOWER_MAX_NOTIONAL / QUANTOWER_DENY_MARKET_ORDERS.",
  UNSUPPORTED: "Cette fonctionnalité du bridge n'est pas encore implémentée (voir roadmap du plan).",
  INTERNAL_ERROR: "Erreur interne du serveur MCP. Consultez les logs stderr du serveur.",
};

export function defaultHintFor(code: ErrorCode): string | undefined {
  return ERROR_HINTS[code];
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function safeJson(value: unknown): string {
  try {
    return truncate(JSON.stringify(value) ?? String(value), 1_000);
  } catch {
    return "[détails non sérialisables]";
  }
}

export function isQuantowerError(value: unknown): value is QuantowerError {
  return value instanceof QuantowerError;
}

/** Convertit n'importe quelle valeur levée en QuantowerError exploitable. */
export function normalizeError(value: unknown): QuantowerError {
  if (value instanceof QuantowerError) {
    return value;
  }
  if (value instanceof Error) {
    return new QuantowerError("INTERNAL_ERROR", value.message, {
      cause: value,
      details: value.stack === undefined ? undefined : truncate(value.stack, 800),
    });
  }
  return new QuantowerError("INTERNAL_ERROR", `Erreur inattendue : ${String(value)}`);
}

export function formatError(error: QuantowerError): string {
  const hint = error.hint ?? defaultHintFor(error.code);
  const parts = [`[${error.code}] ${error.message}`];
  if (hint !== undefined) {
    parts.push(`Indice : ${hint}`);
  }
  if (error.details !== undefined) {
    parts.push(`Détails : ${safeJson(error.details)}`);
  }
  return parts.join("\n");
}

/** Résultat d'outil MCP en erreur (voir plan §7). */
export function toToolError(value: unknown): CallToolResult {
  const error = normalizeError(value);
  return {
    content: [{ type: "text", text: formatError(error) }],
    isError: true,
  };
}

/** Erreur pour les handlers hors outils (resources/prompts), qui ne connaissent pas `isError`. */
export function toRpcError(value: unknown): Error {
  const error = normalizeError(value);
  const rpcError = new Error(formatError(error));
  rpcError.name = error.code;
  return rpcError;
}

export function isRetryableError(value: unknown): boolean {
  return value instanceof QuantowerError ? value.retryable : false;
}

export function tradingDisabledError(toolName: string): QuantowerError {
  return new QuantowerError(
    "TRADING_DISABLED",
    `${toolName} est désactivé : le serveur MCP est en mode lecture seule (read_only).`,
    { hint: ERROR_HINTS.TRADING_DISABLED },
  );
}

export function confirmationRequiredError(toolName: string, action: string): QuantowerError {
  return new QuantowerError(
    "CONFIRMATION_REQUIRED",
    `${toolName} exige confirm: true pour exécuter ${action}.`,
    { hint: ERROR_HINTS.CONFIRMATION_REQUIRED },
  );
}

/** Table de correspondance des codes renvoyés par le bridge C#. */
const BRIDGE_ERROR_CODE_MAP: Record<string, ErrorCode> = {
  BRIDGE_UNAUTHORIZED: "BRIDGE_UNAUTHORIZED",
  UNAUTHORIZED: "BRIDGE_UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_STATE: "INVALID_STATE",
  TRADING_DISABLED: "TRADING_DISABLED",
  TRADING_LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  MARKET_ORDERS_DENIED: "LIMIT_EXCEEDED",
  PLATFORM_ERROR: "PLATFORM_ERROR",
  TIMEOUT: "TIMEOUT",
  NOT_IMPLEMENTED: "UNSUPPORTED",
};

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "VALIDATION_ERROR";
    case 401:
      return "BRIDGE_UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "INVALID_STATE";
    case 501:
      return "UNSUPPORTED";
    default:
      return "PLATFORM_ERROR";
  }
}

interface BridgeErrorEnvelope {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

function readBridgeError(body: unknown): { code?: string; message?: string; details?: unknown } {
  if (typeof body !== "object" || body === null) {
    return {};
  }
  const envelope = (body as BridgeErrorEnvelope).error;
  if (typeof envelope !== "object" || envelope === null) {
    return {};
  }
  return {
    code: typeof envelope.code === "string" ? envelope.code : undefined,
    message: typeof envelope.message === "string" ? envelope.message : undefined,
    details: envelope.details,
  };
}

export function errorFromHttpResponse(status: number, body: unknown, url: string): QuantowerError {
  const bridgeError = readBridgeError(body);
  const mappedCode = bridgeError.code === undefined ? undefined : BRIDGE_ERROR_CODE_MAP[bridgeError.code];
  const code = mappedCode ?? codeForStatus(status);
  const message = bridgeError.message ?? `Le bridge a répondu HTTP ${status} pour ${url}.`;
  const retryable = status === 500 || status === 502 || status === 503 || status === 504;
  return new QuantowerError(code, message, {
    details: bridgeError.details,
    hint: defaultHintFor(code),
    retryable,
  });
}

function describeCause(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) {
    return undefined;
  }
  const errno = (cause as { code?: unknown }).code;
  const message = (cause as { message?: unknown }).message;
  const parts = [typeof errno === "string" ? errno : undefined, typeof message === "string" ? message : undefined];
  const filtered = parts.filter((part): part is string => part !== undefined && part !== "");
  return filtered.length > 0 ? filtered.join(" : ") : undefined;
}

export function errorFromFetchFailure(error: unknown, url: string): QuantowerError {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const causeMessage = describeCause(cause) ?? (error instanceof Error ? error.message : String(error));
  return new BridgeUnavailableError(`Bridge Quantower injoignable sur ${url} (${causeMessage}).`, {
    cause: error,
  });
}

/** Résultat d'outil MCP en succès, avec le JSON complet en texte. */
export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}
