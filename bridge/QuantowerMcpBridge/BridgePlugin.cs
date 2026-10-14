#if QUANTOWER_SDK
using System.Collections.Generic;
using System.Drawing;
using System.Threading;
using TradingPlatform.PresentationLayer.Plugins;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Module Quantower qui démarre le bridge HTTP local.
    ///
    /// Faits vérifiés sur les exemples officiels Quantower (LinkingExamplePlugin, BrowserBasedPlugin,
    /// GDIBasedPlugin) et des plugins réels (v1.146.18) :
    ///   • classe de base <see cref="Plugin"/> (namespace TradingPlatform.PresentationLayer.Plugins) ;
    ///   • cycle de vie : <c>Initialize()</c> à la création du panneau, <c>Dispose()</c> à sa fermeture ;
    ///   • métadonnées : <c>static PluginInfo GetInfo()</c>.
    /// Le panneau est volontairement sans HTML (BrowserUsageType.None) : il n'expose aucune UI,
    /// il sert uniquement à charger/démarrer le bridge dans le terminal.
    ///
    /// Le code métier ne vit PAS ici : il est dans BridgeHost/HttpServer/ICoreGateway, ce qui rend
    /// le bridge testable sans Quantower. Voir bridge/README.md (Phase 0).
    /// </summary>
    public sealed class BridgePlugin : Plugin
    {
        private readonly ILogSink _log = new ConsoleLogSink("plugin");
        private BridgeHost? _host;

        /// <summary>
        /// Métadonnées du module (nom = dossier déployé sous bin\plug-ins\).
        /// Structure reprise des exemples officiels ; pas de TemplateName (aucune fenêtre HTML).
        /// </summary>
        public static PluginInfo GetInfo()
        {
            var windowParameters = NativeWindowParameters.Panel;
            windowParameters.BrowserUsageType = BrowserUsageType.None;

            return new PluginInfo()
            {
                Name = "QuantowerMcpBridge",
                Title = "Quantower MCP Bridge",
                Group = PluginGroup.Misc,
                ShortName = "QMB",
                WindowParameters = windowParameters,
                CustomProperties = new Dictionary<string, object>()
                {
                    { PluginInfo.Const.ALLOW_MANUAL_CREATION, true },
                },
            };
        }

        public override Size DefaultSize => new Size(320, 200);

        /// <summary>
        /// Appelé une fois à la création du module. Quantower exécute les modules sur son thread UI :
        /// on capture le SynchronizationContext pour y sérialiser tous les appels Core (plan §2.1 A).
        /// Repli inline si indisponible.
        /// </summary>
        public override void Initialize()
        {
            base.Initialize();

            var config = BridgeConfig.FromEnvironment();

            var scheduler = SynchronizationContext.Current is null
                ? (IWorkScheduler)new InlineScheduler()
                : new SynchronizationContextScheduler(SynchronizationContext.Current);

            var gateway = CoreGateway.Wrap(new QuantowerCoreGateway(), config, scheduler, _log);
            _host = BridgeHost.Start(config, gateway, _log);
        }

        /// <summary>Appelé à la fermeture du module : arrêt symétrique du bridge.</summary>
        public override void Dispose()
        {
            _host?.Dispose();
            _host = null;
            base.Dispose();
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
    ///   dotnet build bridge/QuantowerMcpBridge/QuantowerMcpBridge.csproj -p:QuantowerSdkDir="C:\Quantower\TradingPlatform\v1.146.18\bin"
    /// (voir bridge/README.md, section « Phase 0 »).
    /// </summary>
    public static class BridgePlugin
    {
        public const string AssemblyDescription =
            "Bridge Quantower MCP (compilation isolée : définir QuantowerSdkDir pour compiler le module réel).";
    }
}
#endif
