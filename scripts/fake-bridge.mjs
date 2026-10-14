#!/usr/bin/env node
/**
 * Bridge Quantower FACTICE pour les tests (et pour développer le serveur MCP sans Quantower).
 *
 * Il implémente le contrat JSON du plan §3 sur http://127.0.0.1:<port> avec auth Bearer.
 * Il lit les DTOs de référence depuis scripts/fixtures/*.json : ces fixtures figent le
 * contrat bridge ↔ MCP (plan §7, « les DTOs du bridge sont figés par des fixtures partagées »).
 *
 * Usage CLI : node scripts/fake-bridge.mjs [--port 8765] [--token dev-token] [--latency 0] [--fail-mode none]
 * Modes d'échec : none | unauthorized | server-error | timeout
 *
 * ⚠️ Ce n'est PAS le bridge réel : le bridge réel est le plugin C# de bridge/QuantowerMcpBridge.
 * Ici, les plafonds et cohérences compte/symbole ne sont pas validés (c'est le rôle du bridge C#).
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

const FIXTURES = {
  health: loadFixture("health.json"),
  connections: loadFixture("connections.json"),
  accounts: loadFixture("accounts.json"),
  symbols: loadFixture("symbols.json"),
  quotes: loadFixture("quotes.json"),
  dom: loadFixture("dom.json"),
  positions: loadFixture("positions.json"),
  orders: loadFixture("orders.json"),
  ordersHistory: loadFixture("orders-history.json"),
  trades: loadFixture("trades.json"),
  tradingSuccess: loadFixture("trading-result-success.json"),
  tradingFailure: loadFixture("trading-result-failure.json"),
};

const TIMEFRAME_MS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

/** Compte/symbole conventionnels pour simuler un rejet broker : ACC-REJECT ou symbole FAIL-*. */
const REJECT_ACCOUNT_ID = "ACC-REJECT";
const REJECT_SYMBOL_PREFIX = "FAIL";

