#Requires -Version 5.1
<#
.SYNOPSIS
    Installation et configuration guidées du bridge Quantower (plugin C#) et du serveur MCP quantower-mcp.

.DESCRIPTION
    Script pensé pour un utilisateur non technique sous Windows 10/11. Il effectue :

      1. Vérification des prérequis (node, dotnet, git) et détection de Windows.
      2. Détection de l'installation Quantower (TradingPlatform\vX.Y.Z\bin).
      3. Compilation du bridge avec le SDK Quantower détecté et copie du module dans
         <bin>\plug-ins\QuantowerMcpBridge\.
      4. Compilation du serveur MCP (npm install + npm run build).
      5. Configuration des clients MCP détectés (OpenCode, Claude Code, Codex, Claude Desktop),
         toujours en lecture seule (QUANTOWER_TRADING_ENABLED=false) et sans aucun secret :
         le serveur relit tout seul %LOCALAPPDATA%\quantower-mcp\bridge-token.
      6. Vérifications : réservation URL HTTP.SYS (netsh), endpoint /health, smoke test, listes MCP.
      7. Récapitulatif des actions, des sauvegardes (.bak-<date>) et de ce qui reste manuel.

    Le script est idempotent (relançable sans casse) et non destructif : il ne touche jamais aux
    fichiers de Quantower en dehors de plug-ins\QuantowerMcpBridge\, et ne ferme jamais Quantower.

.PARAMETER DryRun
    N'exécute aucune action : affiche chaque étape et la commande/fichier cible, sans rien écrire.

.PARAMETER Demo
    Mode démonstration sans Quantower : saute la détection/branchement du bridge réel et utilise
    le bridge factice (scripts/fake-bridge.mjs, token dev-token) pour le smoke test. Non persistant.

.PARAMETER SkipClients
    Saute l'étape de configuration des clients MCP (utile pour re-tester /health après démarrage
    de Quantower sans réécrire les configs).

.PARAMETER SetUrlAcl
    Exécute les réservations HTTP.SYS (netsh http add urlacl) manquantes — nécessite une console
    administrateur. Sans ce paramètre, les commandes exactes sont affichées.

.PARAMETER Port
    Port local du bridge (défaut 8765, cohérent avec DEFAULT_BRIDGE_PORT du serveur MCP).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
    Affiche tout ce qui serait fait, sans aucune modification.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    Installation complète (Quantower déjà installé).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Demo -SkipClients
    Démonstration sans Quantower, sans toucher aux configs clients.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Demo,
    [switch]$SkipClients,
    [switch]$SetUrlAcl,
    [ValidateRange(1024, 65535)]
    [int]$Port = 8765
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:RepoRoot = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { (Get-Location).Path }
$script:BridgeProject = Join-Path (Join-Path $script:RepoRoot 'bridge') 'QuantowerMcpBridge'
$script:BridgeCsproj = Join-Path $script:BridgeProject 'QuantowerMcpBridge.csproj'
$script:ServerJs = Join-Path (Join-Path $script:RepoRoot 'dist') 'server.js'
$script:BridgeUrl = "http://127.0.0.1:$Port"
$script:TokenFile = Join-Path (Join-Path $env:LOCALAPPDATA 'quantower-mcp') 'bridge-token'
$script:ConfigObjects = New-Object System.Collections.ArrayList
$script:Backups = New-Object System.Collections.ArrayList
$script:Manual = New-Object System.Collections.ArrayList
$script:Failures = New-Object System.Collections.ArrayList
$script:OpenCodeCliWorked = $false

# --------------------------------------------------------------------------- Affichage

function Write-Head {
    param([string]$Text)
    Write-Host ''
    Write-Host "=== $Text ===" -ForegroundColor White
}

function Write-Info {
    param([string]$Text)
    Write-Host "  $Text"
}

function Write-Detail {
    param([string]$Text)
    Write-Host "    $Text" -ForegroundColor DarkGray
}

function Write-Ok {
    param([string]$Text)
    Write-Host "  [OK] $Text" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Text)
    Write-Host "  [ATTENTION] $Text" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Text)
    Write-Host "  [ÉCHEC] $Text" -ForegroundColor Red
    [void]$script:Failures.Add($Text)
}

function Write-Manual {
    param([string]$Text)
    Write-Host "  [À FAIRE] $Text" -ForegroundColor Magenta
    [void]$script:Manual.Add($Text)
}

function Write-Dry {
    param([string]$Text)
    Write-Host "  [DryRun] $Text" -ForegroundColor DarkYellow
}

# --------------------------------------------------------------------------- Outils génériques

function Test-IsWindows {
    if ($env:OS -eq 'Windows_NT') { return $true }
    try { return ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) } catch { return $false }
}

function Get-ToolPath {
    param([string]$Name)
    try {
        $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command) { return $command.Source }
    } catch { }
    return $null
}

function Get-NewlineForText {
    param([string]$Text)
    if ($Text -match "`r`n") { return "`r`n" }
    return "`n"
}

function Read-TextFile {
    param([string]$Path)
    $text = [System.IO.File]::ReadAllText($Path)
    if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) {
        $text = $text.Substring(1)
    }
    return $text
}

function Write-TextFileNoBom {
    param([string]$Path, [string]$Text)
    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path $directory)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
    }
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Backup-ConfigFile {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $target = "$Path.bak-$stamp"
    $suffix = 1
    while (Test-Path $target) {
        $target = "$Path.bak-$stamp-$suffix"
        $suffix++
    }
    Copy-Item -LiteralPath $Path -Destination $target -Force
    [void]$script:Backups.Add($target)
    return $target
}

