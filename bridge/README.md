# QuantowerMcpBridge — plugin C# pour Quantower

Bridge local qui expose `Core.Instance` (API `TradingPlatform.BusinessLayer`) sous forme d'**API HTTP JSON
sur la boucle locale**, consommée par le serveur MCP `quantower-mcp-server`.

```
Quantower (process)                        Autre process
┌───────────────────────────┐    HTTP     ┌────────────────────────┐
│ BridgePlugin              │  127.0.0.1  │ quantower-mcp-server   │
│  └── HttpServer ← CoreGateway ← Core    │ (src/, transport stdio)│
└───────────────────────────┘   8765      └────────────────────────┘
```

Points clés : bind **loopback uniquement**, **token Bearer** généré à la session, **plafonds** de trading,
**journal d'audit**, exécution des appels `Core` sérialisée sur le thread UI (voir `SynchronizationContextScheduler`).

---

## 1. Prérequis

- Windows 10/11, Quantower installé.
- .NET SDK 8 (ou plus récent) pour compiler le bridge en mode stub ; pour le mode SDK réel,
  installez le SDK .NET correspondant à votre version de Quantower (ex. v1.146.18 → .NET 10).
- **Compilation isolée uniquement** : aucun prérequis supplémentaire (mode stub).

---

## 2. Compiler et exécuter sans Quantower (mode stub)

Le bridge est conçu pour être développé sans Quantower : `StubCoreGateway` fournit des données
déterministes (1 connexion, 1 compte, 3 symboles, 1 position, 1 ordre actif, historique généré).

```bash
# Compilation (aucun SDK Quantower requis)
dotnet build bridge/QuantowerMcpBridge/QuantowerMcpBridge.csproj

# Exécution (le bridge réel est remplacé par le stub)
dotnet run --project bridge/QuantowerMcpBridge -- --port 8765 --token dev-token

# Vérification du contrat HTTP
node scripts/smoke-bridge.mjs --url http://127.0.0.1:8765 --token dev-token
```

Options du host standalone : `--port`, `--token`, `--latency <ms>`, `--trading`, `--no-trading`, `--help`.

> L'**écriture est désactivée par défaut** côté bridge (même posture que le serveur MCP) : sans
> `--trading` ni `QUANTOWER_BRIDGE_TRADING_ENABLED=true`, place/modify/cancel/close répondent
> 403 `TRADING_DISABLED`. Le cycle d'écriture du smoke test ci-dessous exige donc de démarrer le
> bridge avec `--trading`.

Côté serveur MCP :

```bash
QUANTOWER_BRIDGE_URL=http://127.0.0.1:8765 QUANTOWER_BRIDGE_TOKEN=dev-token node dist/server.js
```

---

## 3. Compiler avec le vrai SDK Quantower

Les fichiers `QuantowerCoreGateway.cs` (accès réel à `Core.Instance`) et `BridgePlugin.cs` (module
Quantower, classe de base `Plugin`) ne sont compilés que si la propriété MSBuild `QuantowerSdkDir`
est fournie :

```powershell
dotnet build bridge/QuantowerMcpBridge/QuantowerMcpBridge.csproj -c Release -p:QuantowerSdkDir="C:\Quantower\TradingPlatform\v1.146.18\bin"
```

- `QuantowerSdkDir` doit contenir `TradingPlatform.BusinessLayer.dll` **et**
  `TradingPlatform.PresentationLayer.Plugins.dll` (assemblies `net10.0` du SDK v1.146.18).
- En mode SDK, le projet cible automatiquement **`net10.0`** (les assemblies v1.146.18 utilisent
  `System.Runtime 10.0.0.0`) et produit une **Library** (`QuantowerMcpBridge.dll`) ; le mode stub
  isolé reste un `Exe` `net8.0-windows`.
- SDK ciblant une autre version de .NET : préciser `-p:QuantowerTargetFramework=net8.0` (ou
  `net48` pour .NET Framework — référence `System.Text.Json` automatique).

