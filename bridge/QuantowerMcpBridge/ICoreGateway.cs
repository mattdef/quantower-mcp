using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using QuantowerMcpBridge.Dtos;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Abstraction de la plateforme Quantower (plan §8 : « isoler le CoreGateway derrière une interface »).
    ///
    /// Deux implémentations :
    /// - <see cref="QuantowerCoreGateway"/> : le vrai accès à TradingPlatform.BusinessLayer (compilé uniquement
    ///   avec -p:QuantowerSdkDir=…, symbole QUANTOWER_SDK) ;
    /// - <see cref="StubCoreGateway"/> : données déterministes, permet de compiler/exécuter le bridge
    ///   sans Quantower (développement, tests MCP, E2E local).
    ///
    /// Aucun type de TradingPlatform.BusinessLayer ne doit apparaître dans cette interface :
    /// c'est ce qui garantit la compilation isolée.
    /// </summary>
    public interface ICoreGateway
    {
        Task<HealthDto> GetHealthAsync(CancellationToken cancellationToken);

        Task<IReadOnlyList<ConnectionDto>> GetConnectionsAsync(CancellationToken cancellationToken);

        Task<IReadOnlyList<AccountDto>> GetAccountsAsync(string? connectionId, CancellationToken cancellationToken);

        Task<IReadOnlyList<SymbolDto>> SearchSymbolsAsync(
            string? query,
            string? connectionId,
            int limit,
            CancellationToken cancellationToken);

        Task<QuoteDto> GetQuoteAsync(string symbolId, string? connectionId, CancellationToken cancellationToken);

        Task<HistoryResponseDto> GetHistoryAsync(
            string symbolId,
            string timeframe,
            DateTime? fromUtc,
            DateTime? toUtc,
            int limit,
            string? connectionId,
            CancellationToken cancellationToken);

        Task<DomResponseDto> GetDomAsync(
            string symbolId,
            int depth,
            string? connectionId,
            CancellationToken cancellationToken);

        Task<IReadOnlyList<PositionDto>> GetPositionsAsync(
            string? connectionId,
            string? accountId,
            CancellationToken cancellationToken);

        Task<IReadOnlyList<OrderDto>> GetOrdersAsync(
            string? connectionId,
            string? accountId,
            CancellationToken cancellationToken);

        Task<IReadOnlyList<OrderDto>> GetOrdersHistoryAsync(
            DateTime? fromUtc,
            DateTime? toUtc,
            int limit,
            string? connectionId,
            string? accountId,
            CancellationToken cancellationToken);

        Task<IReadOnlyList<TradeDto>> GetTradesAsync(
            string? connectionId,
            string? accountId,
            int limit,
            CancellationToken cancellationToken);

        Task<TradingResultDto> PlaceOrderAsync(PlaceOrderRequestDto request, CancellationToken cancellationToken);

        Task<TradingResultDto> ModifyOrderAsync(
            string orderId,
            ModifyOrderRequestDto request,
            CancellationToken cancellationToken);

        Task<TradingResultDto> CancelOrderAsync(string orderId, CancellationToken cancellationToken);

        Task<TradingResultDto> ClosePositionAsync(
            string positionId,
            double? quantity,
            CancellationToken cancellationToken);
    }
}
