# quantower-mcp

Serveur **MCP (Model Context Protocol)** local permettant de **lire et piloter Quantower** depuis un client
IA (Claude Desktop, Cursor, Codex…) via un **bridge C# chargé dans Quantower**.

> ⚠️ **Sécurité avant tout** : le serveur MCP démarre en **lecture seule** (`read_only`) et le bridge C#
> refuse l'écriture par défaut. L'écriture doit être activée explicitement des deux côtés, exige
> `confirm: true` sur chaque appel, respecte des plafonds, et **ne doit être utilisée que sur un compte
> démo ou le Trading Simulator** pendant le développement.

---

## Sommaire

1. [Architecture](#architecture)
2. [Prérequis](#prérequis)
3. [Démarrage rapide (développement sans Quantower)](#démarrage-rapide-développement-sans-quantower)
4. [Installation du bridge dans Quantower](#installation-du-bridge-dans-quantower)
5. [Configuration](#configuration)
6. [Configuration des clients MCP](#configuration-des-clients-mcp)
7. [Sécurité et garde-fous](#sécurité-et-garde-fous)
8. [Outils, ressources et prompts exposés](#outils-ressources-et-prompts-exposés)
9. [Tests, scripts et inspection](#tests-scripts-et-inspection)
10. [Dépannage](#dépannage)
11. [Structure du dépôt](#structure-du-dépôt)
12. [Roadmap et hors scope](#roadmap-et-hors-scope)

---

## Architecture

Quantower n'expose **aucune API externe** : son API (`TradingPlatform.BusinessLayer`) est in-process, utilisable
uniquement par des modules C# chargés dans le terminal. D'où deux composants :

```
┌──────────────────────┐   stdio (MCP)   ┌───────────────────────────┐   HTTP JSON       ┌───────────────────────────────┐
│ Client MCP           │ ◄─────────────► │ quantower-mcp-server      │ ◄───────────────► │ QuantowerMcpBridge (plugin C#)│
│ Claude / Cursor      │                 │ TypeScript + MCP SDK      │  127.0.0.1:8765   │ dans Quantower (Core.Instance)│
└──────────────────────┘                 └───────────────────────────┘                   └───────────────────────────────┘
```

- **`bridge/QuantowerMcpBridge`** — plugin C# : expose une API HTTP JSON sur la boucle locale
  (`http://localhost:8765`, ainsi que `http://127.0.0.1:8765` et `http://[::1]:8765`), authentifiée par un
  token Bearer généré au démarrage, avec plafonds, écriture désactivée par défaut et journal d'audit.
- **`src/`** — serveur MCP TypeScript (`@modelcontextprotocol/sdk`), transport stdio, client HTTP du bridge
  (timeouts, retries sur les GET uniquement, cache TTL court).

---

## Prérequis

| Composant | Version | Usage |
|---|---|---|
| Node.js | ≥ 20 | serveur MCP |
| .NET SDK | ≥ 8 | bridge C# (`bridge/QuantowerMcpBridge`) |
| Quantower | récente (Windows) | bridge réel ; l'extension VS **Quantower Algo** est gratuite |
| Windows 10/11 | — | Quantower et le bridge sont Windows-only |

Le bridge **compile et s'exécute sans Quantower** en mode stub (données de démonstration) : utile pour
développer le serveur MCP et les tests.

---

## Démarrage rapide (développement sans Quantower)

```bash
# 1. Serveur MCP
npm install
npm run build

# 2. Bridge factice (fixtures JSON) sur le port 8765
node scripts/fake-bridge.mjs --port 8765 --token dev-token

# 3. Dans un autre terminal : smoke test du contrat HTTP
node scripts/smoke-bridge.mjs --url http://127.0.0.1:8765 --token dev-token
```

Puis lancez le serveur MCP avec :

```bash
QUANTOWER_BRIDGE_URL=http://127.0.0.1:8765 QUANTOWER_BRIDGE_TOKEN=dev-token node dist/server.js
```

> Alternative : le bridge C# en mode stub (mêmes données, code de production côté HTTP) :
> `dotnet run --project bridge/QuantowerMcpBridge -- --port 8765 --token dev-token`
> (ajoutez `--trading` pour activer l'écriture — désactivée par défaut côté bridge, comme côté MCP).

Pour inspecter les outils sans client MCP :

```bash
npm run inspector
```

---

## Installation du bridge dans Quantower

La procédure complète (build avec le SDK Quantower, déploiement, checklist **Phase 0**) est dans
**[`bridge/README.md`](bridge/README.md)**. Résumé :

1. Compiler le bridge :
   `dotnet build bridge/QuantowerMcpBridge/QuantowerMcpBridge.csproj -p:QuantowerSdkDir="C:\Program Files\Quantower\Trading Platform"`
2. Charger le module dans Quantower (extension VS « Quantower Algo » ou dossier de modules — **à valider en Phase 0**).
3. Vérifier que le bridge répond : `node scripts/smoke-bridge.mjs --url http://127.0.0.1:8765 --token <token>`.
4. Reporter le token (`%LOCALAPPDATA%\quantower-mcp\bridge-token`) dans la config du serveur MCP.

---

## Configuration

Variables d'environnement du serveur MCP (`src/config.ts`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `QUANTOWER_BRIDGE_URL` | `http://127.0.0.1:8765` | URL du bridge (loopback uniquement). |
| `QUANTOWER_BRIDGE_TOKEN` | — | Token Bearer. Prioritaire sur le fichier. |
| `QUANTOWER_BRIDGE_TOKEN_FILE` | `%LOCALAPPDATA%\quantower-mcp\bridge-token` | Fichier de token écrit par le bridge (relu à chaque appel). |
| `QUANTOWER_BRIDGE_TIMEOUT_MS` | `15000` | Timeout par appel. |
| `QUANTOWER_RETRY_COUNT` | `2` | Retries des GET idempotents (**jamais** sur les écritures). |
| `QUANTOWER_CACHE_TTL_MS` | `1000` | Durée du cache des lectures (`0` = désactivé). |
| `QUANTOWER_TRADING_ENABLED` | `false` | `true` = enregistre les tools d'écriture. |
| `QUANTOWER_READ_ONLY` | `false` | `true` = force la lecture seule même si le trading est demandé. |
| `QUANTOWER_MAX_ORDER_QUANTITY` | `50` | Plafond de quantité par ordre (`0` = désactivé). |
| `QUANTOWER_MAX_NOTIONAL` | `50000` | Plafond de notionnel estimé (`0` = désactivé). |
| `QUANTOWER_DENY_MARKET_ORDERS` | `false` | `true` = interdit les ordres Market. |
| `QUANTOWER_MAX_BARS` | `500` | Nombre maximum de barres par appel d'historique. |
| `QUANTOWER_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` (logs sur **stderr**). |

**Pour autoriser l'écriture** : `QUANTOWER_TRADING_ENABLED=true` (et ne pas mettre `QUANTOWER_READ_ONLY=true`).

---

## Configuration des clients MCP

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "quantower": {
      "command": "node",
      "args": ["C:\\Users\\<vous>\\Documents\\Projects\\quantower-mcp\\dist\\server.js"],
      "env": {
        "QUANTOWER_BRIDGE_URL": "http://127.0.0.1:8765",
        "QUANTOWER_BRIDGE_TOKEN": "<token du bridge>",
        "QUANTOWER_LOG_LEVEL": "info"
      }
    }
  }
}
```

### Cursor (`.cursor/mcp.json` ou config utilisateur)

```json
{
  "mcpServers": {
    "quantower": {
      "command": "node",
      "args": ["C:\\Users\\<vous>\\Documents\\Projects\\quantower-mcp\\dist\\server.js"],
      "env": {
        "QUANTOWER_BRIDGE_TOKEN_FILE": "C:\\Users\\<vous>\\AppData\\Local\\quantower-mcp\\bridge-token"
      }
    }
  }
}
```

> Le serveur MCP peut relire lui-même le fichier de token écrit par le bridge : c'est la configuration
> recommandée si le bridge change de token à chaque démarrage.

---

## Sécurité et garde-fous

| Garde-fou | Détail |
|---|---|
| **Lecture seule par défaut** | Les tools d'écriture ne sont **pas enregistrés** tant que `QUANTOWER_TRADING_ENABLED` n'est pas `true`. |
| **`confirm: true` obligatoire** | Chaque tool d'écriture refuse l'appel sinon (`CONFIRMATION_REQUIRED`), avec un message explicite. |
| **Plafonds** | `QUANTOWER_MAX_ORDER_QUANTITY`, `QUANTOWER_MAX_NOTIONAL` (contrôlé aussi pour les ordres Market via le carnet), `QUANTOWER_DENY_MARKET_ORDERS`. |
| **Double contrôle côté bridge** | Le bridge C# revalide plafonds (y compris sur les modifications d'ordre) et cohérence compte/symbole, et **refuse l'écriture par défaut** ; activez-la explicitement avec `QUANTOWER_BRIDGE_TRADING_ENABLED=true`. |
| **Loopback uniquement** | Le bridge enregistre les préfixes `localhost`, `127.0.0.1` et `[::1]` (HTTP.SYS compare l'en-tête Host) et rejette toute IP distante (403). |
| **Token par session** | Token aléatoire généré au démarrage du bridge, écrit dans `%LOCALAPPDATA%\quantower-mcp\bridge-token` (comparaison à temps constant). |
| **Audit** | Chaque opération d'écriture est journalisée dans `%LOCALAPPDATA%\quantower-mcp\audit.log` (JSON lines). |
| **Démo uniquement** | Les tests d'écriture ne doivent viser qu'un **compte démo / Trading Simulator** — jamais un compte réel. |
| **Pas de rejeu d'écriture** | Aucun retry automatique sur les opérations d'ordre : impossible d'envoyer deux fois le même ordre. |

---

## Outils, ressources et prompts exposés

**Lecture** (toujours disponibles)

| Tool | Description |
|---|---|
| `quantower_status` | Santé du bridge, version, mode (`read_only`/`trading`), connexions. |
| `quantower_list_connections` | Connexions actives et `connectionId`. |
| `quantower_list_accounts` | Comptes (balance, devise, PnL). |
| `quantower_search_symbols` | Recherche d'instruments. |
| `quantower_get_quote` | Bid/Ask/Last/volume. |
| `quantower_get_history` | Bougies OHLCV (timeframes `1m`…`1w`, limite ≤ `QUANTOWER_MAX_BARS`). |
| `quantower_get_dom` | Carnet d'ordres (Level 2). |
| `quantower_get_positions` / `quantower_get_orders` / `quantower_get_orders_history` / `quantower_get_trades` | Portefeuille et exécutions. |

**Écriture** (uniquement si `QUANTOWER_TRADING_ENABLED=true`, `confirm: true` requis)

| Tool | Description |
|---|---|
| `quantower_place_order` | Market / Limit / Stop / StopLimit + SL/TP (`price` ou `offsetTicks`). |
| `quantower_modify_order` | Modification quantité/prix/déclencheur/TIF. |
| `quantower_cancel_order` | Annulation d'un ordre. |
| `quantower_cancel_all_orders` | Annulation groupée (filtre `connectionId`/`accountId` obligatoire). |
| `quantower_close_position` | Fermeture totale ou partielle. |
| `quantower_close_all_positions` | Fermeture groupée (filtre obligatoire). |

**Ressources** : `quantower://connections`, `quantower://accounts`, `quantower://positions`, `quantower://orders`,
`quantower://symbols/{connectionId}/{symbolId}`.

**Prompts** : `briefing-marche`, `revue-positions`, `checklist-avant-ordre`.

---

## Tests, scripts et inspection

```bash
npm test              # vitest (mock bridge + fixtures, sans réseau externe)
npm run typecheck     # tsc --noEmit sur src + tests
npm run build         # compilation du serveur MCP dans dist/
npm run inspector     # @modelcontextprotocol/inspector
npm run fake-bridge   # bridge factice sur 8765 (token dev-token)
npm run smoke-bridge  # vérifie le contrat HTTP du bridge
```

Les fixtures `scripts/fixtures/*.json` **figent le contrat DTO** bridge ↔ MCP : toute évolution doit être
répercutée dans le bridge C#, `src/bridge-types.ts` et les fixtures.

---

## Dépannage

| Symptôme | Cause probable | Action |
|---|---|---|
| `[BRIDGE_UNAVAILABLE]` | Quantower fermé, module non chargé, mauvais port | Lancez Quantower avec le bridge, vérifiez `QUANTOWER_BRIDGE_URL` et `scripts/smoke-bridge.mjs`. |
| `[BRIDGE_UNAUTHORIZED]` | Token absent/différent | Copiez `%LOCALAPPDATA%\quantower-mcp\bridge-token` dans `QUANTOWER_BRIDGE_TOKEN`, ou pointez `QUANTOWER_BRIDGE_TOKEN_FILE` dessus. |
| `[NOT_FOUND]` | `connectionId`/`symbolId`/`orderId` inconnu | Utilisez `quantower_list_connections` et `quantower_search_symbols`. |
| `[TIMEOUT]` | Historique trop volumineux | Réduisez `limit` ou augmentez `QUANTOWER_BRIDGE_TIMEOUT_MS`. |
| `[INVALID_STATE]` | Ordre déjà annulé/terminé | Rechargez l'état avec `quantower_get_orders`. |
| `[TRADING_DISABLED]` | Mode read_only (MCP) ou écriture désactivée côté bridge | MCP : `QUANTOWER_TRADING_ENABLED=true` puis redémarrez le serveur MCP ; bridge : `QUANTOWER_BRIDGE_TRADING_ENABLED=true` (défaut `false`) puis relancez le bridge. |
| `[LIMIT_EXCEEDED]` | Plafond dépassé | Réduisez la taille ou ajustez les plafonds. |
| Erreur d'accès refusé au démarrage du bridge | Réservation URL HTTP.SYS | Une réservation par préfixe : `netsh http add urlacl url=http://localhost:8765/ user=%USERNAME%`, puis idem pour `http://127.0.0.1:8765/` et `http://[::1]:8765/` (voir `bridge/README.md`). |

---

## Structure du dépôt

```
quantower-mcp/
├── bridge/QuantowerMcpBridge/   # plugin C# (Dtos/, HttpServer.cs, CoreGateway.cs, StubCoreGateway.cs, …)
├── src/                         # serveur MCP TypeScript (tools/, resources/, prompts/)
├── tests/                       # vitest + mock bridge (fixtures partagées)
├── scripts/                     # fake-bridge, smoke-bridge, fixtures JSON
├── README.md
└── package.json  tsconfig.json  vitest.config.ts
```

---

## Roadmap et hors scope

| Phase | Contenu | État |
|---|---|---|
| 0 | Cadrage + spike bridge dans Quantower | à valider (voir `bridge/README.md`) |
| 1 | Bridge lecture (HTTP JSON complet) | implémenté (stub exécutable ; accès réel à finaliser en Phase 0) |
| 2 | Serveur MCP lecture + resources + tests | implémenté |
| 3 | Bridge écriture (plafonds, audit) | implémenté (stub exécutable ; accès réel à finaliser) |
| 4 | Serveur MCP écriture + prompts | implémenté |
| 5 | Documentation, packaging, E2E | documentation faite ; packaging optionnel |

**Hors scope v1** : pilotage de l'UI (panneaux, graphiques, drawings), backtests/optimisation, streaming
de ticks via WebSocket (`/events` renvoie `501 NOT_IMPLEMENTED`), multi-comptes distants, exposition
réseau, publication npm/Marketplace.