export function startFakeBridge(options = {}) {
  const state = {
    failMode: options.failMode ?? "none",
    latencyMs: options.latencyMs ?? 0,
    token: options.token ?? "dev-token",
    closed: false,
  };
  const requests = [];
  const pendingTimers = new Set();
  const cancelledOrders = new Set();
  const workingOrders = FIXTURES.orders.map((order) => ({ ...order }));
  const positions = FIXTURES.positions.map((position) => ({ ...position }));
  let nextOrderNumber = 2000;

  function delay(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        resolve();
      }, ms);
      pendingTimers.add(timer);
    });
  }

  async function handler(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await readJsonBody(req);
    requests.push({
      method: req.method ?? "GET",
      url: url.pathname + url.search,
      authorization: req.headers.authorization ?? undefined,
      body,
    });

    if (state.failMode === "timeout") {
      // Maintient la requête ouverte jusqu'à ce que le client abandonne (test du timeout client).
      await delay(30_000);
      if (state.closed) {
        return;
      }
    }
    if (state.latencyMs > 0) {
      await delay(state.latencyMs);
    }
    if (state.failMode === "server-error") {
      return sendJson(res, 500, errorBody("PLATFORM_ERROR", "Erreur simulée du bridge (fail-mode=server-error)."));
    }
    if (state.failMode === "unauthorized") {
      return sendJson(res, 401, errorBody("BRIDGE_UNAUTHORIZED", "Token manquant ou invalide (fail-mode=unauthorized)."));
    }

    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    if (token !== state.token) {
      return sendJson(res, 401, errorBody("BRIDGE_UNAUTHORIZED", "Token manquant ou invalide."));
    }

    try {
      return route(req, url, body, res);
    } catch (error) {
      return sendJson(res, 500, errorBody("PLATFORM_ERROR", error instanceof Error ? error.message : String(error)));
    }
  }

  function route(req, url, body, res) {
    const method = req.method ?? "GET";
    const segments = url.pathname
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) => decodeURIComponent(segment));

    // --- Lecture -----------------------------------------------------------
    if (method === "GET" && match(segments, ["health"])) {
      return sendJson(res, 200, {
        ...FIXTURES.health,
        uptimeSeconds: Math.round(process.uptime()),
        tradingEnabled: true,
      });
    }
    if (method === "GET" && match(segments, ["connections"])) {
      return sendJson(res, 200, FIXTURES.connections);
    }
    if (method === "GET" && match(segments, ["accounts"])) {
      return sendJson(res, 200, filterBy(FIXTURES.accounts, url.searchParams, ["connectionId"]));
    }
    if (method === "GET" && match(segments, ["symbols"])) {
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      const connectionId = url.searchParams.get("connectionId");
      const limit = toPositiveInt(url.searchParams.get("limit"), 50);
      const matches = FIXTURES.symbols.filter((symbol) => {
        const text = `${symbol.symbolId} ${symbol.name} ${symbol.description ?? ""}`.toLowerCase();
        const sameConnection = connectionId === null || symbol.connectionId === connectionId;
        return sameConnection && (query === "" || text.includes(query));
      });
      return sendJson(res, 200, matches.slice(0, limit));
    }
    if (method === "GET" && segments.length === 3 && segments[0] === "symbols" && segments[2] === "quote") {
      const symbolId = segments[1];
      const quote = FIXTURES.quotes[symbolId];
      if (quote === undefined) {
        return sendJson(res, 404, errorBody("NOT_FOUND", `Instrument inconnu : ${symbolId}.`, { symbolId }));
      }
      return sendJson(res, 200, quote);
    }
    if (method === "GET" && segments.length === 3 && segments[0] === "symbols" && segments[2] === "history") {
      const symbolId = segments[1];
      const symbol = FIXTURES.symbols.find((candidate) => candidate.symbolId === symbolId);
      if (symbol === undefined) {
        return sendJson(res, 404, errorBody("NOT_FOUND", `Instrument inconnu : ${symbolId}.`, { symbolId }));
      }
      const timeframe = url.searchParams.get("timeframe") ?? "1h";
      if (TIMEFRAME_MS[timeframe] === undefined) {
        return sendJson(res, 400, errorBody("VALIDATION_ERROR", `Timeframe non supporté : ${timeframe}.`));
      }
      const limit = Math.min(toPositiveInt(url.searchParams.get("limit"), 100), 500);
      const to = parseDateOrNull(url.searchParams.get("to")) ?? new Date("2026-10-13T20:00:00.000Z");
      const bars = generateBars(symbolId, timeframe, limit, to);
      return sendJson(res, 200, { symbolId, connectionId: symbol.connectionId, timeframe, bars, count: bars.length });
    }
    if (method === "GET" && segments.length === 3 && segments[0] === "symbols" && segments[2] === "dom") {
      const symbolId = segments[1];
      const dom = FIXTURES.dom[symbolId];
      if (dom === undefined) {
        return sendJson(res, 404, errorBody("NOT_FOUND", `Instrument inconnu ou DOM indisponible : ${symbolId}.`, { symbolId }));
      }
      const depth = toPositiveInt(url.searchParams.get("depth"), 10);
      return sendJson(res, 200, {
        symbolId,
        connectionId: FIXTURES.quotes[symbolId]?.connectionId,
        timestampUtc: new Date().toISOString(),
        bids: dom.bids.slice(0, depth),
        asks: dom.asks.slice(0, depth),
      });
    }
    if (method === "GET" && match(segments, ["positions"])) {
      return sendJson(res, 200, filterBy(positions, url.searchParams, ["connectionId", "accountId"]));
    }
    if (method === "GET" && match(segments, ["orders"])) {
      return sendJson(res, 200, filterBy(workingOrders, url.searchParams, ["connectionId", "accountId"]));
    }
    if (method === "GET" && match(segments, ["orders", "history"])) {
      const limit = toPositiveInt(url.searchParams.get("limit"), 100);
      const filtered = filterBy(FIXTURES.ordersHistory, url.searchParams, ["connectionId", "accountId"]);
      return sendJson(res, 200, filtered.slice(0, limit));
    }
    if (method === "GET" && match(segments, ["trades"])) {
      const limit = toPositiveInt(url.searchParams.get("limit"), 100);
      const filtered = filterBy(FIXTURES.trades, url.searchParams, ["connectionId", "accountId"]);
      return sendJson(res, 200, filtered.slice(0, limit));
    }

    // --- Écriture ----------------------------------------------------------
    if (method === "POST" && match(segments, ["orders"])) {
      return placeOrder(body, res);
    }
    if (method === "PATCH" && segments.length === 2 && segments[0] === "orders") {
      return modifyOrder(segments[1], body, res);
    }
    if (method === "DELETE" && segments.length === 2 && segments[0] === "orders") {
      return cancelOrder(segments[1], res);
    }
    if (method === "POST" && segments.length === 3 && segments[0] === "positions" && segments[2] === "close") {
      return closePosition(segments[1], body, res);
    }

    if (match(segments, ["events"])) {
      return sendJson(res, 501, errorBody("NOT_IMPLEMENTED", "WebSocket /events non implémenté (phase 4+/v2)."));
    }
    return sendJson(res, 404, errorBody("NOT_FOUND", `Route inconnue : ${method} ${url.pathname}.`));
  }

  function placeOrder(body, res) {
    const payload = isRecord(body) ? body : {};
    for (const field of ["accountId", "symbolId", "side", "orderType", "quantity"]) {
      if (payload[field] === undefined || payload[field] === null || payload[field] === "") {
        return sendJson(res, 400, errorBody("VALIDATION_ERROR", `Champ obligatoire manquant : ${field}.`));
      }
    }
    const symbolId = String(payload.symbolId);
    if (String(payload.accountId) === REJECT_ACCOUNT_ID || symbolId.startsWith(REJECT_SYMBOL_PREFIX)) {
      return sendJson(res, 200, { ...FIXTURES.tradingFailure });
    }
    nextOrderNumber += 1;
    const orderId = `ORD-${nextOrderNumber}`;
    workingOrders.push({
      orderId,
      connectionId: String(payload.connectionId ?? "SIM-1"),
      accountId: String(payload.accountId),
      symbolId,
      side: String(payload.side),
      orderType: String(payload.orderType),
      status: "working",
      quantity: Number(payload.quantity),
      filledQuantity: 0,
      price: payload.price === undefined ? undefined : Number(payload.price),
      triggerPrice: payload.triggerPrice === undefined ? undefined : Number(payload.triggerPrice),
      timeInForce: payload.timeInForce === undefined ? undefined : String(payload.timeInForce),
      createdAtUtc: new Date().toISOString(),
      comment: payload.comment === undefined ? undefined : String(payload.comment),
    });
    return sendJson(res, 200, { ...FIXTURES.tradingSuccess, orderId });
  }

  function modifyOrder(orderId, body, res) {
    if (cancelledOrders.has(orderId)) {
      return sendJson(res, 409, errorBody("INVALID_STATE", `Ordre ${orderId} déjà annulé ou terminé.`, { orderId }));
    }
    const order = workingOrders.find((candidate) => candidate.orderId === orderId);
    if (order === undefined) {
      const inHistory = FIXTURES.ordersHistory.some((candidate) => candidate.orderId === orderId);
      if (inHistory) {
        return sendJson(res, 409, errorBody("INVALID_STATE", `Ordre ${orderId} terminé : modification impossible.`, { orderId }));
      }
      return sendJson(res, 404, errorBody("NOT_FOUND", `Ordre inconnu : ${orderId}.`, { orderId }));
    }
    const payload = isRecord(body) ? body : {};
    if (payload.quantity !== undefined) order.quantity = Number(payload.quantity);
    if (payload.price !== undefined) order.price = Number(payload.price);
    if (payload.triggerPrice !== undefined) order.triggerPrice = Number(payload.triggerPrice);
    if (payload.timeInForce !== undefined) order.timeInForce = String(payload.timeInForce);
    return sendJson(res, 200, { status: "success", message: `Ordre ${orderId} modifié (fake bridge)`, orderId });
  }

  function cancelOrder(orderId, res) {
    if (cancelledOrders.has(orderId)) {
      return sendJson(res, 409, errorBody("INVALID_STATE", `Ordre ${orderId} déjà annulé.`, { orderId }));
    }
    const index = workingOrders.findIndex((candidate) => candidate.orderId === orderId);
    if (index === -1) {
      const inHistory = FIXTURES.ordersHistory.some((candidate) => candidate.orderId === orderId);
      if (inHistory) {
        return sendJson(res, 409, errorBody("INVALID_STATE", `Ordre ${orderId} terminé : annulation impossible.`, { orderId }));
      }
      return sendJson(res, 404, errorBody("NOT_FOUND", `Ordre inconnu : ${orderId}.`, { orderId }));
    }
    workingOrders.splice(index, 1);
    cancelledOrders.add(orderId);
    return sendJson(res, 200, { status: "success", message: `Ordre ${orderId} annulé (fake bridge)`, orderId });
  }

  function closePosition(positionId, body, res) {
    const index = positions.findIndex((candidate) => candidate.positionId === positionId);
    if (index === -1) {
      return sendJson(res, 404, errorBody("NOT_FOUND", `Position inconnue : ${positionId}.`, { positionId }));
    }
    const position = positions[index];
    const payload = isRecord(body) ? body : {};
    const requested = payload.quantity === undefined || payload.quantity === null ? position.quantity : Number(payload.quantity);
    if (!Number.isFinite(requested) || requested <= 0) {
      return sendJson(res, 400, errorBody("VALIDATION_ERROR", "quantity doit être un nombre > 0.", { positionId }));
    }
    if (requested > position.quantity) {
      return sendJson(
        res,
        400,
        errorBody("VALIDATION_ERROR", `Quantité ${requested} supérieure à la position ouverte ${position.quantity}.`, {
          positionId,
          requested,
          openQuantity: position.quantity,
        }),
      );
    }
    if (requested === position.quantity) {
      positions.splice(index, 1);
    } else {
      position.quantity = Number((position.quantity - requested).toFixed(8));
    }
    return sendJson(res, 200, {
      status: "success",
      message: `Position ${positionId} fermée (${requested}) (fake bridge)`,
      positionId,
    });
  }

  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, errorBody("PLATFORM_ERROR", error instanceof Error ? error.message : String(error)));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        token: state.token,
        requests,
        setFailMode(mode) {
          state.failMode = mode;
        },
        setLatency(ms) {
          state.latencyMs = ms;
        },
        close() {
          state.closed = true;
          for (const timer of pendingTimers) {
            clearTimeout(timer);
          }
          pendingTimers.clear();
          if (typeof server.closeAllConnections === "function") {
            server.closeAllConnections();
          }
          return new Promise((resolveClose) => {
            server.close(() => resolveClose());
          });
        },
      });
    });
  });
}