function Invoke-External {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$Description
    )
    Write-Host "  > $Description" -ForegroundColor Cyan
    if ($DryRun) {
        Write-Dry "$FilePath $($ArgumentList -join ' ')"
        return $true
    }
    # PS 5.1 : sous $ErrorActionPreference='Stop' (valeur du script), la redirection 2>&1 du stderr
    # natif produit des NativeCommandError terminantes même quand le processus réussit (exit 0) —
    # or npm/dotnet écrivent en routine sur stderr. On scope donc EAP='Continue' localement :
    # le critère d'échec reste $LASTEXITCODE, et les ErrorRecords sont affichés via .ToString().
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @ArgumentList 2>&1 | ForEach-Object {
            $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { [string]$_ }
            Write-Host "    $line"
        }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "$Description (code $LASTEXITCODE)"
        return $false
    }
    return $true
}

function Get-CommandLinePreview {
    param([string]$FilePath, [string[]]$ArgumentList)
    return "$FilePath $($ArgumentList -join ' ')"
}

# --------------------------------------------------------------------------- JSON / JSONC / TOML

function Test-JsonHasComments {
    param([string]$Text)
    $inString = $false
    $escaped = $false
    for ($i = 0; $i -lt $Text.Length - 1; $i++) {
        $c = $Text[$i]
        if ($inString) {
            if ($escaped) { $escaped = $false }
            elseif ($c -eq '\') { $escaped = $true }
            elseif ($c -eq '"') { $inString = $false }
            continue
        }
        if ($c -eq '"') { $inString = $true; continue }
        if ($c -eq '/' -and ($Text[$i + 1] -eq '/' -or $Text[$i + 1] -eq '*')) { return $true }
    }
    return $false
}

function Remove-JsonComments {
    param([string]$Text)
    $builder = New-Object System.Text.StringBuilder
    $inString = $false
    $escaped = $false
    $inLineComment = $false
    $inBlockComment = $false
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $c = $Text[$i]
        $next = if ($i + 1 -lt $Text.Length) { $Text[$i + 1] } else { [char]0 }
        if ($inLineComment) {
            if ($c -eq "`n") { $inLineComment = $false; [void]$builder.Append($c) }
            continue
        }
        if ($inBlockComment) {
            if ($c -eq '*' -and $next -eq '/') { $inBlockComment = $false; $i++ }
            continue
        }
        if ($inString) {
            [void]$builder.Append($c)
            if ($escaped) { $escaped = $false }
            elseif ($c -eq '\') { $escaped = $true }
            elseif ($c -eq '"') { $inString = $false }
            continue
        }
        if ($c -eq '"') { $inString = $true; [void]$builder.Append($c); continue }
        if ($c -eq '/' -and $next -eq '/') { $inLineComment = $true; $i++; continue }
        if ($c -eq '/' -and $next -eq '*') { $inBlockComment = $true; $i++; continue }
        [void]$builder.Append($c)
    }
    return $builder.ToString()
}

function Remove-TrailingCommas {
    param([string]$Text)
    $result = $Text
    for ($i = 0; $i -lt 3; $i++) {
        $candidate = [regex]::Replace($result, ',(\s*[}\]])', '$1')
        if ($candidate -eq $result) { break }
        $result = $candidate
    }
    return $result
}

function Test-JsonTextParses {
    param([string]$Text)
    try {
        $cleaned = Remove-TrailingCommas (Remove-JsonComments $Text)
        $null = $cleaned | ConvertFrom-Json
        return $true
    } catch {
        return $false
    }
}

# Retourne les positions d'un bloc objet JSON : clé "Key" -> '{' ... '}' correspondants.
function Find-JsonObjectBlock {
    param([string]$Text, [string]$Key, [int]$From = 0)
    $pattern = '"' + [regex]::Escape($Key) + '"\s*:'
    $match = [regex]::Match($Text.Substring($From), $pattern)
    if (-not $match.Success) { return $null }
    $keyStart = $From + $match.Index
    $pos = $From + $match.Index + $match.Length
    while ($pos -lt $Text.Length -and [char]::IsWhiteSpace($Text[$pos])) { $pos++ }
    if ($pos -ge $Text.Length -or $Text[$pos] -ne '{') { return $null }
    $braceStart = $pos
    $depth = 0
    $inString = $false
    $escaped = $false
    for ($i = $braceStart; $i -lt $Text.Length; $i++) {
        $c = $Text[$i]
        if ($inString) {
            if ($escaped) { $escaped = $false }
            elseif ($c -eq '\') { $escaped = $true }
            elseif ($c -eq '"') { $inString = $false }
            continue
        }
        if ($c -eq '"') { $inString = $true; continue }
        if ($c -eq '{') { $depth++ }
        elseif ($c -eq '}') {
            $depth--
            if ($depth -eq 0) {
                return [pscustomobject]@{ KeyStart = $keyStart; BraceStart = $braceStart; BraceEnd = $i }
            }
        }
    }
    return $null
}

function Get-LineIndent {
    param([string]$Text, [int]$Index)
    $lineStart = $Text.LastIndexOf("`n", [Math]::Max(0, $Index - 1))
    if ($lineStart -lt 0) { $lineStart = 0 } else { $lineStart++ }
    $prefix = $Text.Substring($lineStart, $Index - $lineStart)
    if ($prefix -match '^[ \t]*$') { return $prefix }
    return ''
}

# Sérialise un objet en JSON (indenté) et décale chaque ligne d'un préfixe d'indentation.
function Format-JsonBlock {
    param([object]$Object, [string]$Indent, [string]$Newline)
    $json = $Object | ConvertTo-Json -Depth 12
    $lines = $json -split "`r?`n"
    $output = New-Object System.Collections.ArrayList
    [void]$output.Add($lines[0])
    for ($i = 1; $i -lt $lines.Length; $i++) {
        [void]$output.Add($Indent + $lines[$i])
    }
    return ($output -join $Newline)
}

function Show-JsonEntryForManualUse {
    param([string]$TargetPath, [string]$EntryJson)
    Write-Manual "Ajoutez ce bloc dans $TargetPath (le reste du fichier ne sera pas modifié automatiquement car il contient des commentaires ou n'est pas un JSON strict) :"
    Write-Host $EntryJson -ForegroundColor DarkYellow
}

# --------------------------------------------------------------------------- OpenCode (JSONC)

function Get-OpenCodeEntry {
    $environment = [ordered]@{
        QUANTOWER_BRIDGE_URL      = $script:BridgeUrl
        QUANTOWER_LOG_LEVEL       = 'info'
        QUANTOWER_TRADING_ENABLED = 'false'
    }
    return [ordered]@{
        type        = 'local'
        command     = @('node', $script:ServerJs)
        enabled     = $true
        environment = $environment
    }
}

function Set-OpenCodeConfigFile {
    param([string]$FilePath)
    $entry = Get-OpenCodeEntry
    $entryJson = Format-JsonBlock $entry '  ' "`n"
    $fullJson = "{`n  ""mcp"": {`n    ""quantower"": " + (Format-JsonBlock $entry '    ' "`n") + "`n  }`n}"

    if (-not (Test-Path $FilePath)) {
        if ($DryRun) {
            Write-Dry "créer $FilePath avec la section mcp.quantower :"
            Write-Host $fullJson -ForegroundColor DarkYellow
            return
        }
        $content = "{`n  ""`$schema"": ""https://opencode.ai/config.json"",`n  ""mcp"": {`n    ""quantower"": " + (Format-JsonBlock $entry '    ' "`n") + "`n  }`n}`n"
        [void](Backup-ConfigFile $FilePath)
        Write-TextFileNoBom $FilePath $content
        [void]$script:ConfigObjects.Add($FilePath)
        Write-Ok "OpenCode : $FilePath créé"
        return
    }

    $text = Read-TextFile $FilePath
    $newline = Get-NewlineForText $text
    $hasComments = Test-JsonHasComments $text
    $mcpBlock = Find-JsonObjectBlock -Text $text -Key 'mcp'
    $newText = $null

    if ($null -ne $mcpBlock) {
        $quantowerBlock = Find-JsonObjectBlock -Text $text -Key 'quantower' -From $mcpBlock.BraceStart
        if ($null -ne $quantowerBlock -and $quantowerBlock.KeyStart -lt $mcpBlock.BraceEnd) {
            $indent = Get-LineIndent -Text $text -Index $quantowerBlock.KeyStart
            $blockText = Format-JsonBlock $entry $indent $newline
            $newText = $text.Substring(0, $quantowerBlock.BraceStart) + $blockText + $text.Substring($quantowerBlock.BraceEnd + 1)
        } else {
            $afterBrace = $text.Substring($mcpBlock.BraceStart + 1)
            $leading = ([regex]::Match($afterBrace, '^\s*')).Length
            $firstContent = $mcpBlock.BraceStart + 1 + $leading
            $outerIndent = Get-LineIndent -Text $text -Index $mcpBlock.KeyStart
            $empty = $firstContent -ge $text.Length -or $text[$firstContent] -eq '}'
            if ($empty) {
                $innerIndent = $outerIndent + '  '
                $blockText = Format-JsonBlock $entry $innerIndent $newline
                $newText = $text.Substring(0, $mcpBlock.BraceStart + 1) + $newline + $innerIndent + '"quantower": ' +
                    $blockText + $newline + $outerIndent + $text.Substring($mcpBlock.BraceEnd)
            } else {
                $innerIndent = Get-LineIndent -Text $text -Index $firstContent
                if (-not $innerIndent) { $innerIndent = $outerIndent + '  ' }
                $blockText = Format-JsonBlock $entry $innerIndent $newline
                $newText = $text.Substring(0, $firstContent) + '"quantower": ' + $blockText + ',' + $newline +
                    $innerIndent + $text.Substring($firstContent)
            }
        }
    } elseif (-not $hasComments) {
        try {
            $root = $text | ConvertFrom-Json
            if ($null -eq $root) { $root = New-Object psobject }
            $entryPs = $entry | ConvertTo-Json -Depth 12 | ConvertFrom-Json
            if ($null -eq $root.PSObject.Properties['mcp']) {
                $root | Add-Member -MemberType NoteProperty -Name 'mcp' -Value (New-Object psobject)
            }
            $mcp = $root.mcp
            if ($null -ne $mcp.PSObject.Properties['quantower']) {
                $mcp.quantower = $entryPs
            } else {
                $mcp | Add-Member -MemberType NoteProperty -Name 'quantower' -Value $entryPs
            }
            $newText = $root | ConvertTo-Json -Depth 20
        } catch {
            $newText = $null
        }
    }

    if ($null -eq $newText -or -not (Test-JsonTextParses $newText)) {
        Show-JsonEntryForManualUse -TargetPath $FilePath -EntryJson $entryJson
        Write-Warn "OpenCode : fusion automatique impossible (JSONC/complexe) — aucune écriture, bloc à insérer manuellement."
        return
    }

    if ($DryRun) {
        Write-Dry "mettre à jour $FilePath (sauvegarde $FilePath.bak-<horodatage>) : section mcp.quantower remplacée"
        return
    }
    [void](Backup-ConfigFile $FilePath)
    Write-TextFileNoBom $FilePath $newText
    [void]$script:ConfigObjects.Add($FilePath)
    Write-Ok "OpenCode : $FilePath mis à jour (backup .bak-<horodatage>)"
}

function Set-OpenCodeConfig {
    $opencode = Get-ToolPath 'opencode'
    if ($null -ne $opencode) {
        $listOutput = ''
        try { $listOutput = (& $opencode mcp list 2>&1 | Out-String) } catch { $listOutput = '' }
        if ($listOutput -match 'quantower') {
            Write-Ok 'OpenCode : serveur « quantower » déjà présent (opencode mcp list) — inchangé'
            Write-Info 'Pour le reconfigurer, retirez l''entrée existante dans votre config OpenCode puis relancez install.ps1.'
            return
        }
        # Syntaxe vérifiée (opencode v2.0.29) : opencode mcp add [flags] <name> [<command...>]
        # (les arguments de commande suivent « -- » ; il n'existe pas de « mcp remove »).
        $arguments = @(
            'mcp', 'add',
            '--global',
            '--env', "QUANTOWER_BRIDGE_URL=$script:BridgeUrl",
            '--env', 'QUANTOWER_TRADING_ENABLED=false',
            '--env', 'QUANTOWER_LOG_LEVEL=info',
            'quantower',
            '--', 'node', $script:ServerJs
        )
        if (Invoke-External -FilePath $opencode -ArgumentList $arguments -Description 'opencode mcp add quantower (config globale)') {
            $script:OpenCodeCliWorked = $true
            Write-Ok 'OpenCode : serveur « quantower » ajouté via la CLI'
            return
        }
        Write-Warn 'OpenCode : la CLI a échoué, repli sur la configuration fichier.'
    } else {
        Write-Info 'OpenCode : CLI absente, configuration par fichier.'
    }

    $configDir = Join-Path $env:USERPROFILE '.config\opencode'
    $jsonc = Join-Path $configDir 'opencode.jsonc'
    $json = Join-Path $configDir 'opencode.json'
    $target = $null
    if (Test-Path $jsonc) { $target = $jsonc }
    elseif (Test-Path $json) { $target = $json }
    else { $target = $json }
    Set-OpenCodeConfigFile -FilePath $target
}

# --------------------------------------------------------------------------- Claude Code

function Set-ClaudeCodeConfig {
    $claude = Get-ToolPath 'claude'
    if ($null -eq $claude) {
        Write-Info 'Claude Code : CLI « claude » non détectée — recette manuelle dans README (examples/claude-code.md).'
        return
    }
    $listOutput = ''
    try { $listOutput = (& $claude mcp list 2>&1 | Out-String) } catch { $listOutput = '' }
    if ($listOutput -match 'quantower') {
        Write-Ok 'Claude Code : serveur « quantower » déjà présent (claude mcp list) — inchangé'
        return
    }
    $arguments = @(
        'mcp', 'add', 'quantower',
        '--transport', 'stdio',
        '--scope', 'user',
        '--env', "QUANTOWER_BRIDGE_URL=$script:BridgeUrl",
        '--env', 'QUANTOWER_TRADING_ENABLED=false',
        '--env', 'QUANTOWER_LOG_LEVEL=info',
        '--', 'node', $script:ServerJs
    )
    if (Invoke-External -FilePath $claude -ArgumentList $arguments -Description 'claude mcp add quantower --scope user') {
        Write-Ok 'Claude Code : serveur « quantower » ajouté (scope user)'
    }
}

# --------------------------------------------------------------------------- Codex (TOML)

function Get-CodexTomlBlock {
    param([string]$Newline)
    $serverJsToml = $script:ServerJs.Replace('\', '\\').Replace('"', '\"')
    $lines = @(
        '[mcp_servers.quantower]',
        'command = "node"',
        "args = [""$serverJsToml""]",
        'enabled = true',
        'startup_timeout_sec = 20',
        'tool_timeout_sec = 30',
        '',
        '[mcp_servers.quantower.env]',
        "QUANTOWER_BRIDGE_URL = ""$script:BridgeUrl""",
        'QUANTOWER_TRADING_ENABLED = "false"',
        'QUANTOWER_LOG_LEVEL = "info"'
    )
    return ($lines -join $Newline)
}

function Set-CodexConfig {
    $codexPath = Get-ToolPath 'codex'
    $codexConfig = Join-Path (Join-Path $env:USERPROFILE '.codex') 'config.toml'
    $codexExists = Test-Path $codexConfig
    if ($null -eq $codexPath -and -not $codexExists) {
        Write-Info 'Codex : non détecté (ni CLI « codex », ni ~\.codex\config.toml) — recette manuelle dans README (examples/codex-config.toml).'
        return
    }

    $newline = "`r`n"
    $block = Get-CodexTomlBlock -Newline $newline

    if (-not $codexExists) {
        $content = "# Config Codex — section ajoutée par install.ps1 (quantower-mcp).$newline$newline$block$newline"
        if ($DryRun) {
            Write-Dry "créer $codexConfig avec la section [mcp_servers.quantower] :"
            Write-Host $block -ForegroundColor DarkYellow
            return
        }
        [void](Backup-ConfigFile $codexConfig)
        Write-TextFileNoBom $codexConfig $content
        [void]$script:ConfigObjects.Add($codexConfig)
        Write-Ok "Codex : $codexConfig créé"
        return
    }

    $text = Read-TextFile $codexConfig
    $newline = Get-NewlineForText $text
    $block = Get-CodexTomlBlock -Newline $newline
    $lines = $text -split "`r?`n"
    $start = -1
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -match '^\s*\[\s*mcp_servers\s*\.\s*quantower\s*\]\s*$') { $start = $i; break }
    }

    if ($start -ge 0) {
        $end = $lines.Length
        for ($i = $start + 1; $i -lt $lines.Length; $i++) {
            if ($lines[$i] -match '^\s*\[(.+)\]') {
                $header = $Matches[1] -replace '\s', ''
                if ($header -like 'mcp_servers.quantower*') { continue }
                $end = $i
                break
            }
        }
        $before = @()
        if ($start -gt 0) { $before = $lines[0..($start - 1)] }
        $after = @()
        if ($end -lt $lines.Length) { $after = $lines[$end..($lines.Length - 1)] }
        $newLines = @($before) + ($block -split "`r?`n") + @($after)
        $newText = ($newLines -join $newline)
    } else {
        $newText = $text.TrimEnd() + $newline + $newline + $block + $newline
    }

    if ($DryRun) {
        Write-Dry "mettre à jour $codexConfig (sauvegarde $codexConfig.bak-<horodatage>) : section [mcp_servers.quantower] remplacée"
        return
    }
    [void](Backup-ConfigFile $codexConfig)
    Write-TextFileNoBom $codexConfig $newText
    [void]$script:ConfigObjects.Add($codexConfig)
    Write-Ok "Codex : $codexConfig mis à jour (backup .bak-<horodatage>)"
}

# --------------------------------------------------------------------------- Claude Desktop (JSON strict)

function Set-ClaudeDesktopConfig {
    $configPath = Join-Path (Join-Path $env:APPDATA 'Claude') 'claude_desktop_config.json'
    $entryJson = @{
        command = 'node'
        args    = @($script:ServerJs)
        env     = [ordered]@{
            QUANTOWER_BRIDGE_URL      = $script:BridgeUrl
            QUANTOWER_LOG_LEVEL       = 'info'
            QUANTOWER_TRADING_ENABLED = 'false'
        }
    }

    if (-not (Test-Path $configPath)) {
        $content = ([ordered]@{ mcpServers = [ordered]@{ quantower = $entryJson } } | ConvertTo-Json -Depth 12)
        if ($DryRun) {
            Write-Dry "créer $configPath avec mcpServers.quantower :"
            Write-Host $content -ForegroundColor DarkYellow
            return
        }
        [void](Backup-ConfigFile $configPath)
        Write-TextFileNoBom $configPath $content
        [void]$script:ConfigObjects.Add($configPath)
        Write-Ok "Claude Desktop : $configPath créé"
        return
    }

    $text = Read-TextFile $configPath
    $root = $null
    try { $root = $text | ConvertFrom-Json } catch { $root = $null }
    if ($null -eq $root) {
        $blockJson = ([ordered]@{ quantower = $entryJson } | ConvertTo-Json -Depth 12)
        Show-JsonEntryForManualUse -TargetPath $configPath -EntryJson $blockJson
        Write-Warn 'Claude Desktop : le fichier existant n''est pas un JSON valide — aucune écriture.'
        return
    }

    if ($null -eq $root.PSObject.Properties['mcpServers']) {
        $root | Add-Member -MemberType NoteProperty -Name 'mcpServers' -Value (New-Object psobject)
    }
    $servers = $root.mcpServers
    if ($null -eq $servers) {
        $servers = New-Object psobject
        $root.mcpServers = $servers
    }
    $entryPs = $entryJson | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    if ($null -ne $servers.PSObject.Properties['quantower']) {
        $servers.quantower = $entryPs
    } else {
        $servers | Add-Member -MemberType NoteProperty -Name 'quantower' -Value $entryPs
    }
    $newText = $root | ConvertTo-Json -Depth 20

    if ($DryRun) {
        Write-Dry "mettre à jour $configPath (sauvegarde $configPath.bak-<horodatage>) : mcpServers.quantower remplacé"
        return
    }
    [void](Backup-ConfigFile $configPath)
    Write-TextFileNoBom $configPath $newText
    [void]$script:ConfigObjects.Add($configPath)
    Write-Ok "Claude Desktop : $configPath mis à jour (backup .bak-<horodatage>)"
}

# --------------------------------------------------------------------------- Étapes principales

function Step-Prerequisites {
    Write-Head 'Étape 1/7 — Prérequis'
    if (-not (Test-IsWindows)) {
        Write-Fail 'Ce script ne fonctionne que sous Windows (Quantower est Windows uniquement).'
        return $false
    }

    $missing = New-Object System.Collections.ArrayList
    $node = Get-ToolPath 'node'
    if ($null -eq $node) {
        [void]$missing.Add('Node.js ≥ 20 — installez-le depuis https://nodejs.org (LTS), puis rouvrez le terminal.')
    } else {
        $nodeVersion = (& node --version) -replace '^v', ''
        $nodeMajor = 0
        if ($nodeVersion -match '^(\d+)') { $nodeMajor = [int]$Matches[1] }
        if ($nodeMajor -lt 20) {
            [void]$missing.Add("Node.js ≥ 20 requis (détecté : v$nodeVersion) — https://nodejs.org")
        } else {
            Write-Ok "Node.js v$nodeVersion"
        }
    }

    if (-not $Demo) {
        $dotnet = Get-ToolPath 'dotnet'
        if ($null -eq $dotnet) {
            [void]$missing.Add('Kit de développement .NET SDK ≥ 8 — https://dotnet.microsoft.com/download (pour compiler le bridge).')
        } else {
            $dotnetVersion = & dotnet --version
            $dotnetMajor = 0
            if ("$dotnetVersion" -match '^(\d+)') { $dotnetMajor = [int]$Matches[1] }
            if ($dotnetMajor -lt 8) {
                [void]$missing.Add(".NET SDK ≥ 8 requis (détecté : $dotnetVersion) — https://dotnet.microsoft.com/download")
            } else {
                Write-Ok ".NET SDK $dotnetVersion"
            }
        }
    } else {
        Write-Info 'Mode démo : .NET non requis.'
    }

    $git = Get-ToolPath 'git'
    if ($null -eq $git) {
        Write-Warn 'git absent : sans conséquence sur un clone déjà présent (https://git-scm.com en cas de besoin).'
    } else {
        Write-Ok ((& git --version) -join ' ')
    }

    if ($missing.Count -gt 0) {
        Write-Host ''
        Write-Warn 'Prérequis manquants :'
        foreach ($item in $missing) { Write-Fail $item }
        Write-Info 'Installez les éléments ci-dessus puis relancez install.ps1.'
        return $false
    }
    return $true
}

function Find-QuantowerSdkDir {
    $roots = New-Object System.Collections.ArrayList
    [void]$roots.Add('C:\Quantower')
    if ($env:ProgramFiles) { [void]$roots.Add((Join-Path $env:ProgramFiles 'Quantower')) }
    if (${env:ProgramFiles(x86)}) { [void]$roots.Add((Join-Path ${env:ProgramFiles(x86)} 'Quantower')) }

    $candidates = New-Object System.Collections.ArrayList
    foreach ($root in $roots) {
        $platform = Join-Path $root 'TradingPlatform'
        if (-not (Test-Path $platform)) { continue }
        $versionDirs = @(Get-ChildItem -Path $platform -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^v?\d+(\.\d+)+' })
        foreach ($versionDir in $versionDirs) {
            $bin = Join-Path $versionDir.FullName 'bin'
            if (Test-Path (Join-Path $bin 'TradingPlatform.BusinessLayer.dll')) {
                $version = $null
                try { $version = [version]($versionDir.Name.TrimStart('v')) } catch { $version = [version]'0.0.0' }
                [void]$candidates.Add([pscustomobject]@{ Version = $version; Path = $bin })
            }
        }
        $directBin = Join-Path $platform 'bin'
        if (Test-Path (Join-Path $directBin 'TradingPlatform.BusinessLayer.dll')) {
            [void]$candidates.Add([pscustomobject]@{ Version = [version]'0.0.0'; Path = $directBin })
        }
    }

    if ($candidates.Count -eq 0) { return $null }
    $sorted = $candidates | Sort-Object -Property Version -Descending
    return $sorted[0].Path
}

function Step-DetectQuantower {
    Write-Head 'Étape 2/7 — Détection de Quantower'
    if ($Demo) {
        Write-Info 'Mode démo : détection Quantower ignorée (bridge factice).'
        return $null
    }
    $search = 'C:\Quantower, %ProgramFiles%\Quantower, %ProgramFiles(x86)%\Quantower → TradingPlatform\*\bin'
    $sdkDir = Find-QuantowerSdkDir
    if ($null -eq $sdkDir) {
        Write-Warn "Quantower introuvable (chemins cherchés : $search)."
        Write-Manual 'Installez Quantower (https://www.quantower.com) puis relancez install.ps1, ou testez sans Quantower avec : install.ps1 -Demo'
        return $null
    }
    Write-Ok "SDK Quantower détecté : $sdkDir"
    $plugInsDir = Join-Path $sdkDir 'plug-ins'
    if (-not (Test-Path $plugInsDir)) {
        Write-Warn "Dossier plug-ins introuvable à côté du SDK ($plugInsDir) : le déploiement pourrait échouer."
    }
    return $sdkDir
}

function Step-BuildBridge {
    param([string]$SdkDir)
    Write-Head 'Étape 3/7 — Compilation et déploiement du bridge'
    if ($Demo) {
        Write-Info 'Mode démo : bridge réel ignoré (le bridge factice suffit pour le smoke test).'
        return
    }
    if ($null -eq $SdkDir) {
        Write-Warn 'Bridge réel non compilé (Quantower non détecté).'
        Write-Manual 'Installez Quantower puis relancez install.ps1, ou utilisez -Demo pour tester sans Quantower.'
        return
    }

    $arguments = @('build', $script:BridgeCsproj, '-c', 'Release', "-p:QuantowerSdkDir=$SdkDir")
    if (-not (Invoke-External -FilePath 'dotnet' -ArgumentList $arguments -Description 'Compilation du bridge (SDK Quantower)')) {
        Write-Manual 'Corrigez l''erreur de compilation puis relancez install.ps1.'
        return
    }

    $builtDll = $null
    if (-not $DryRun) {
        $releaseDir = Join-Path $script:BridgeProject 'bin\Release'
        if (Test-Path $releaseDir) {
            $builtDll = Get-ChildItem -Path $releaseDir -Recurse -Filter 'QuantowerMcpBridge.dll' -ErrorAction SilentlyContinue |
                Sort-Object -Property LastWriteTime -Descending | Select-Object -First 1
        }
    }

    $targetDir = Join-Path (Join-Path $SdkDir 'plug-ins') 'QuantowerMcpBridge'
    $targetDll = Join-Path $targetDir 'QuantowerMcpBridge.dll'

    if ($DryRun) {
        Write-Dry "copier QuantowerMcpBridge.dll -> $targetDll"
    } else {
        if ($null -eq $builtDll) {
            Write-Fail "Assembly compilée introuvable (cherchée dans $releaseDir)."
            return
        }
        if (-not (Test-Path $targetDir)) { [void](New-Item -ItemType Directory -Path $targetDir -Force) }
        try {
            Copy-Item -LiteralPath $builtDll.FullName -Destination $targetDll -Force
            # Dépendances privées éventuelles de la sortie (ex. System.Text.Json en mode net48) :
            $siblingDlls = @(Get-ChildItem -Path $builtDll.DirectoryName -Filter '*.dll' -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -ne $builtDll.FullName })
            foreach ($sibling in $siblingDlls) {
                Copy-Item -LiteralPath $sibling.FullName -Destination (Join-Path $targetDir $sibling.Name) -Force
            }
            Write-Ok "Module déployé : $targetDll"
        } catch {
            Write-Fail "Copie impossible ($targetDll) : $($_.Exception.Message)"
            Write-Manual 'Si Quantower est ouvert, fermez-le puis relancez install.ps1 (le script ne ferme jamais Quantower lui-même).'
            return
        }
    }

    Write-Warn 'Redémarrez Quantower pour charger le module (l''installateur ne ferme jamais Quantower).'
    Write-Info 'Le module s''active à l''ouverture du panneau « Quantower MCP Bridge » (Ajouter un panneau) : ouvrez-le une fois, puis laissez-le ouvert (le fermer arrête le bridge).'
}

function Step-BuildMcp {
    Write-Head 'Étape 4/7 — Compilation du serveur MCP'
    if (-not (Invoke-External -FilePath 'npm' -ArgumentList @('install') -Description 'npm install (racine du dépôt)')) {
        Write-Manual 'Corrigez l''erreur npm puis relancez install.ps1.'
        return
    }
    if (-not (Invoke-External -FilePath 'npm' -ArgumentList @('run', 'build') -Description 'npm run build (compilation TypeScript)')) {
        Write-Manual 'Corrigez l''erreur de compilation TypeScript puis relancez install.ps1.'
        return
    }
    if (-not $DryRun) {
        if (-not (Test-Path $script:ServerJs)) {
            Write-Fail "dist\server.js introuvable après le build : $( $script:ServerJs )"
        } else {
            Write-Ok "Serveur MCP compilé : $script:ServerJs"
        }
    }
}

function Step-ConfigureClients {
    Write-Head 'Étape 5/7 — Configuration des clients MCP (lecture seule, sans secret)'
    if ($SkipClients) {
        Write-Info 'Étape sautée (-SkipClients).'
        return
    }
    if ($Demo) {
        # Le bridge factice utilise le token « dev-token » : on l'écrit dans le fichier de token
        # habituel pour que les configs clients (sans secret) fonctionnent sans modification.
        # Le bridge réel remplacera ce fichier par son propre token au prochain démarrage.
        $existingToken = Get-BridgeTokenFromFile
        if ($existingToken -ne 'dev-token') {
            if ($DryRun) {
                Write-Dry "écrire « dev-token » dans $script:TokenFile (mode démo)"
            } else {
                Write-TextFileNoBom $script:TokenFile 'dev-token'
                Write-Info "Mode démo : token « dev-token » écrit dans $script:TokenFile (remplacé par le token réel au prochain démarrage du bridge réel)."
            }
        }
    }
    Set-OpenCodeConfig
    Set-ClaudeCodeConfig
    Set-CodexConfig
    Set-ClaudeDesktopConfig
}

function Test-BridgeHealthOnce {
    param([string]$Token)
    try {
        $headers = @{}
        if ($Token) { $headers['Authorization'] = "Bearer $Token" }
        $response = Invoke-WebRequest -Uri "$script:BridgeUrl/health" -Headers $headers -UseBasicParsing -TimeoutSec 5
        return ($response.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Get-BridgeTokenFromFile {
    if (Test-Path $script:TokenFile) {
        try { return ((Read-TextFile $script:TokenFile).Trim()) } catch { return '' }
    }
    return ''
}

function Step-Verifications {
    Write-Head 'Étape 6/7 — Vérifications'

    # --- Réservations URL HTTP.SYS ---------------------------------------------------------
    $prefixes = @(
        "http://localhost:$Port/",
        "http://127.0.0.1:$Port/",
        "http://[::1]:$Port/"
    )
    $missings = New-Object System.Collections.ArrayList
    $reserved = ''
    try { $reserved = (& netsh http show urlacl 2>&1 | Out-String) } catch { $reserved = '' }
    foreach ($prefix in $prefixes) {
        if ($reserved -notmatch [regex]::Escape($prefix)) { [void]$missings.Add($prefix) }
    }

    if ($missings.Count -eq 0) {
        Write-Ok "Réservations HTTP.SYS présentes pour le port $Port."
    } else {
        Write-Warn "Réservation HTTP.SYS manquante pour : $($missings -join ', ')"
        Write-Info 'Ces réservations évitent l''erreur « HttpListenerException: Accès refusé » au démarrage du bridge.'
        $isAdmin = $false
        try {
            $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        } catch { $isAdmin = $false }

        foreach ($prefix in $missings) {
            $arguments = @('http', 'add', 'urlacl', "url=$prefix", "user=$env:USERNAME")
            $preview = Get-CommandLinePreview -FilePath 'netsh' -ArgumentList $arguments
            if ($SetUrlAcl -and $isAdmin) {
                if (-not (Invoke-External -FilePath 'netsh' -ArgumentList $arguments -Description "netsh http add urlacl $prefix")) {
                    Write-Manual "Exécutez en administrateur : $preview"
                }
            } else {
                Write-Detail $preview
            }
        }
        if (-not ($SetUrlAcl -and $isAdmin)) {
            Write-Manual 'Ouvrez une console administrateur et exécutez les commandes netsh ci-dessus (option -SetUrlAcl pour les exécuter si la console est déjà admin), puis redémarrez Quantower.'
        }
    }

    # --- /health ---------------------------------------------------------------------------
    $token = Get-BridgeTokenFromFile
    if ($Demo) {
        Write-Info 'Mode démo : /health vérifié via le bridge factice pendant le smoke test.'
    } else {
        $healthy = $false
        $attempts = if ($DryRun) { 1 } else { 3 }
        for ($attempt = 1; $attempt -le $attempts; $attempt++) {
            if ($DryRun) {
                Write-Dry "GET $script:BridgeUrl/health (Bearer depuis $script:TokenFile si présent)"
                break
            }
            Write-Info "Test de $script:BridgeUrl/health (tentative $attempt/$attempts)…"
            if (Test-BridgeHealthOnce -Token $token) { $healthy = $true; break }
            if ($attempt -lt $attempts) { Start-Sleep -Seconds 5 }
        }
        if ($healthy) {
            Write-Ok 'Le bridge répond sur /health.'
        } elseif (-not $DryRun) {
            Write-Warn 'Le bridge ne répond pas encore sur /health.'
            Write-Manual 'Démarrez/redémarrez Quantower (le script ne le fait jamais lui-même), vérifiez que le module QuantowerMcpBridge est chargé, ouvrez une fois le panneau « Quantower MCP Bridge » (Ajouter un panneau — il démarre le bridge), puis relancez : install.ps1 -SkipClients'
        }
    }

    # --- Smoke test ------------------------------------------------------------------------
    if ($Demo) {
        if ($DryRun) {
            Write-Dry "démarrer temporairement : npm run fake-bridge (port $Port, token dev-token)"
            Write-Dry "node scripts/smoke-bridge.mjs --url $script:BridgeUrl --token dev-token"
            Write-Dry 'arrêter le bridge factice'
        } else {
            $fakeBridge = $null
            try {
                $fakeBridge = Start-Process -FilePath 'node' -ArgumentList @('scripts/fake-bridge.mjs', '--port', "$Port", '--token', 'dev-token') -WorkingDirectory $script:RepoRoot -PassThru -WindowStyle Hidden
                $up = $false
                for ($attempt = 1; $attempt -le 10; $attempt++) {
                    Start-Sleep -Milliseconds 800
                    if (Test-BridgeHealthOnce -Token 'dev-token') { $up = $true; break }
                }
                if (-not $up) {
                    Write-Fail 'Le bridge factice n''a pas démarré à temps.'
                } else {
                    Write-Ok 'Bridge factice démarré temporairement (token dev-token).'
                    $smokeScript = Join-Path (Join-Path $script:RepoRoot 'scripts') 'smoke-bridge.mjs'
                    [void](Invoke-External -FilePath 'node' -ArgumentList @($smokeScript, '--url', $script:BridgeUrl, '--token', 'dev-token') -Description 'Smoke test du bridge factice (lecture seule)')
                }
            } finally {
                if ($null -ne $fakeBridge) {
                    try { Stop-Process -Id $fakeBridge.Id -Force -ErrorAction SilentlyContinue } catch { }
                    Write-Info 'Bridge factice arrêté.'
                }
            }
        }
    } else {
        $smokeArguments = @((Join-Path (Join-Path $script:RepoRoot 'scripts') 'smoke-bridge.mjs'), '--url', $script:BridgeUrl)
        if ($token) { $smokeArguments += @('--token', $token) }
        if ($DryRun) {
            Write-Dry "node $($smokeArguments -join ' ')"
            if (-not $token) {
                Write-Detail "aucun token trouvé dans $script:TokenFile — le smoke test répondra 401 tant que le bridge n'aura pas démarré une première fois."
            }
        } else {
            [void](Invoke-External -FilePath 'node' -ArgumentList $smokeArguments -Description 'Smoke test du bridge (lecture seule)')
            if (-not $token) {
                Write-Warn "Aucun token dans $script:TokenFile : démarrez Quantower (bridge) puis relancez le smoke test."
            }
        }
    }

    # --- Listes MCP ------------------------------------------------------------------------
    foreach ($tool in @('opencode', 'claude', 'codex')) {
        $path = Get-ToolPath $tool
        if ($null -eq $path) {
            Write-Detail "$tool : non disponible sur cette machine — vérification manuelle au premier lancement du client."
            continue
        }
        if ($DryRun) {
            Write-Dry "$tool mcp list"
            continue
        }
        try {
            Write-Info "$tool mcp list :"
            (& $path mcp list 2>&1) | ForEach-Object { Write-Host "    $_" }
        } catch {
            Write-Warn "$tool mcp list a échoué : $($_.Exception.Message)"
        }
    }
}

function Step-Summary {
    Write-Head 'Étape 7/7 — Récapitulatif'
    if ($DryRun) { Write-Warn 'Exécution en -DryRun : aucune action ni écriture n''a été effectuée.' }

    if ($script:ConfigObjects.Count -gt 0) {
        Write-Info 'Fichiers de configuration modifiés :'
        foreach ($item in $script:ConfigObjects) { Write-Detail $item }
    }
    if ($script:Backups.Count -gt 0) {
        Write-Info 'Sauvegardes (.bak-<horodatage>) :'
        foreach ($item in $script:Backups) { Write-Detail $item }
    }
    if (-not $Demo -and -not $SkipClients -and -not $DryRun) {
        if ($script:OpenCodeCliWorked) {
            Write-Info 'OpenCode : configuration gérée par la CLI (opencode mcp list pour vérifier).'
        }
    }

    if ($script:Manual.Count -gt 0) {
        Write-Info 'Reste à faire manuellement :'
        foreach ($item in $script:Manual) { Write-Host "    - $item" -ForegroundColor Magenta }
    } else {
        Write-Ok 'Rien à faire manuellement de notre côté.'
    }

    if (-not $Demo) {
        Write-Info 'Rappel : le script ne ferme jamais Quantower — redémarrez-le vous-même, ouvrez une fois le panneau « Quantower MCP Bridge » (il démarre le bridge), puis vérifiez avec install.ps1 -SkipClients.'
    }
    Write-Info "Sécurité : lecture seule par défaut (QUANTOWER_TRADING_ENABLED=false), aucun secret dans les configs (token relu depuis $script:TokenFile)."

    if ($script:Failures.Count -gt 0) {
        Write-Host ''
        Write-Fail "$($script:Failures.Count) problème(s) rencontré(s) :"
        foreach ($item in $script:Failures) { Write-Host "    - $item" -ForegroundColor Red }
        return $false
    }
    Write-Host ''
    Write-Ok 'Terminé.'
    return $true
}

# --------------------------------------------------------------------------- Exécution

Write-Host ''
Write-Host 'quantower-mcp — installation guidée (bridge Quantower + serveur MCP)' -ForegroundColor White
Write-Info "Dépôt : $script:RepoRoot"
Write-Info "Port   : $Port    Mode : $(if ($Demo) { 'démo (sans Quantower)' } else { 'réel (Quantower)' })"
if ($DryRun) { Write-Warn 'Mode -DryRun : simulation uniquement.' }

$prerequisitesOk = Step-Prerequisites
if (-not $prerequisitesOk) {
    exit 1
}

$sdkDir = Step-DetectQuantower
Step-BuildBridge -SdkDir $sdkDir
Step-BuildMcp
Step-ConfigureClients
Step-Verifications
$summaryOk = Step-Summary

if (-not $summaryOk) { exit 1 }
exit 0
