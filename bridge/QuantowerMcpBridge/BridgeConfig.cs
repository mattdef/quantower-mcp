using System;
using System.Globalization;
using System.IO;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Configuration du bridge (plan §3). Les valeurs sont lues depuis l'environnement du
    /// processus Quantower, ce qui permet de les surcharger sans recompiler.
    /// </summary>
    public sealed class BridgeConfig
    {
        /// <summary>Port d'écoute local (défaut 8765).</summary>
        public int Port { get; set; } = 8765;

        /// <summary>
        /// Hôte utilisé pour l'URL de base affichée (défaut localhost). Le serveur enregistre de toute
        /// façon toutes les variantes loopback (localhost, 127.0.0.1, [::1]) comme préfixes HTTP.SYS ;
        /// toute IP distante reste rejetée (403).
        /// </summary>
        public string Host { get; set; } = "localhost";

        /// <summary>Token Bearer. Généré au démarrage si absent (voir EnsureToken).</summary>
        public string Token { get; set; } = string.Empty;

        /// <summary>Fichier où est écrit le token (lu par le serveur MCP).</summary>
        public string TokenFilePath { get; set; } = string.Empty;

        /// <summary>Journal d'audit des opérations de trading (JSON lines).</summary>
        public string AuditLogPath { get; set; } = string.Empty;

        /// <summary>
        /// Autorise les endpoints d'écriture (place/modify/cancel/close). Désactivé par défaut
        /// (même posture que le serveur MCP) : activer explicitement avec
        /// QUANTOWER_BRIDGE_TRADING_ENABLED=true.
        /// </summary>
        public bool TradingEnabled { get; set; }

        /// <summary>Plafond de quantité par ordre (0 = désactivé).</summary>
        public double MaxOrderQuantity { get; set; } = 50;

        /// <summary>Plafond de notionnel estimé (0 = désactivé, devise du compte).</summary>
        public double MaxNotional { get; set; } = 50_000;

        /// <summary>Interdit les ordres Market.</summary>
        public bool DenyMarketOrders { get; set; }

        /// <summary>Nombre maximum de barres renvoyées par /symbols/{id}/history.</summary>
        public int MaxHistoryBars { get; set; } = 500;

        /// <summary>Timeout d'une opération Core (file d'attente incluse).</summary>
        public int OperationTimeoutSeconds { get; set; } = 20;

        /// <summary>Version du bridge exposée par /health.</summary>
        public string BridgeVersion { get; set; } = "0.1.0";

        public static BridgeConfig FromEnvironment()
        {
            var dataDir = GetDefaultDataDirectory();
            var config = new BridgeConfig
            {
                Port = ReadInt("QUANTOWER_BRIDGE_PORT", 8765, 1024, 65535),
                Host = ReadString("QUANTOWER_BRIDGE_HOST") ?? "localhost",
                Token = ReadString("QUANTOWER_BRIDGE_TOKEN") ?? string.Empty,
                TokenFilePath =
                    ReadString("QUANTOWER_BRIDGE_TOKEN_FILE") ?? Path.Combine(dataDir, "bridge-token"),
                AuditLogPath =
                    ReadString("QUANTOWER_BRIDGE_AUDIT_LOG") ?? Path.Combine(dataDir, "audit.log"),
                TradingEnabled = ReadBool("QUANTOWER_BRIDGE_TRADING_ENABLED", false),
                MaxOrderQuantity = ReadDouble("QUANTOWER_BRIDGE_MAX_ORDER_QUANTITY", 50),
                MaxNotional = ReadDouble("QUANTOWER_BRIDGE_MAX_NOTIONAL", 50_000),
                DenyMarketOrders = ReadBool("QUANTOWER_BRIDGE_DENY_MARKET_ORDERS", false),
                MaxHistoryBars = ReadInt("QUANTOWER_BRIDGE_MAX_HISTORY_BARS", 500, 1, 10_000),
                OperationTimeoutSeconds = ReadInt("QUANTOWER_BRIDGE_OPERATION_TIMEOUT_SECONDS", 20, 1, 600),
            };
            return config;
        }

        /// <summary>
        /// Garantit qu'un token est disponible : si absent, le génère et l'écrit dans TokenFilePath.
        /// À appeler avant de démarrer le serveur HTTP.
        /// </summary>
        public void EnsureToken()
        {
            if (!string.IsNullOrWhiteSpace(Token))
            {
                return;
            }

            var generated = GenerateToken();
            var directory = Path.GetDirectoryName(TokenFilePath);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }
            File.WriteAllText(TokenFilePath, generated);
            Token = generated;
        }

        public static string GenerateToken()
        {
            var bytes = new byte[32];
            using (var random = System.Security.Cryptography.RandomNumberGenerator.Create())
            {
                random.GetBytes(bytes);
            }
            return BitConverter.ToString(bytes).Replace("-", string.Empty).ToLowerInvariant();
        }

        public static string GetDefaultDataDirectory()
        {
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(localAppData))
            {
                localAppData = Path.GetTempPath();
            }
            return Path.Combine(localAppData, "quantower-mcp");
        }

        private static string? ReadString(string variableName)
        {
            var value = Environment.GetEnvironmentVariable(variableName);
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }

        private static bool ReadBool(string variableName, bool defaultValue)
        {
            var value = ReadString(variableName);
            if (value is null)
            {
                return defaultValue;
            }
            switch (value.ToLowerInvariant())
            {
                case "true":
                case "1":
                case "yes":
                case "on":
                    return true;
                case "false":
                case "0":
                case "no":
                case "off":
                    return false;
                default:
                    throw new InvalidOperationException(
                        $"{variableName} : booléen invalide « {value} » (attendu true/false).");
            }
        }

        private static int ReadInt(string variableName, int defaultValue, int min, int max)
        {
            var value = ReadString(variableName);
            if (value is null)
            {
                return defaultValue;
            }
            if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
            {
                throw new InvalidOperationException($"{variableName} : entier invalide « {value} ».");
            }
            if (parsed < min || parsed > max)
            {
                throw new InvalidOperationException($"{variableName} : valeur {parsed} hors plage [{min}, {max}].");
            }
            return parsed;
        }

        private static double ReadDouble(string variableName, double defaultValue)
        {
            var value = ReadString(variableName);
            if (value is null)
            {
                return defaultValue;
            }
            if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed))
            {
                throw new InvalidOperationException($"{variableName} : nombre invalide « {value} ».");
            }
            if (parsed < 0)
            {
                throw new InvalidOperationException($"{variableName} : valeur négative interdite ({parsed}).");
            }
            return parsed;
        }
    }
}