### Déploiement (dossier `plug-ins`)

```powershell
$sdk = "C:\Quantower\TradingPlatform\v1.146.18\bin"
New-Item -ItemType Directory -Force "$sdk\plug-ins\QuantowerMcpBridge" | Out-Null
Copy-Item bridge\QuantowerMcpBridge\bin\Release\net10.0\QuantowerMcpBridge.dll "$sdk\plug-ins\QuantowerMcpBridge\" -Force
```

- Le dossier doit être nommé comme `PluginInfo.Name` / `AssemblyName` : `QuantowerMcpBridge`.
- **Redémarrez Quantower**, puis ouvrez **une fois** le panneau « Quantower MCP Bridge »
  (bouton *Ajouter un panneau*) : son ouverture appelle `Initialize()` et démarre le bridge HTTP ;
  le fermer appelle `Dispose()` et l'arrête (le panneau n'a pas d'interface — `BrowserUsageType.None`).
  Laissez-le ouvert dans votre espace de travail.
- Fermez Quantower avant la copie si le fichier est verrouillé ; `install.ps1` (racine du dépôt)
  automatise la compilation et cette copie (et ne ferme jamais Quantower lui-même).

---

## 4. Phase 0 — checklist de validation (prérequis bloquant)

Avant d'aller plus loin dans l'accès réel, valider les 4 incertitudes du plan §10 :

