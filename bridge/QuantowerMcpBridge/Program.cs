using System;
using System.Globalization;
using System.Threading;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Host standalone du bridge.
    ///
    /// Permet de développer et de tester le serveur MCP / l'inspector SANS Quantower, en utilisant
    /// le <see cref="StubCoreGateway"/> (données déterministes). C'est le mode « compilation isolée »
    /// demandé par le plan (§6 Phase 0, repli documenté).
    ///
    /// Usage :
    ///   dotnet run --project bridge/QuantowerMcpBridge -- [--port 8765] [--token dev-token]
    ///                                                    [--latency 20] [--trading | --no-trading]
    /// </summary>
    internal static class Program
    {
        private static int Main(string[] args)
        {
            var log = new ConsoleLogSink("bridge");
            BridgeConfig config;
            var latencyMs = 20;
            var showHelp = false;

            try
            {
                config = BridgeConfig.FromEnvironment();

                for (var index = 0; index < args.Length; index += 1)
                {
                    var argument = args[index];
                    switch (argument)
                    {
                        case "--port":
                            if (index + 1 < args.Length &&
                                int.TryParse(args[index + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var port))
                            {
                                config.Port = port;
                                index += 1;
                            }
                            break;
                        case "--token":
                            if (index + 1 < args.Length)
                            {
                                config.Token = args[index + 1];
                                index += 1;
                            }
                            break;
                        case "--latency":
                            if (index + 1 < args.Length &&
                                int.TryParse(args[index + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var latency))
                            {
                                latencyMs = latency;
                                index += 1;
                            }
                            break;
                        case "--trading":
                            config.TradingEnabled = true;
                            break;
                        case "--no-trading":
                            config.TradingEnabled = false;
                            break;
                        case "--help":
                        case "-h":
                            showHelp = true;
                            break;
                    }
                }

                if (showHelp)
                {
                    PrintHelp();
                    return 0;
                }
            }
            catch (Exception exception)
            {
                log.Error("Configuration invalide", exception);
                return 1;
            }

            var stub = new StubCoreGateway { SimulatedLatencyMs = latencyMs };
            var gateway = CoreGateway.Wrap(stub, config, new InlineScheduler(), log);

            try
            {
                using (var host = BridgeHost.Start(config, gateway, log))
                {
                    Console.WriteLine($"Bridge Quantower MCP (mode stub) : {host.BaseUrl}/");
                    Console.WriteLine($"  token      : {config.Token}");
                    Console.WriteLine($"  token file : {config.TokenFilePath}");
                    Console.WriteLine($"  audit      : {config.AuditLogPath}");
                    Console.WriteLine(
                        $"  trading    : {(config.TradingEnabled ? "activé" : "désactivé (utilisez --trading ou QUANTOWER_BRIDGE_TRADING_ENABLED=true)")}");
                    Console.WriteLine($"  plafonds   : quantité ≤ {config.MaxOrderQuantity}, notionnel ≤ {config.MaxNotional}");
                    Console.WriteLine();
                    Console.WriteLine("Côté serveur MCP :");
                    Console.WriteLine($"  QUANTOWER_BRIDGE_URL={host.BaseUrl}");
                    Console.WriteLine($"  QUANTOWER_BRIDGE_TOKEN={config.Token}");
                    Console.WriteLine();
                    Console.WriteLine("Smoke test : node scripts/smoke-bridge.mjs --url " + host.BaseUrl + " --token " + config.Token);
                    Console.WriteLine("Ctrl+C pour arrêter.");

                    using (var waitHandle = new ManualResetEventSlim(false))
                    {
                        Console.CancelKeyPress += (_, eventArgs) =>
                        {
                            eventArgs.Cancel = true;
                            waitHandle.Set();
                        };
                        waitHandle.Wait();
                    }
                }
                return 0;
            }
            catch (Exception exception)
            {
                log.Error("Démarrage du bridge impossible", exception);
                return 1;
            }
        }

        private static void PrintHelp()
        {
            Console.WriteLine("Bridge Quantower MCP — host standalone (stub)");
            Console.WriteLine();
            Console.WriteLine("Options :");
            Console.WriteLine("  --port <n>      port d'écoute local (défaut 8765)");
            Console.WriteLine("  --token <t>     token Bearer (défaut : généré et écrit dans le fichier de token)");
            Console.WriteLine("  --latency <ms>  latence simulée du stub (défaut 20)");
            Console.WriteLine("  --trading       active les endpoints d'écriture (désactivés par défaut)");
            Console.WriteLine("  --no-trading    force la désactivation (déjà le défaut)");
            Console.WriteLine("  --help          affiche cette aide");
            Console.WriteLine();
            Console.WriteLine("Variables d'environnement : QUANTOWER_BRIDGE_PORT, QUANTOWER_BRIDGE_HOST,");
            Console.WriteLine("  QUANTOWER_BRIDGE_TOKEN, QUANTOWER_BRIDGE_TOKEN_FILE, QUANTOWER_BRIDGE_AUDIT_LOG,");
            Console.WriteLine("  QUANTOWER_BRIDGE_TRADING_ENABLED, QUANTOWER_BRIDGE_MAX_ORDER_QUANTITY,");
            Console.WriteLine("  QUANTOWER_BRIDGE_MAX_NOTIONAL, QUANTOWER_BRIDGE_DENY_MARKET_ORDERS,");
            Console.WriteLine("  QUANTOWER_BRIDGE_MAX_HISTORY_BARS, QUANTOWER_BRIDGE_OPERATION_TIMEOUT_SECONDS");
        }
    }
}
