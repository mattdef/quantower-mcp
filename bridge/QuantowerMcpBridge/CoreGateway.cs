using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using QuantowerMcpBridge.Dtos;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Ordonnanceur de travail : permet d'exécuter les appels Core sur le thread UI de Quantower
    /// (plan §2.1 A et §8 : « dispatcher + file d'attente »).
    /// </summary>
    public interface IWorkScheduler
    {
        Task<T> RunAsync<T>(Func<Task<T>> work, CancellationToken cancellationToken);
    }

    /// <summary>Exécution immédiate sur le thread appelant (standalone/stub).</summary>
    public sealed class InlineScheduler : IWorkScheduler
    {
        public Task<T> RunAsync<T>(Func<Task<T>> work, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return work();
        }
    }

    /// <summary>
    /// Exécution via un SynchronizationContext capturé au démarrage du plugin
    /// (thread UI de Quantower). Évite toute dépendance WPF dans ce projet.
    ///
    /// ⚠️ Phase 0 : confirmer que OnInitialize() du module s'exécute bien sur le thread UI
    /// et que la plateforme pompe bien le SynchronizationContext (plan §10 point c).
    /// </summary>
    public sealed class SynchronizationContextScheduler : IWorkScheduler
    {
        private readonly SynchronizationContext _context;

        public SynchronizationContextScheduler(SynchronizationContext context)
        {
            _context = context ?? throw new ArgumentNullException(nameof(context));
        }

        public Task<T> RunAsync<T>(Func<Task<T>> work, CancellationToken cancellationToken)
        {
            var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            _context.Post(
                async _ =>
                {
                    try
                    {
                        completion.TrySetResult(await work().ConfigureAwait(true));
                    }
                    catch (Exception exception)
                    {
                        completion.TrySetException(exception);
                    }
                },
                null);
            return completion.Task;
        }
    }

    /// <summary>
    /// Enveloppe le gateway réel : sérialise les appels (SemaphoreSlim) et applique un timeout
    /// pour ne jamais bloquer le serveur HTTP sur une opération plateforme longue (plan §2.1 A).
    /// </summary>
    public sealed class CoreGateway : ICoreGateway
    {
        private readonly ICoreGateway _inner;
        private readonly IWorkScheduler _scheduler;
        private readonly TimeSpan _operationTimeout;
        private readonly ILogSink _log;
        private readonly SemaphoreSlim _serializer = new SemaphoreSlim(1, 1);

        public CoreGateway(ICoreGateway inner, IWorkScheduler scheduler, TimeSpan operationTimeout, ILogSink log)
        {
            _inner = inner ?? throw new ArgumentNullException(nameof(inner));
            _scheduler = scheduler ?? throw new ArgumentNullException(nameof(scheduler));
            _operationTimeout = operationTimeout;
            _log = log ?? NullLogSink.Instance;
        }

        /// <summary>Fabrique pratique utilisée par Program.cs et BridgePlugin.</summary>
        public static CoreGateway Wrap(ICoreGateway inner, BridgeConfig config, IWorkScheduler scheduler, ILogSink log) =>
            new CoreGateway(inner, scheduler, TimeSpan.FromSeconds(config.OperationTimeoutSeconds), log);

        public Task<HealthDto> GetHealthAsync(CancellationToken cancellationToken) =>
            InvokeAsync("health", (gateway, token) => gateway.GetHealthAsync(token), cancellationToken);

        public Task<IReadOnlyList<ConnectionDto>> GetConnectionsAsync(CancellationToken cancellationToken) =>
            InvokeAsync("connections", (gateway, token) => gateway.GetConnectionsAsync(token), cancellationToken);

        public Task<IReadOnlyList<AccountDto>> GetAccountsAsync(string? connectionId, CancellationToken cancellationToken) =>
            InvokeAsync(
                "accounts",
                (gateway, token) => gateway.GetAccountsAsync(connectionId, token),
                cancellationToken);

        public Task<IReadOnlyList<SymbolDto>> SearchSymbolsAsync(
            string? query,
            string? connectionId,
            int limit,
            CancellationToken cancellationToken) =>
            InvokeAsync(
                "symbols",
                (gateway, token) => gateway.SearchSymbolsAsync(query, connectionId, limit, token),
                cancellationToken);

        public Task<QuoteDto> GetQuoteAsync(string symbolId, string? connectionId, CancellationToken cancellationToken) =>
            InvokeAsync(
                "quote",
                (gateway, token) => gateway.GetQuoteAsync(symbolId, connectionId, token),
                cancellationToken);

        public Task<HistoryResponseDto> GetHistoryAsync(
            string symbolId,
            string timeframe,
            DateTime? fromUtc,
            DateTime? toUtc,
            int limit,
            string? connectionId,
            CancellationToken cancellationToken) =>
            InvokeAsync(
                "history",
                (gateway, token) => gateway.GetHistoryAsync(symbolId, timeframe, fromUtc, toUtc, limit, connectionId, token),
                cancellationToken);

        public Task<DomResponseDto> GetDomAsync(
            string symbolId,
            int depth,
            string? connectionId,
            CancellationToken cancellationToken) =>
            InvokeAsync(
                "dom",
                (gateway, token) => gateway.GetDomAsync(symbolId, depth, connectionId, token),
                cancellationToken);

        public Task<IReadOnlyList<PositionDto>> GetPositionsAsync(
            string? connectionId,
            string? accountId,
            CancellationToken cancellationToken) =>
            InvokeAsync(
                "positions",
                (gateway, token) => gateway.GetPositionsAsync(connectionId, accountId, token),
                cancellationToken);

        public Task<IReadOnlyList<OrderDto>> GetOrdersAsync(
            string? connectionId,
            string? accountId,
            CancellationToken cancellationToken) =>
            InvokeAsync(
                "orders",
                (gateway, token) => gateway.GetOrdersAsync(connectionId, accountId, token),
                cancellationToken);

        public Task<IReadOnlyList<OrderDto>> GetOrdersHistoryAsync(
            DateTime? fromUtc,
            DateTime? toUtc,
            int limit,
            string? connectionId,
            string? accountId,
            CancellationToken cancellationToken) =>
            InvokeAsync(
                "orders/history",
                (gateway, token) => gateway.GetOrdersHistoryAsync(fromUtc, toUtc, limit, connectionId, accountId, token),
                cancellationToken);

        public Task<IReadOnlyList<TradeDto>> GetTradesAsync(
            string? connectionId,
            string? accountId,
            int limit,
            CancellationToken cancellationToken) =>
            InvokeAsync(
                "trades",
                (gateway, token) => gateway.GetTradesAsync(connectionId, accountId, limit, token),
                cancellationToken);

        public Task<TradingResultDto> PlaceOrderAsync(PlaceOrderRequestDto request, CancellationToken cancellationToken) =>
            InvokeAsync(
                "place-order",
                (gateway, token) => gateway.PlaceOrderAsync(request, token),
                cancellationToken);

        public Task<TradingResultDto> ModifyOrderAsync(
            string orderId,
            ModifyOrderRequestDto request,
            CancellationToken cancellationToken) =>
            InvokeAsync(
                "modify-order",
                (gateway, token) => gateway.ModifyOrderAsync(orderId, request, token),
                cancellationToken);

        public Task<TradingResultDto> CancelOrderAsync(string orderId, CancellationToken cancellationToken) =>
            InvokeAsync(
                "cancel-order",
                (gateway, token) => gateway.CancelOrderAsync(orderId, token),
                cancellationToken);

        public Task<TradingResultDto> ClosePositionAsync(
            string positionId,
            double? quantity,
            CancellationToken cancellationToken) =>
            InvokeAsync(
                "close-position",
                (gateway, token) => gateway.ClosePositionAsync(positionId, quantity, token),
                cancellationToken);

        private async Task<T> InvokeAsync<T>(
            string operation,
            Func<ICoreGateway, CancellationToken, Task<T>> action,
            CancellationToken cancellationToken)
        {
            await _serializer.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var work = _scheduler.RunAsync(() => action(_inner, cancellationToken), cancellationToken);
                var finished = await Task.WhenAny(work, Task.Delay(_operationTimeout, cancellationToken))
                    .ConfigureAwait(false);
                if (!ReferenceEquals(finished, work))
                {
                    throw new GatewayTimeoutException(
                        $"L'opération « {operation} » a dépassé {_operationTimeout.TotalSeconds:0.#} s.",
                        new { operation, timeoutSeconds = _operationTimeout.TotalSeconds });
                }
                return await work.ConfigureAwait(false);
            }
            catch (GatewayException)
            {
                throw;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception exception)
            {
                _log.Error($"Échec de l'opération gateway « {operation} »", exception);
                throw new GatewayPlatformException(
                    $"Quantower a renvoyé une erreur pendant l'opération « {operation} ».",
                    new { operation, detail = exception.Message },
                    exception);
            }
            finally
            {
                _serializer.Release();
            }
        }
    }
}
