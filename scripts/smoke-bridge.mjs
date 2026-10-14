#!/usr/bin/env node
/**
 * Smoke test HTTP du bridge Quantower (réel ou factice) — validation manuelle des phases 0/1/3.
 *
 * Lecture seule par défaut. Le cycle d'écriture (place → modify → cancel) est réservé à un
 * compte DÉMO / Trading Simulator et exige les deux drapeaux `--trading --yes` — et un bridge
 * dont l'écriture est activée (`QUANTOWER_BRIDGE_TRADING_ENABLED=true` ou `--trading` en stub).
 *
 * Usage :
 *   node scripts/smoke-bridge.mjs --url http://127.0.0.1:8765 --token <token>
 *   node scripts/smoke-bridge.mjs --url http://127.0.0.1:8765 --token <token> --trading --yes
 */

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

const args = parseCliArgs(process.argv.slice(2));

const baseUrl = (args.get("url") ?? "http://127.0.0.1:8765").replace(/\/+$/, "");
const token = args.get("token") ?? process.env.QUANTOWER_BRIDGE_TOKEN ?? "";
const symbolId = args.get("symbol") ?? "EUR/USD";
const bridgeUrl = baseUrl;

const runTrading = args.has("trading") && args.has("yes");

async function call(method, path, body, options = {}) {
  const withAuth = options.auth !== false;
  const response = await fetch(`${bridgeUrl}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(withAuth && token !== "" ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function report(label, result, { expectStatus = 200 } = {}) {
  const ok = result.status === expectStatus;
  const prefix = ok ? "OK  " : "FAIL";
  process.stdout.write(`${prefix} ${label} -> HTTP ${result.status}\n`);
  if (!ok) {
    process.stdout.write(`     ${JSON.stringify(result.body)}\n`);
  }
  return ok;
}

async function main() {
  process.stdout.write(`Smoke test du bridge ${bridgeUrl} (token ${token === "" ? "absent" : "fourni"})\n`);
  if (token === "") {
    process.stdout.write(
      "⚠️  Aucun token fourni : toutes les routes protégées répondront 401. Utilisez --token <valeur> " +
        "(ou la variable QUANTOWER_BRIDGE_TOKEN).\n",
    );
  }
  process.stdout.write("\n");
  let failures = 0;
  const check = (label, result, options) => {
    if (!report(label, result, options)) {
      failures += 1;
    }
  };

  check("GET /health (Bearer requis)", await call("GET", "/health"));
  const connections = await call("GET", "/connections");
  check("GET /connections", connections);
  check("GET /accounts", await call("GET", "/accounts"));
  check(`GET /symbols?q=${encodeURIComponent(symbolId)}`, await call("GET", `/symbols?q=${encodeURIComponent(symbolId)}`));

  const quote = await call("GET", `/symbols/${encodeURIComponent(symbolId)}/quote`);
  check(`GET /symbols/${symbolId}/quote`, quote);
  check(`GET /symbols/${symbolId}/history`, await call("GET", `/symbols/${encodeURIComponent(symbolId)}/history?timeframe=1h&limit=10`));
  check(`GET /symbols/${symbolId}/dom`, await call("GET", `/symbols/${encodeURIComponent(symbolId)}/dom?depth=5`));
  check("GET /positions", await call("GET", "/positions"));
  check("GET /orders", await call("GET", "/orders"));
  check("GET /orders/history", await call("GET", "/orders/history?limit=5"));
  check("GET /trades", await call("GET", "/trades?limit=5"));
  check("GET /route-inconnue (404 attendu)", await call("GET", "/route-inconnue"), { expectStatus: 404 });
  // Toutes les routes exigent le Bearer, /health compris (même contrat que HttpServer.cs).
  check("GET /health sans token (401 attendu)", await call("GET", "/health", undefined, { auth: false }), {
    expectStatus: 401,
  });

  if (runTrading) {
    process.stdout.write("\n⚠️  Cycle d'écriture (compte DÉMO uniquement) :\n");
    const referencePrice = quote.body?.bid ?? quote.body?.last;
    if (typeof referencePrice !== "number") {
      process.stdout.write("FAIL impossible de lire le bid/last pour placer un ordre limit.\n");
      failures += 1;
    } else {
      const limitPrice = Number((referencePrice * 0.98).toFixed(5));
      const placed = await call("POST", "/orders", {
        accountId: args.get("account") ?? "ACC-DEMO-USD",
        symbolId,
        side: "buy",
        orderType: "limit",
        quantity: 0.01,
        price: limitPrice,
        timeInForce: "gtc",
        comment: "smoke-bridge.mjs",
      });
      check("POST /orders", placed);
      const orderId = placed.body?.orderId;
      if (typeof orderId === "string") {
        check(`PATCH /orders/${orderId}`, await call("PATCH", `/orders/${orderId}`, { quantity: 0.02 }));
        check(`DELETE /orders/${orderId}`, await call("DELETE", `/orders/${orderId}`));
        check(`DELETE /orders/${orderId} (2e fois, 409 attendu)`, await call("DELETE", `/orders/${orderId}`), {
          expectStatus: 409,
        });
      }
    }
  } else {
    process.stdout.write(
      "\n(cycle d'écriture ignoré — ajoutez --trading --yes pour le tester sur un compte démo,\n" +
        " et démarrez le bridge avec l'écriture activée : QUANTOWER_BRIDGE_TRADING_ENABLED=true ou --trading en stub)\n",
    );
  }

  process.stdout.write(`\n${failures === 0 ? "Tous les checks passent." : `${failures} check(s) en échec.`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`Erreur pendant le smoke test : ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
