/**
 * Client HTTP du bridge Quantower (plan §2.1 B et §7).
 *
 * - timeout par appel (AbortController) ;
 * - retries exponentiels UNIQUEMENT sur les GET idempotents (jamais de rejeu
 *   automatique d'un ordre : un ordre ne doit jamais être envoyé deux fois) ;
 * - cache TTL court sur les lectures pour absorber les rafales d'appels ;
 * - cache invalidé après toute écriture et à la reconnexion (bridge indisponible).
 */

import { readBridgeToken, type BridgeClientConfig } from "./config.js";
import {
  QuantowerError,
  TimeoutError,
  errorFromFetchFailure,
  errorFromHttpResponse,
  isQuantowerError,
  isRetryableError,
} from "./errors.js";
import type { Logger } from "./logger.js";
import type {
  AccountInfo,
  BridgeHealth,
  ConnectionInfo,
  DomResponse,
  HistoryResponse,
  ModifyOrderPayload,
  OrderInfo,
  PlaceOrderPayload,
  PositionInfo,
  QuoteInfo,
  SymbolInfo,
  TradeInfo,
  TradingOperationResult,
} from "./bridge-types.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface QuantowerClientOptions {
  bridge: BridgeClientConfig;
  logger: Logger;
  /** Injectable pour les tests ou un fetch instrumenté. */
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  /** Par défaut : true pour GET, false sinon. */
  useCache?: boolean;
  /** Par défaut : bridge.retryCount pour GET, 0 pour les écritures. */
  retries?: number;
  timeoutMs?: number;
}

export interface OrdersFilter {
  connectionId?: string;
  accountId?: string;
}

export interface HistoryQuery {
  symbolId: string;
  timeframe: string;
  from?: string;
  to?: string;
  limit?: number;
  connectionId?: string;
}

const CACHE_SEPARATOR = "\u0000";

export class QuantowerClient {
  private readonly options: QuantowerClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();

