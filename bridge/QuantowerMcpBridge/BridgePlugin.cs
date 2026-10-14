#if QUANTOWER_SDK
using System;
using System.Threading;
using TradingPlatform.BusinessLayer;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Module Quantower qui démarre le bridge HTTP local.
    ///
    /// ⚠️ PHASE 0 (plan §6 et §10) — points à valider avant tout développement d'outils :
    /// (a) la classe de base exacte d'un module « plugin » selon la version de Quantower
    ///     (ici `CustomPlugin` par défaut : à confirmer dans github.com/Quantower/Examples, dossier Plugins) ;
    /// (b) le mécanisme de déploiement/chargement (extension VS « Quantower Algo »,
    ///     option « Allow connection from Visual Studio », dossier de modules) ;
    /// (c) le thread d'exécution de OnInitialize (voir SynchronizationContextScheduler) ;
    /// (d) la disponibilité du DepthOfMarket sans licence payante.
    ///
    /// Le code métier ne vit PAS ici : il est dans BridgeHost/HttpServer/ICoreGateway, ce qui rend
    /// le bridge testable sans Quantower.
    /// </summary>
    public sealed class BridgePlugin : CustomPlugin
    {
        private readonly ILogSink _log = new ConsoleLogSink("plugin");
        private BridgeHost? _host;

        protected override void OnInitialize()
        {
            base.OnInitialize();

            var config = BridgeConfig.FromEnvironment();

            // Quantower exécute les modules sur son thread UI : on capture le SynchronizationContext
            // pour y sérialiser tous les appels Core (plan §2.1 A). Repli inline si indisponible.
            var scheduler = SynchronizationContext.Current is null
                ? (IWorkScheduler)new InlineScheduler()
                : new SynchronizationContextScheduler(SynchronizationContext.Current);

            var gateway = CoreGateway.Wrap(new QuantowerCoreGateway(), config, scheduler, _log);
            _host = BridgeHost.Start(config, gateway, _log);
        }

        protected override void OnDispose()
        {
            _host?.Dispose();
            _host = null;
            base.OnDispose();
        }
    }
}
#else
namespace QuantowerMcpBridge
{
    /// <summary>
    /// Compilation isolée (sans Quantower) : ce type n'est PAS le module Quantower.
    ///
    /// Pour compiler le vrai module plugin, relancer le build avec le SDK Quantower :
    ///   dotnet build -p:QuantowerSdkDir="C:\Program Files\Quantower\Trading Platform"
    /// (voir bridge/README.md, section « Phase 0 »).
    /// </summary>
    public static class BridgePlugin
    {
        public const string AssemblyDescription =
            "Bridge Quantower MCP (compilation isolée : définir QuantowerSdkDir pour compiler le module réel).";
    }
}
#endif
