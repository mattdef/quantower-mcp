using System;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Assemblage du bridge : configuration + gateway + serveur HTTP + audit.
    /// Utilisé à l'identique par le plugin Quantower (BridgePlugin) et par le host standalone (Program).
    /// </summary>
    public sealed class BridgeHost : IDisposable
    {
        private readonly HttpServer _server;

        private BridgeHost(HttpServer server, BridgeConfig config)
        {
            _server = server;
            Config = config;
        }

        public BridgeConfig Config { get; }

        public string BaseUrl => _server.BaseUrl;

        /// <summary>
        /// Démarre le bridge. Le gateway fourni doit déjà être enveloppé par CoreGateway.Wrap(...)
        /// si l'on veut la sérialisation + le timeout (recommandé).
        /// </summary>
        public static BridgeHost Start(BridgeConfig config, ICoreGateway gateway, ILogSink log)
        {
            config.EnsureToken();

            var audit = new AuditLog(config.AuditLogPath, log);
            var guard = new TradingGuard(config);
            var server = new HttpServer(config, gateway, audit, guard, log);

            try
            {
                server.Start();
            }
            catch (Exception)
            {
                server.Dispose();
                throw;
            }

            log.Info(
                $"Bridge prêt : {server.BaseUrl}/ — token dans {config.TokenFilePath} — audit dans {config.AuditLogPath}");
            return new BridgeHost(server, config);
        }

        public void Dispose()
        {
            _server.Dispose();
        }
    }
}