  constructor(options: QuantowerClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // ---------------------------------------------------------------- Lecture

  getHealth(): Promise<BridgeHealth> {
    // Jamais de cache ni de retry : quantower_status doit répondre vite et dire la vérité.
    return this.request<BridgeHealth>("GET", "/health", { useCache: false, retries: 0 });
  }

  getConnections(): Promise<ConnectionInfo[]> {
    return this.request<ConnectionInfo[]>("GET", "/connections");
  }

  getAccounts(filter: { connectionId?: string } = {}): Promise<AccountInfo[]> {
    return this.request<AccountInfo[]>("GET", "/accounts", { query: { connectionId: filter.connectionId } });
  }

  searchSymbols(params: { query: string; connectionId?: string; limit?: number }): Promise<SymbolInfo[]> {
    return this.request<SymbolInfo[]>("GET", "/symbols", {
      query: { q: params.query, connectionId: params.connectionId, limit: params.limit },
    });
  }

  getQuote(symbolId: string, connectionId?: string): Promise<QuoteInfo> {
    return this.request<QuoteInfo>("GET", `/symbols/${encodeURIComponent(symbolId)}/quote`, {
      query: { connectionId },
    });
  }

  getHistory(query: HistoryQuery): Promise<HistoryResponse> {
    return this.request<HistoryResponse>("GET", `/symbols/${encodeURIComponent(query.symbolId)}/history`, {
      query: {
        timeframe: query.timeframe,
        from: query.from,
        to: query.to,
        limit: query.limit,
        connectionId: query.connectionId,
      },
      useCache: false,
    });
  }

  getDom(symbolId: string, params: { depth?: number; connectionId?: string } = {}): Promise<DomResponse> {
    return this.request<DomResponse>("GET", `/symbols/${encodeURIComponent(symbolId)}/dom`, {
      query: { depth: params.depth, connectionId: params.connectionId },
    });
  }

  getPositions(filter: OrdersFilter = {}): Promise<PositionInfo[]> {
    return this.request<PositionInfo[]>("GET", "/positions", {
      query: { connectionId: filter.connectionId, accountId: filter.accountId },
    });
  }

  getOrders(filter: OrdersFilter = {}): Promise<OrderInfo[]> {
    return this.request<OrderInfo[]>("GET", "/orders", {
      query: { connectionId: filter.connectionId, accountId: filter.accountId },
    });
  }

  getOrdersHistory(
    params: OrdersFilter & { from?: string; to?: string; limit?: number } = {},
  ): Promise<OrderInfo[]> {
    return this.request<OrderInfo[]>("GET", "/orders/history", {
      query: {
        connectionId: params.connectionId,
        accountId: params.accountId,
        from: params.from,
        to: params.to,
        limit: params.limit,
      },
      useCache: false,
    });
  }

  getTrades(params: OrdersFilter & { limit?: number } = {}): Promise<TradeInfo[]> {
    return this.request<TradeInfo[]>("GET", "/trades", {
      query: { connectionId: params.connectionId, accountId: params.accountId, limit: params.limit },
    });
  }

  // ---------------------------------------------------------------- Écriture

  async placeOrder(payload: PlaceOrderPayload): Promise<TradingOperationResult> {
    try {
      return await this.request<TradingOperationResult>("POST", "/orders", { body: payload, retries: 0 });
    } finally {
      this.invalidateCache();
    }
  }

  async modifyOrder(orderId: string, payload: ModifyOrderPayload): Promise<TradingOperationResult> {
    try {
      return await this.request<TradingOperationResult>("PATCH", `/orders/${encodeURIComponent(orderId)}`, {
        body: payload,
        retries: 0,
      });
    } finally {
      this.invalidateCache();
    }
  }

  async cancelOrder(orderId: string): Promise<TradingOperationResult> {
    try {
      return await this.request<TradingOperationResult>("DELETE", `/orders/${encodeURIComponent(orderId)}`, {
        retries: 0,
      });
    } finally {
      this.invalidateCache();
    }
  }

  async closePosition(positionId: string, quantity?: number): Promise<TradingOperationResult> {
    try {
      return await this.request<TradingOperationResult>(
        "POST",
        `/positions/${encodeURIComponent(positionId)}/close`,
        { body: quantity === undefined ? {} : { quantity }, retries: 0 },
      );
    } finally {
      this.invalidateCache();
    }
  }

  /** Purge le cache de lectures (après écriture ou perte de connexion). */
  invalidateCache(): void {
    this.cache.clear();
  }

  // ---------------------------------------------------------------- Interne

  private resolveToken(): string | undefined {
    return readBridgeToken(this.options.bridge);
  }

  private buildUrl(path: string, query?: QueryParams): string {
    const url = new URL(path, `${this.options.bridge.url}/`);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) {
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private readCache<T>(cacheKey: string): T | undefined {
    const entry = this.cache.get(cacheKey);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(cacheKey);
      return undefined;
    }
    return entry.value as T;
  }

  private async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const useCache = options.useCache ?? method === "GET";
    const cacheKey = `${method}${CACHE_SEPARATOR}${url}`;

    if (useCache) {
      const cached = this.readCache<T>(cacheKey);
      if (cached !== undefined) {
        this.options.logger.debug(`Cache hit ${method} ${path}`);
        return cached;
      }
    }

    // Les écritures ne sont jamais rejouées automatiquement (risque d'ordre en double).
    const retries = options.retries ?? (method === "GET" ? this.options.bridge.retryCount : 0);
    const attempts = Math.max(1, retries + 1);
    let lastError: QuantowerError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) {
        await delay(backoffDelayMs(attempt));
      }
      try {
        const value = await this.execute<T>(method, url, options.body, options.timeoutMs);
        if (useCache && this.options.bridge.cacheTtlMs > 0) {
          this.cache.set(cacheKey, { expiresAt: Date.now() + this.options.bridge.cacheTtlMs, value });
        }
        return value;
      } catch (error) {
        const quantowerError = isQuantowerError(error)
          ? error
          : new QuantowerError("INTERNAL_ERROR", `Erreur inattendue lors de l'appel ${method} ${url}.`, {
              cause: error,
            });
        if (!isRetryableError(quantowerError) || attempt === attempts) {
          if (quantowerError.code === "BRIDGE_UNAVAILABLE" || quantowerError.code === "TIMEOUT") {
            // Évite de servir des snapshots périmés après une reconnexion du bridge.
            this.invalidateCache();
          }
          throw quantowerError;
        }
        lastError = quantowerError;
        this.options.logger.warn(
          `Échec ${method} ${path} (tentative ${attempt}/${attempts}) : ${quantowerError.message}`,
        );
      }
    }

    throw lastError ?? new QuantowerError("INTERNAL_ERROR", `Aucune tentative effectuée pour ${method} ${url}.`);
  }

  private async execute<T>(method: HttpMethod, url: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const effectiveTimeout = timeoutMs ?? this.options.bridge.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const headers: Record<string, string> = { accept: "application/json" };
      const token = this.resolveToken();
      if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
      }
      let serializedBody: string | undefined;
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        serializedBody = JSON.stringify(body);
      }

      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: serializedBody,
        signal: controller.signal,
      });

      const text = await response.text();
      const parsed = parseJsonBody(text, url);

      if (!response.ok) {
        throw errorFromHttpResponse(response.status, parsed, url);
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof QuantowerError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new TimeoutError(`Timeout de ${effectiveTimeout} ms sur ${method} ${url}.`, {
          details: { url, timeoutMs: effectiveTimeout },
        });
      }
      throw errorFromFetchFailure(error, url);
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseJsonBody(text: string, url: string): unknown {
  if (text.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new QuantowerError("INVALID_RESPONSE", `Réponse non JSON du bridge pour ${url}.`, {
      details: text.slice(0, 500),
    });
  }
}

function backoffDelayMs(attempt: number): number {
  const base = 200 * 2 ** (attempt - 2);
  const jitter = Math.floor(Math.random() * 100);
  return Math.min(base + jitter, 2_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
