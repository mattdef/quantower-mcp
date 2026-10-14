/**
 * Journalisation du serveur MCP.
 *
 * Important : le transport MCP est stdio. stdout est réservé au protocole JSON-RPC.
 * Tous les logs doivent donc être écrits sur stderr (voir plan §2.1 B).
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** Noms de champs qui ne doivent jamais apparaître en clair dans les logs. */
const SENSITIVE_KEY_PATTERN = /token|secret|authorization|password/i;

function sanitize(meta: unknown): unknown {
  if (meta === null || typeof meta !== "object") {
    return meta;
  }
  if (Array.isArray(meta)) {
    return meta.map((item) => sanitize(item));
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    sanitized[key] = SENSITIVE_KEY_PATTERN.test(key) ? "***" : value;
  }
  return sanitized;
}

function stringifyMeta(meta: unknown): string {
  try {
    return JSON.stringify(sanitize(meta)) ?? "";
  } catch {
    return "[meta non sérialisable]";
  }
}

export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = LEVEL_WEIGHT[level];

  const write = (entryLevel: LogLevel, message: string, meta?: unknown): void => {
    if (LEVEL_WEIGHT[entryLevel] < threshold) {
      return;
    }
    const line = `[${new Date().toISOString()}] ${entryLevel.toUpperCase()} quantower-mcp: ${message}`;
    const text = meta === undefined ? line : `${line} ${stringifyMeta(meta)}`;
    process.stderr.write(`${text}\n`);
  };

  return {
    level,
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}
