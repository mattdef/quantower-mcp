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
3. [Installation](#installation)
4. [Démarrage rapide (développement sans Quantower)](#démarrage-rapide-développement-sans-quantower)
5. [Installation du bridge dans Quantower](#installation-du-bridge-dans-quantower)
6. [Configuration](#configuration)
7. [Configuration des clients MCP](#configuration-des-clients-mcp)
8. [Sécurité et garde-fous](#sécurité-et-garde-fous)
9. [Outils, ressources et prompts exposés](#outils-ressources-et-prompts-exposés)
10. [Tests, scripts et inspection](#tests-scripts-et-inspection)
11. [Dépannage](#dépannage)
12. [Structure du dépôt](#structure-du-dépôt)
13. [Roadmap et hors scope](#roadmap-et-hors-scope)

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
| .NET SDK | ≥ 8 (10 pour les Quantower récents) | bridge C# (`bridge/QuantowerMcpBridge`) |
| Quantower | récente (Windows) | bridge réel ; l'extension VS **Quantower Algo** est gratuite |
| Windows 10/11 | — | Quantower et le bridge sont Windows-only |

Le bridge **compile et s'exécute sans Quantower** en mode stub (données de démonstration) : utile pour
développer le serveur MCP et les tests.

---

## Installation

Seul **Node.js ≥ 20** est requis pour le serveur MCP. Deux chemins selon votre usage :

### Installation en une commande (Windows, recommandé)

Si vous êtes sous Windows et voulez le **bridge Quantower** *et* le **serveur MCP** configurés
sans rien faire à la main :

```powershell
git clone https://github.com/mattdef/quantower-mcp.git
cd quantower-mcp
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

(ou, depuis une invite `cmd` : `install.cmd`)

Le script **PowerShell 5.1+**, idempotent et non destructif :

1. vérifie les prérequis (Node.js ≥ 20, .NET SDK ≥ 8, git) ;
2. détecte votre installation Quantower (`C:\Quantower`, `%ProgramFiles%\Quantower`, `%ProgramFiles(x86)%\Quantower`) ;
3. compile le bridge avec le SDK détecté et déploie le module dans `bin\plug-ins\QuantowerMcpBridge\` ;
4. compile le serveur MCP (`npm install`, `npm run build`) ;
5. configure les clients détectés (OpenCode, Claude Code, Codex, Claude Desktop) — **lecture seule**
   (`QUANTOWER_TRADING_ENABLED=false`) et **sans aucun secret** (le serveur relit
   `%LOCALAPPDATA%\quantower-mcp\bridge-token`) ; chaque fichier modifié est sauvegardé en
   `.bak-<horodatage>` ;
6. vérifie `/health`, lance le smoke test (lecture) et affiche les réservations
   `netsh http add urlacl` nécessaires ;
7. récapitule ce qui a été fait et ce qui reste manuel : **redémarrage de Quantower** (le script ne
   ferme jamais Quantower) puis redémarrage des clients MCP.

Options : `-DryRun` (simulation complète, aucune écriture), `-Demo` (démonstration sans Quantower,
bridge factice), `-SkipClients` (ne pas toucher aux configs clients), `-SetUrlAcl` (exécuter les
`netsh http add urlacl` — console administrateur), `-Port 8765` (port local par défaut).

> Les **chemins A et B** ci-dessous restent la référence pour un usage manuel, en CI ou pour une
> configuration personnalisée.

### Chemin A — clone local (usage manuel ou CI)

```bash
git clone https://github.com/mattdef/quantower-mcp.git
cd quantower-mcp
npm install
npm run build
node dist/server.js
```

Le clone est aussi nécessaire pour le bridge C# (`bridge/`), les scripts de développement (`scripts/`) et
`npm run inspector`. C'est le chemin le plus stable : la recette `npx github:` (Chemin B) est bloquée par
défaut sur npm ≥ 12 (voir [Dépannage](#dépannage)).

### Chemin B — sans clone (`npx github:`)

Le serveur se lance directement depuis GitHub (aucune publication npm nécessaire) :

```bash
npx -y github:mattdef/quantower-mcp
```

npm clone le dépôt, compile le TypeScript puis démarre `dist/server.js` sur stdio. En pratique, c'est le
**client MCP** qui exécute cette commande pour vous : appliquez la recette de votre client —
[OpenCode](#opencode), [Claude Code](#claude-code), [Codex](#codex),
[Claude Desktop](#claude-desktop-claude_desktop_configjson),
[Cursor](#cursor-cursormcpjson-ou-config-utilisateur).

> ⚠️ **npm ≥ 12** : les sources git sont refusées par défaut (`allow-git=none` → `EALLOWGIT`) et le
> `prepare` (build) d'une source git n'est exécuté qu'après approbation explicite des scripts. Cette
> recette nécessite donc un opt-in npm (voir [Dépannage](#dépannage)) ; sur npm ≤ 11, elle fonctionne
> (avertissements possibles sur les 11.x récents). En cas de doute, utilisez le **Chemin A**.

### Ensuite

1. **Bridge** : bridge C# dans Quantower (voir [Installation du bridge](#installation-du-bridge-dans-quantower))
   ou bridge factice pour tester sans Quantower (voir [Démarrage rapide](#démarrage-rapide-développement-sans-quantower)).
2. **Vérification du bridge** : `node scripts/smoke-bridge.mjs --url http://127.0.0.1:8765 --token <token>` (Chemin A) — substituez `<token>` par la valeur du fichier `%LOCALAPPDATA%\quantower-mcp\bridge-token` (`smoke-bridge.mjs` ne relit pas ce fichier : il n'accepte que `--token` ou `QUANTOWER_BRIDGE_TOKEN`) ; sous PowerShell : `--token (Get-Content "$env:LOCALAPPDATA\quantower-mcp\bridge-token")`.
3. **Client MCP** : copiez une recette depuis [Configuration des clients MCP](#configuration-des-clients-mcp).

---

## Démarrage rapide (développement sans Quantower)

Ordre recommandé, de zéro à un client MCP branché :

1. **Prérequis** : Node.js ≥ 20 (`node --version`) — puis, dans le clone local :
   `npm install` puis `npm run build`.
2. **Bridge** : bridge factice (fixtures JSON) sur le port 8765, à laisser tourner dans son terminal :
   `node scripts/fake-bridge.mjs --port 8765 --token dev-token`.
3. **Smoke test** (dans un second terminal) : `node scripts/smoke-bridge.mjs --url http://127.0.0.1:8765 --token dev-token`.
4. **Serveur MCP** (optionnel : le client MCP le lance lui-même) — sous PowerShell (cible Windows) :

   ```powershell
   $env:QUANTOWER_BRIDGE_URL="http://127.0.0.1:8765"; $env:QUANTOWER_BRIDGE_TOKEN="dev-token"; node dist/server.js
   ```

   bash / Git Bash :
   `QUANTOWER_BRIDGE_URL=http://127.0.0.1:8765 QUANTOWER_BRIDGE_TOKEN=dev-token node dist/server.js`.
5. **Client MCP** : appliquez une recette de [Configuration des clients MCP](#configuration-des-clients-mcp)
   (OpenCode, Claude Code, Codex, Claude Desktop, Cursor).
6. **Vérification** : `opencode mcp list`, `claude mcp list` ou `codex mcp list` — le serveur `quantower`
   doit apparaître (sinon `/mcp` dans le client). En secours, sans client : `npm run inspector`.

> Le token `dev-token` ci-dessus n'est utile qu'avec le bridge factice. Avec le bridge C# réel, le serveur
> relit tout seul `%LOCALAPPDATA%\quantower-mcp\bridge-token` : aucun token à copier dans une config.

> Alternative : le bridge C# en mode stub (mêmes données, code de production côté HTTP) :
> `dotnet run --project bridge/QuantowerMcpBridge -- --port 8765 --token dev-token`
> (ajoutez `--trading` pour activer l'écriture — désactivée par défaut côté bridge, comme côté MCP).

---

## Installation du bridge dans Quantower

La procédure complète (build avec le SDK Quantower, déploiement, checklist **Phase 0**) est dans
**[`bridge/README.md`](bridge/README.md)**. Résumé :

1. Compiler le bridge :
   `dotnet build bridge/QuantowerMcpBridge/QuantowerMcpBridge.csproj -c Release -p:QuantowerSdkDir="C:\Quantower\TradingPlatform\v1.146.18\bin"`
   (en mode SDK, le projet cible `net10.0` et produit `QuantowerMcpBridge.dll`).
2. Copier `QuantowerMcpBridge.dll` dans `<QuantowerSdkDir>\plug-ins\QuantowerMcpBridge\`, **redémarrer
   Quantower** puis ouvrir **une fois** le panneau « Quantower MCP Bridge » (*Ajouter un panneau*) :
   son ouverture démarre le bridge, sa fermeture l'arrête (classe de base `Plugin` — fait vérifié,
   voir [`bridge/README.md`](bridge/README.md) §4).
3. Vérifier que le bridge répond : `node scripts/smoke-bridge.mjs --url http://127.0.0.1:8765 --token <token>` — substituez `<token>` par la valeur du fichier `%LOCALAPPDATA%\quantower-mcp\bridge-token` (`smoke-bridge.mjs` ne relit pas ce fichier) ; sous PowerShell : `--token (Get-Content "$env:LOCALAPPDATA\quantower-mcp\bridge-token")`.
4. Côté config MCP, rien à copier : le serveur MCP relit automatiquement `%LOCALAPPDATA%\quantower-mcp\bridge-token` (voir [Dépannage](#dépannage) en cas de `[BRIDGE_UNAUTHORIZED]`).

> Tout ce qui précède est automatisé par `install.ps1` (voir
> [Installation en une commande](#installation-en-une-commande-windows-recommandé)).

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

> **Aucun secret dans les configs** : le serveur relit par défaut le token écrit par le bridge
> (`%LOCALAPPDATA%\quantower-mcp\bridge-token`). Toutes les recettes ci-dessous restent en **lecture seule**
> (`QUANTOWER_TRADING_ENABLED=false`). Fichiers prêts à copier dans [`examples/`](examples/).

> **Placeholder `<vous>`** : dans ce README comme dans les fichiers `examples/`, remplacez `<vous>` par votre
> nom de session Windows (par exemple `mcast`) ; si un chemin contient des espaces, entourez-le de guillemets
> doubles.

Variables d'environnement les plus utilisées (tableau complet : [Configuration](#configuration)) :

| Variable | Défaut | Rôle |
|---|---|---|
| `QUANTOWER_BRIDGE_URL` | `http://127.0.0.1:8765` | URL du bridge (loopback uniquement). |
| `QUANTOWER_BRIDGE_TOKEN_FILE` | `%LOCALAPPDATA%\quantower-mcp\bridge-token` | **Recommandé** : relu à chaque appel — aucun secret à écrire dans une config. |
| `QUANTOWER_BRIDGE_TOKEN` | — | Token en clair, prioritaire sur le fichier. Réservé au développement : ne jamais committer. |
| `QUANTOWER_TRADING_ENABLED` | `false` | `true` = enregistre les tools d'écriture (démo uniquement). |
| `QUANTOWER_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` (logs sur stderr). |

### OpenCode

Config projet `opencode.jsonc` (ou globale `~/.config/opencode/opencode.json`). Fichier complet :
[`examples/opencode.jsonc`](examples/opencode.jsonc).

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "quantower": {
      "type": "local",
      "command": ["node", "C:\\Users\\<vous>\\Documents\\Projects\\quantower-mcp\\dist\\server.js"],
      "enabled": true,
      "environment": {
        "QUANTOWER_BRIDGE_URL": "http://127.0.0.1:8765",
        "QUANTOWER_TRADING_ENABLED": "false"
      }
    }
  }
}
```

- CLI : `opencode mcp add quantower --env QUANTOWER_BRIDGE_URL=http://127.0.0.1:8765 --env QUANTOWER_TRADING_ENABLED=false -- node C:\Users\<vous>\Documents\Projects\quantower-mcp\dist\server.js`
  (ajoutez `--global` pour la config globale), puis `opencode mcp list`.
- Variante sans clone : `"command": ["npx", "-y", "github:mattdef/quantower-mcp"]` — sur npm ≥ 12, opt-in npm requis (voir [Dépannage](#dépannage), `EALLOWGIT`).
- Substitution de variable machine : `"environment": { "QUANTOWER_BRIDGE_URL": "{env:QUANTOWER_BRIDGE_URL}" }`.
- Désactivation temporaire : passer `"enabled"` à `false`.

### Claude Code

Claude Code stocke lui-même les serveurs MCP (pas de fichier à éditer à la main). Recette détaillée :
[`examples/claude-code.md`](examples/claude-code.md).

```bash
claude mcp add quantower --transport stdio --scope user --env QUANTOWER_BRIDGE_URL=http://127.0.0.1:8765 --env QUANTOWER_TRADING_ENABLED=false -- node "C:\Users\<vous>\Documents\Projects\quantower-mcp\dist\server.js"
```

> À taper sur **une seule ligne** : ni PowerShell ni `cmd` ne comprennent les continuations `\`
> (réservées à bash / Git Bash).

- Scopes : `local` (défaut, projet courant), `project` (`.mcp.json` versionnable), `user` (global).
- Équivalent `.mcp.json` de projet (`claude mcp add-json quantower '<objet>' -s project`) :

```json
{
  "mcpServers": {
    "quantower": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\<vous>\\Documents\\Projects\\quantower-mcp\\dist\\server.js"],
      "env": {
        "QUANTOWER_BRIDGE_URL": "http://127.0.0.1:8765",
        "QUANTOWER_TRADING_ENABLED": "false"
      }
    }
  }
}
```

- Variante sans clone : terminer par `-- npx -y github:mattdef/quantower-mcp` — sur npm ≥ 12, opt-in npm requis (voir [Dépannage](#dépannage), `EALLOWGIT`).
- Vérification : `claude mcp list`, `claude mcp get quantower`, ou `/mcp` dans la TUI.

### Codex

Extrait à fusionner dans `~/.codex/config.toml`. Fichier complet :
[`examples/codex-config.toml`](examples/codex-config.toml).

```toml
[mcp_servers.quantower]
command = "node"
args = ["C:\\Users\\<vous>\\Documents\\Projects\\quantower-mcp\\dist\\server.js"]
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 30

[mcp_servers.quantower.env]
QUANTOWER_BRIDGE_URL = "http://127.0.0.1:8765"
QUANTOWER_TRADING_ENABLED = "false"
```

- CLI : `codex mcp add quantower --env QUANTOWER_BRIDGE_URL=http://127.0.0.1:8765 -- node C:\Users\<vous>\Documents\Projects\quantower-mcp\dist\server.js`,
  puis `codex mcp list` (ou `/mcp` dans l'interface).
- Variante sans clone : `command = "npx"`, `args = ["-y", "github:mattdef/quantower-mcp"]` — sur npm ≥ 12, opt-in npm requis (voir [Dépannage](#dépannage), `EALLOWGIT`).
- Hériter d'une variable d'environnement hôte sans l'écrire dans le TOML : `env_vars = ["QUANTOWER_BRIDGE_TOKEN"]`
  (dans `[mcp_servers.quantower]`). Recommandé : ne rien mettre — le fichier de token par défaut suffit.

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "quantower": {
      "command": "node",
      "args": ["C:\\Users\\<vous>\\Documents\\Projects\\quantower-mcp\\dist\\server.js"],
      "env": {
        "QUANTOWER_BRIDGE_URL": "http://127.0.0.1:8765",
        "QUANTOWER_BRIDGE_TOKEN_FILE": "C:\\Users\\<vous>\\AppData\\Local\\quantower-mcp\\bridge-token",
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
| `[BRIDGE_UNAVAILABLE]` | Quantower fermé, module non chargé, mauvais port | Lancez Quantower avec le bridge, vérifiez `QUANTOWER_BRIDGE_URL` et `scripts/smoke-bridge.mjs` (Chemin A). Après une installation : le module n'est chargé qu'au **démarrage** de Quantower — redémarrez-le (jamais automatisé), vérifiez `<QuantowerSdkDir>\plug-ins\QuantowerMcpBridge\QuantowerMcpBridge.dll`, puis relancez `install.ps1 -SkipClients` pour re-tester `/health`. |
| `[BRIDGE_UNAUTHORIZED]` | Token absent/différent | Par défaut rien à configurer : le serveur relit `%LOCALAPPDATA%\quantower-mcp\bridge-token`. Si le bridge écrit ailleurs, pointez `QUANTOWER_BRIDGE_TOKEN_FILE` dessus (préférable à `QUANTOWER_BRIDGE_TOKEN`, un secret en clair dans la config). |
| `[NOT_FOUND]` | `connectionId`/`symbolId`/`orderId` inconnu | Utilisez `quantower_list_connections` et `quantower_search_symbols`. |
| `[TIMEOUT]` | Historique trop volumineux | Réduisez `limit` ou augmentez `QUANTOWER_BRIDGE_TIMEOUT_MS`. |
| `[INVALID_STATE]` | Ordre déjà annulé/terminé | Rechargez l'état avec `quantower_get_orders`. |
| `[TRADING_DISABLED]` | Mode read_only (MCP) ou écriture désactivée côté bridge | MCP : `QUANTOWER_TRADING_ENABLED=true` puis redémarrez le serveur MCP ; bridge : `QUANTOWER_BRIDGE_TRADING_ENABLED=true` (défaut `false`) puis relancez le bridge. |
| `[LIMIT_EXCEEDED]` | Plafond dépassé | Réduisez la taille ou ajustez les plafonds. |
| Erreur d'accès refusé au démarrage du bridge | Réservation URL HTTP.SYS | Une réservation par préfixe : `netsh http add urlacl url=http://localhost:8765/ user=%USERNAME%`, puis idem pour `http://127.0.0.1:8765/` et `http://[::1]:8765/` (voir `bridge/README.md`). `install.ps1` détecte les réservations manquantes et affiche ces commandes exactes (`-SetUrlAcl` pour les exécuter depuis une console administrateur). |
| `npx` introuvable côté client (Windows) | Le client n'exécute pas `npx.cmd` | Utilisez `cmd /c npx` ou `npx.cmd` dans la recette, ou restez sur le Chemin A (clone local, sans `npx`). |
| `npm error code EALLOWGIT` (recette `npx -y github:…` sur npm ≥ 12) | npm ≥ 12 refuse les sources git par défaut (`allow-git=none`) et n'exécute pas le `prepare` (build) d'une source git sans approbation des scripts | Chemin A (clone local) : fiable quel que soit npm. Sinon opt-in via un `.npmrc` **utilisateur** (une recette `npx` n'a pas de `package.json` de projet) : `allow-git` (`all`/`root`, pas de ciblage par dépôt) + `allow-scripts` ; la préparation d'une source git peut néanmoins rester bloquée (`EALLOWSCRIPTS`, npm/cli#9783). |
| `npx` échoue sans message (binaire introuvable) | Politique npm `allow-scripts` : le script `prepare` (build) n'est pas exécuté, `dist/` reste vide | Chemin A : `npm install`, `npm run build`, puis `node dist/server.js` (ou `npm start`). |
| Serveur absent de `opencode mcp list` / `claude mcp list` / `codex mcp list` | Config invalide ou non rechargée | Vérifiez la syntaxe (JSONC/JSON/TOML) puis relancez le client ; rejouez la commande de la recette à la main pour voir l'erreur. |
| `node` introuvable ou version < 20 | Node.js absent ou trop ancien | Installez Node.js ≥ 20 (`node --version` doit répondre). |
| Échec de spawn si le chemin contient des espaces | Chemin non quoté dans la config client | Entourez le chemin de guillemets dans la config ; alternative : recette `npx` (Chemin B — sur npm ≥ 12, opt-in npm requis, voir `EALLOWGIT`). |
| Premier lancement lent (Codex) | Recette `npx` (Chemin B) : clone + compile le serveur au premier appel | Augmentez `startup_timeout_sec` (ex. 60) le temps du premier lancement. |

---

## Structure du dépôt

```
quantower-mcp/
├── bridge/QuantowerMcpBridge/   # plugin C# (Dtos/, HttpServer.cs, CoreGateway.cs, StubCoreGateway.cs, …)
├── examples/                    # recettes de config clients (opencode.jsonc, claude-code.md, codex-config.toml)
├── src/                         # serveur MCP TypeScript (tools/, resources/, prompts/)
├── tests/                       # vitest + mock bridge (fixtures partagées)
├── scripts/                     # fake-bridge, smoke-bridge, fixtures JSON
├── LICENSE
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