- [x] **(a) Déploiement/chargement du module — résolu** : la classe de base d'un module Quantower est
      `Plugin` (namespace `TradingPlatform.PresentationLayer.Plugins`), avec
      `public override void Initialize()` et `static PluginInfo GetInfo()`
      (faits vérifiés sur les exemples officiels `LinkingExamplePlugin` / `BrowserBasedPlugin`) ;
      déploiement par copie de `QuantowerMcpBridge.dll` dans `bin\plug-ins\QuantowerMcpBridge\`.
- [ ] **(b) Signatures réelles** : `Symbol.GetHistory(...)` / `HistoricalData`, `Core.GetOrdersHistory(...)`,
      `PlaceOrderRequestParameters`, `ModifyOrder` (type des paramètres), `SlTpHolder.CreateSL/CreateTP`.
      Toutes les zones `TODO(Phase 0)` de `QuantowerCoreGateway.cs` sont concernées.
- [ ] **(c) Thread UI** : confirmer que `Initialize()` s'exécute sur le thread UI et que le
      `SynchronizationContext` est bien pompé par la plateforme (sinon basculer sur `Application.Current.Dispatcher`
      ou l'API de dispatch Quantower).
- [ ] **(d) DepthOfMarket** : confirmer la structure et la disponibilité du Level 2 selon la licence ;
      sinon `/symbols/{id}/dom` renvoie une erreur explicite (`NOT_FOUND`/`NOT_IMPLEMENTED`).

**Critère de sortie Phase 0** : `GET /health` répond depuis un autre processus, les valeurs de
`/positions`, `/orders`, `/accounts` correspondent aux panneaux Quantower, et le bridge s'arrête proprement
avec le module.

### Repli documenté (plan §6 Phase 0)

Si le chargement d'un module custom s'avère impossible sur la version installée :

1. **Option B** : héberger le serveur MCP directement dans le plugin C# (`modelcontextprotocol/csharp-sdk`),
   sans processus Node ;
2. ou solution dégradée via **RTD Excel** de Quantower (lecture seule, pas de pilotage).

Dans les deux cas : documenter la contrainte constatée dans ce README avant d'adapter le code.

---

## 5. Configuration (variables d'environnement)

Lues au démarrage du bridge (`BridgeConfig.FromEnvironment`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `QUANTOWER_BRIDGE_PORT` | `8765` | Port d'écoute local. |
| `QUANTOWER_BRIDGE_HOST` | `localhost` | Hôte de l'URL de base ; les trois variantes loopback (`localhost`, `127.0.0.1`, `[::1]`) sont toujours enregistrées. Jamais une interface externe. |
| `QUANTOWER_BRIDGE_TOKEN` | généré | Token Bearer imposé (sinon génération + écriture dans le fichier). |
| `QUANTOWER_BRIDGE_TOKEN_FILE` | `%LOCALAPPDATA%\quantower-mcp\bridge-token` | Fichier de token lu par le serveur MCP. |
| `QUANTOWER_BRIDGE_AUDIT_LOG` | `%LOCALAPPDATA%\quantower-mcp\audit.log` | Journal d'audit (JSON lines) des opérations de trading. |
| `QUANTOWER_BRIDGE_TRADING_ENABLED` | `false` | `true` = endpoints d'écriture activés ; par défaut désactivés (403 `TRADING_DISABLED`). |
| `QUANTOWER_BRIDGE_MAX_ORDER_QUANTITY` | `50` | Plafond de quantité par ordre (`0` = désactivé). |
| `QUANTOWER_BRIDGE_MAX_NOTIONAL` | `50000` | Plafond de notionnel (`0` = désactivé). |
| `QUANTOWER_BRIDGE_DENY_MARKET_ORDERS` | `false` | `true` = ordres Market refusés (403 `MARKET_ORDERS_DENIED`). |
| `QUANTOWER_BRIDGE_MAX_HISTORY_BARS` | `500` | Limite haute de `/symbols/{id}/history`. |
| `QUANTOWER_BRIDGE_OPERATION_TIMEOUT_SECONDS` | `20` | Timeout d'une opération Core (au-delà : 504 `TIMEOUT`). |

---

## 6. Contrat HTTP (plan §3)

Auth : en-tête `Authorization: Bearer <token>` **sur toutes les routes** (y compris `/health`).
Réponses JSON camelCase ; erreurs `{ "error": { "code", "message", "details" } }`.

| Méthode | Route | Rôle | Quantower |
|---|---|---|---|
| GET | `/health` | état du bridge + version + plafonds | ping |
| GET | `/connections` | connexions et état | `Core.Connections.Connected` |
| GET | `/accounts?connectionId=` | comptes (balance, devise, PnL) | `Core.Accounts` |
| GET | `/symbols?q=&connectionId=&limit=` | recherche d'instruments | `Core.Symbols` |
| GET | `/symbols/{id}/quote?connectionId=` | Bid/Ask/Last/volume | `Symbol` |
| GET | `/symbols/{id}/history?timeframe=&from=&to=&limit=` | bougies OHLCV | `Symbol.GetHistory` |
| GET | `/symbols/{id}/dom?depth=` | carnet d'ordres | `DepthOfMarket` |
| GET | `/positions?connectionId=&accountId=` | positions ouvertes | `Core.Positions` |
| GET | `/orders?connectionId=&accountId=` | ordres en cours | `Core.Orders` |
| GET | `/orders/history?from=&to=&limit=` | historique des ordres | `Core.GetOrdersHistory` |
| GET | `/trades?limit=` | exécutions | `Core.Trades` |
| POST | `/orders` | passer un ordre | `Core.PlaceOrder(PlaceOrderRequestParameters)` |
| PATCH | `/orders/{id}` | modifier un ordre | `Core.ModifyOrder` |
| DELETE | `/orders/{id}` | annuler un ordre | `Core.CancelOrder` |
| POST | `/positions/{id}/close` | fermer une position (totale/partielle) | `Core.ClosePosition` |
| GET | `/events` | **501** — WebSocket prévu phase 4+/v2 | — |

Codes d'erreur : `BRIDGE_UNAUTHORIZED` (401), `FORBIDDEN` (403), `TRADING_DISABLED` (403),
`MARKET_ORDERS_DENIED` (403), `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `TRADING_LIMIT_EXCEEDED` (400),
`INVALID_STATE` (409), `PLATFORM_ERROR` (500), `TIMEOUT` (504), `NOT_IMPLEMENTED` (501).

Exemple de payload `POST /orders` :

