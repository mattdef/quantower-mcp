# Recette Claude Code — serveur MCP quantower

Claude Code gère son propre stockage de serveurs MCP : pas de fichier de config à éditer à la main
(sauf `.mcp.json` de projet, voir §3). Aucun secret n'est nécessaire : le serveur relit tout seul le
token écrit par le bridge (`%LOCALAPPDATA%\quantower-mcp\bridge-token`).

> Commandes à taper sur **une seule ligne** : ni PowerShell ni `cmd` ne comprennent les continuations `\`
> (réservées à bash / Git Bash).

## 1. Ajouter le serveur (clone local)

Prérequis : clone local construit (README §Installation, Chemin A) — `git clone`, `npm install`, `npm run build`.

```bash
claude mcp add quantower --transport stdio --scope user --env QUANTOWER_BRIDGE_URL=http://127.0.0.1:8765 --env QUANTOWER_TRADING_ENABLED=false -- node "C:\Users\<vous>\Documents\Projects\quantower-mcp\dist\server.js"
```

Scopes disponibles :

| Scope | Portée |
|---|---|
| `local` (défaut) | Projet courant, visible par vous seul. |
| `project` | Écrit `.mcp.json` à la racine du projet (versionnable). |
| `user` | Global, tous les projets. |

## 2. Variante sans clone (`npx github:`)

```bash
claude mcp add quantower --transport stdio --scope user --env QUANTOWER_BRIDGE_URL=http://127.0.0.1:8765 --env QUANTOWER_TRADING_ENABLED=false -- npx -y github:mattdef/quantower-mcp
```

> npm ≥ 12 : cette recette est refusée par défaut (`allow-git=none` → `EALLOWGIT`) et le `prepare`
> (build) d'une source git n'est pas exécuté sans approbation des scripts — opt-in npm requis
> (voir README §Dépannage). Sur npm ≤ 11, elle fonctionne ; en cas de doute, restez sur le clone local (§1).

## 3. Équivalent `.mcp.json` (scope projet)

Créer `.mcp.json` à la racine du projet :

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

`claude mcp add-json quantower '<même objet>' -s project` accepte la même forme en ligne de commande
(variante sans clone : `"command": "npx"`, `"args": ["-y", "github:mattdef/quantower-mcp"]` — npm ≥ 12 :
opt-in npm requis, voir README §Dépannage).

## 4. Vérifier

```bash
claude mcp list          # le serveur "quantower" doit apparaître et répondre
claude mcp get quantower # détail de la config enregistrée
```

Sous Claude Code (TUI), `/mcp` affiche l'état de connexion des serveurs.