// ------------------------------------------------------------------ Helpers

function match(segments, expected) {
  return segments.length === expected.length && expected.every((value, index) => segments[index] === value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterBy(items, searchParams, keys) {
  return items.filter((item) =>
    keys.every((key) => {
      const expected = searchParams.get(key);
      return expected === null || item[key] === expected;
    }),
  );
}

function toPositiveInt(raw, fallback) {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDateOrNull(raw) {
  if (raw === null || raw.trim() === "") {
    return null;
  }
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

/** Génère des bougies déterministes à partir du dernier prix de la fixture quote. */
function generateBars(symbolId, timeframe, limit, endDate) {
  const quote = FIXTURES.quotes[symbolId];
  const last = quote?.last ?? 100;
  const stepMs = TIMEFRAME_MS[timeframe];
  const amplitude = last * 0.001;
  const bars = [];
  for (let index = limit - 1; index >= 0; index -= 1) {
    const offset = index - limit / 2;
    const open = roundPrice(last + offset * amplitude * 0.25);
    const close = roundPrice(last + (offset + 1) * amplitude * 0.25);
    bars.push({
      timestampUtc: new Date(endDate.getTime() - index * stepMs).toISOString(),
      open,
      high: roundPrice(Math.max(open, close) + amplitude * 0.1),
      low: roundPrice(Math.min(open, close) - amplitude * 0.1),
      close,
      volume: Math.round(1000 + ((index * 37) % 500)),
    });
  }
  return bars;
}

function roundPrice(value) {
  return Number(value.toFixed(6));
}

function errorBody(code, message, details) {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ------------------------------------------------------------------------ CLI

/** Accepte `--clé valeur` et `--clé=valeur` (les drapeaux seuls valent "true"). */
function parseCliArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const withoutPrefix = token.slice(2);
    if (withoutPrefix.includes("=")) {
      const [key, ...rest] = withoutPrefix.split("=");
      args.set(key, rest.join("="));
    } else if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
      args.set(withoutPrefix, argv[index + 1]);
      index += 1;
    } else {
      args.set(withoutPrefix, "true");
    }
  }
  return args;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const args = parseCliArgs(process.argv.slice(2));
  const port = Number.parseInt(args.get("port") ?? "8765", 10);
  const token = args.get("token") ?? "dev-token";
  const latencyMs = Number.parseInt(args.get("latency") ?? "0", 10);
  const failMode = args.get("fail-mode") ?? "none";

  startFakeBridge({ port, token, latencyMs, failMode })
    .then((handle) => {
      process.stdout.write(
        `Bridge factice démarré : ${handle.url}\n` +
          `  token      : ${handle.token}\n` +
          `  fail-mode  : ${failMode} (latence ${latencyMs} ms)\n` +
          `  côté MCP   : QUANTOWER_BRIDGE_URL=${handle.url} QUANTOWER_BRIDGE_TOKEN=${handle.token}\n` +
          "  (Ctrl+C pour arrêter)\n",
      );
    })
    .catch((error) => {
      process.stderr.write(`Échec du démarrage du bridge factice : ${String(error)}\n`);
      process.exit(1);
    });
}