```json
{
  "accountId": "ACC-DEMO-USD",
  "symbolId": "EUR/USD",
  "side": "buy",
  "orderType": "limit",
  "quantity": 0.1,
  "price": 1.07,
  "timeInForce": "gtc",
  "stopLoss": { "offsetTicks": 20 },
  "takeProfit": { "price": 1.12 },
  "comment": "exemple"
}
```

Réponse (mapping `TradingOperationResult`) :

```json
{ "status": "success", "message": "Ordre limit accepté", "orderId": "ORD-2001" }
```

---

## 7. Sécurité

- **Loopback uniquement** : préfixes HTTP.SYS `http://localhost:<port>/`, `http://127.0.0.1:<port>/` et
  `http://[::1]:<port>/` (HTTP.SYS compare l'en-tête Host, d'où l'enregistrement des trois), et rejet de
  toute IP distante (403).
- **Écriture désactivée par défaut** : comme le serveur MCP, le bridge refuse place/modify/cancel/close
  tant que `QUANTOWER_BRIDGE_TRADING_ENABLED=true` n'est pas défini explicitement (défense en profondeur opt-in).
- **Token par session** : aléatoire (32 octets) si `QUANTOWER_BRIDGE_TOKEN` n'est pas fourni ; écrit dans
  le fichier de token et comparé en temps constant côté serveur.
- **Plafonds** : quantité, notionnel (y compris ordres Market via le carnet) et interdiction des Market.
- **Audit** : `audit.log` contient chaque opération d'écriture (payload, résultat, IP locale).
- **Jamais de compte réel en développement** : validez exclusivement sur le Trading Simulator ou un compte démo.

---

## 8. Dépannage

| Symptôme | Cause | Action |
|---|---|---|
| `HttpListenerException: Accès refusé` au démarrage | Réservation URL HTTP.SYS | Une réservation **par préfixe** : `netsh http add urlacl url=http://localhost:8765/ user=%USERNAME%`, puis idem pour `http://127.0.0.1:8765/` et `http://[::1]:8765/`, puis relancez Quantower. |
| `Impossible d'écouter ... port déjà utilisé` | Deux bridges ou un autre service | Changez `QUANTOWER_BRIDGE_PORT`. |
| `401 BRIDGE_UNAUTHORIZED` dans le MCP | Token désynchronisé | Relisez `%LOCALAPPDATA%\quantower-mcp\bridge-token` (ou fixez `QUANTOWER_BRIDGE_TOKEN` des deux côtés). |
| `504 TIMEOUT` | Historique lourd ou UI Quantower occupée | Réduisez `limit`, augmentez `QUANTOWER_BRIDGE_OPERATION_TIMEOUT_SECONDS`. |
| `NOT_IMPLEMENTED` sur `/events` | Fonctionnalité v2 | Attendu : le streaming WS est hors scope v1. |
| `403 TRADING_DISABLED` sur POST/PATCH/DELETE | Écriture désactivée par défaut côté bridge | Définissez `QUANTOWER_BRIDGE_TRADING_ENABLED=true` (host standalone : `--trading`) et relancez le bridge. |
| Valeurs stub visibles | Bridge lancé en standalone (pas dans Quantower) | Lancez Quantower avec le module chargé (`QuantowerSdkDir` requis à la compilation). |

---

## 9. Compatibilité et maintenabilité

- Les **DTOs JSON** (`Dtos/`) sont le contrat public : ils ne changent qu'avec les fixtures
  `scripts/fixtures/*.json` et `src/bridge-types.ts` (anti-dérive du contrat).
- Quantower publie des mises à jour fréquentes : après chaque mise à jour majeure, exécuter
  `dotnet build ... -p:QuantowerSdkDir=...` puis le smoke test complet (lecture + cycle d'écriture démo).
- Les zones `TODO(Phase 0)` de `QuantowerCoreGateway.cs` sont le seul endroit à ajuster en cas de
  changement d'API de la plateforme : ni le serveur HTTP, ni le serveur MCP, ni les DTOs ne bougent.
