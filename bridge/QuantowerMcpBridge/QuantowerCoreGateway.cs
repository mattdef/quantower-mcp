#if QUANTOWER_SDK
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using QuantowerMcpBridge.Dtos;
using TradingPlatform.BusinessLayer;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Implémentation réelle de <see cref="ICoreGateway"/> contre TradingPlatform.BusinessLayer.
    ///
    /// ⚠️ Ce fichier n'est compilé que si le SDK Quantower est fourni :
    ///   dotnet build -p:QuantowerSdkDir="C:\Program Files\Quantower\Trading Platform"
    ///
    /// ⚠️ PHASE 0 : toutes les zones marquées TODO(Phase 0) doivent être confrontées à
    /// api.quantower.com et à la version installée de Quantower (noms exacts des propriétés,
    /// signatures de GetHistory/ModifyOrder/PlaceOrder, entités retournées par TradingOperationResult).
    /// Le contrat JSON du bridge (DTOs) ne doit PAS être modifié lors de cet ajustement.
    /// </summary>
    public sealed class QuantowerCoreGateway : ICoreGateway
    {
        private static Core CoreInstance =>
            Core.Instance ?? throw new GatewayPlatformException(
                "Core.Instance est indisponible : le module QuantowerMcpBridge n'est pas chargé dans le terminal.");

        public Task<HealthDto> GetHealthAsync(System.Threading.CancellationToken cancellationToken)
        {
            var core = CoreInstance;
            var health = new HealthDto
            {
                Status = "ok",
                BridgeVersion = "0.1.0",
                // TODO(Phase 0) : exposer la version de la plateforme (Core.Version / assembly Quantower).
                PlatformVersion = null,
                StartedAtUtc = DateTime.UtcNow,
                UptimeSeconds = 0,
                TradingEnabled = true,
                ConnectionCount = core.Connections.Connected.Count,
            };
            return Task.FromResult(health);
        }

        public Task<IReadOnlyList<ConnectionDto>> GetConnectionsAsync(System.Threading.CancellationToken cancellationToken)
        {
            var connections = CoreInstance.Connections.Connected
                .Select(connection => new ConnectionDto
                {
                    ConnectionId = ToId(connection.Id),
                    Name = SafeString(connection.Name),
                    Status = SafeString(connection.Status),
                    // TODO(Phase 0) : exposer le type de connexion si disponible (ConnectionType).
                    Type = null,
                })
                .ToList();
            return Task.FromResult<IReadOnlyList<ConnectionDto>>(connections);
        }

        public Task<IReadOnlyList<AccountDto>> GetAccountsAsync(string? connectionId, System.Threading.CancellationToken cancellationToken)
        {
            var accounts = CoreInstance.Accounts
                .Where(account => Matches(ToId(account.ConnectionId), connectionId))
                .Select(account => new AccountDto
                {
                    AccountId = ToId(account.Id),
                    ConnectionId = ToId(account.ConnectionId),
                    Name = SafeString(account.Name),
                    Balance = ToDouble(account.Balance),
                    // TODO(Phase 0) : Equity / NetPnl / BuyingPower selon les propriétés réelles d'Account.
                    Equity = null,
                    Currency = SafeString(account.Currency),
                    NetPnl = null,
                    BuyingPower = null,
                })
                .ToList();
            return Task.FromResult<IReadOnlyList<AccountDto>>(accounts);
        }

        public Task<IReadOnlyList<SymbolDto>> SearchSymbolsAsync(
            string? query,
            string? connectionId,
            int limit,
            System.Threading.CancellationToken cancellationToken)
        {
            var text = (query ?? string.Empty).Trim();
            var symbols = CoreInstance.Symbols
                .Where(symbol => Matches(ToId(symbol.ConnectionId), connectionId))
                .Where(symbol =>
                    text.Length == 0 ||
                    SafeString(symbol.Name).IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    SafeString(symbol.Description).IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0)
                .Take(Math.Max(1, limit))
                .Select(symbol => new SymbolDto
                {
                    SymbolId = SafeString(symbol.Name),
                    ConnectionId = ToId(symbol.ConnectionId),
                    Name = SafeString(symbol.Name),
                    Description = SafeString(symbol.Description),
                    TickSize = ToDouble(symbol.TickSize),
                    // TODO(Phase 0) : noms exacts LotStep/MinLot/MaxLot sur Symbol.
                    LotStep = ToDouble(symbol.LotStep),
                    MinLot = ToDouble(symbol.MinLot),
                    MaxLot = ToDouble(symbol.MaxLot),
                    BaseAsset = SafeString(symbol.BaseAsset),
                    QuoteAsset = SafeString(symbol.QuoteAsset),
                })
                .ToList();
            return Task.FromResult<IReadOnlyList<SymbolDto>>(symbols);
        }

        public Task<QuoteDto> GetQuoteAsync(string symbolId, string? connectionId, System.Threading.CancellationToken cancellationToken)
        {
            var symbol = FindSymbol(symbolId, connectionId);
            return Task.FromResult(new QuoteDto
            {
                SymbolId = SafeString(symbol.Name),
                ConnectionId = ToId(symbol.ConnectionId),
                Bid = ToDouble(symbol.Bid),
                Ask = ToDouble(symbol.Ask),
                Last = ToDouble(symbol.Last),
                Volume = ToDouble(symbol.Volume),
                Open = ToDouble(symbol.Open),
                High = ToDouble(symbol.High),
                Low = ToDouble(symbol.Low),
                PreviousClose = ToDouble(symbol.PrevClose),
                TimestampUtc = DateTime.UtcNow,
            });
        }

        public Task<HistoryResponseDto> GetHistoryAsync(
            string symbolId,
            string timeframe,
            DateTime? fromUtc,
            DateTime? toUtc,
            int limit,
            string? connectionId,
            System.Threading.CancellationToken cancellationToken)
        {
            var symbol = FindSymbol(symbolId, connectionId);
            var period = MapPeriod(timeframe);
            var from = fromUtc ?? DateTime.UtcNow.AddDays(-1);
            var to = toUtc ?? DateTime.UtcNow;

            // TODO(Phase 0) : confirmer la signature exacte de Symbol.GetHistory (Period, from, to)
            // et le type retourné (HistoricalData / IHistoryItem) — plan §10 point (b).
            var history = symbol.GetHistory(period, from, to);
            var bars = new List<BarDto>();
            for (var index = 0; index < history.Count && bars.Count < limit; index += 1)
            {
                var item = history[index];
                bars.Add(new BarDto
                {
                    TimestampUtc = item.TimeLeft.ToUniversalTime(),
                    Open = item[PriceType.Open],
                    High = item[PriceType.High],
                    Low = item[PriceType.Low],
                    Close = item[PriceType.Close],
                    Volume = item[PriceType.Volume],
                });
            }

            return Task.FromResult(new HistoryResponseDto
            {
                SymbolId = SafeString(symbol.Name),
                ConnectionId = ToId(symbol.ConnectionId),
                Timeframe = timeframe,
                Bars = bars,
            });
        }

        public Task<DomResponseDto> GetDomAsync(
            string symbolId,
            int depth,
            string? connectionId,
            System.Threading.CancellationToken cancellationToken)
        {
            var symbol = FindSymbol(symbolId, connectionId);

            // TODO(Phase 0) : le DepthOfMarket Quantower doit être confirmé
            // (structure réelle des niveaux, disponibilité selon la licence — plan §10 point (d)).
            var depthOfMarket = symbol.DepthOfMarket;
            if (depthOfMarket == null)
            {
                throw new GatewayNotFoundException(
                    $"Depth of market indisponible pour {symbolId} (connexion ou licence).",
                    new { symbolId, connectionId });
            }

            var bids = new List<DomLevelDto>();
            var asks = new List<DomLevelDto>();
            // TODO(Phase 0) : remplacer par l'API réelle (ex. depthOfMarket.GetLevel2Quotes()).
            // Exemple de parcours attendu :
            //   foreach (var quote in depthOfMarket.GetBids(depth)) bids.Add(new DomLevelDto { Price = quote.Price, Size = quote.Size });
            //   foreach (var quote in depthOfMarket.GetAsks(depth)) asks.Add(new DomLevelDto { Price = quote.Price, Size = quote.Size });
            throw new GatewayNotImplementedException(
                "La lecture du DOM doit être finalisée en Phase 0 avec la signature réelle de DepthOfMarket.",
                new { symbolId, depth });
        }

        public Task<IReadOnlyList<PositionDto>> GetPositionsAsync(
            string? connectionId,
            string? accountId,
            System.Threading.CancellationToken cancellationToken)
        {
            var positions = CoreInstance.Positions
                .Where(position =>
                    Matches(ToId(position.ConnectionId), connectionId) &&
                    Matches(ToId(position.Account?.Id), accountId))
                .Select(position => new PositionDto
                {
                    PositionId = ToId(position.Id),
                    ConnectionId = ToId(position.ConnectionId),
                    AccountId = ToId(position.Account?.Id),
                    SymbolId = SafeString(position.Symbol?.Name),
                    Side = MapSide(position.Side),
                    Quantity = Math.Abs(ToDouble(position.Quantity) ?? 0),
                    OpenPrice = ToDouble(position.OpenPrice),
                    CurrentPrice = ToDouble(position.CurrentPrice),
                    NetPnl = ToDouble(position.NetPnL),
                    GrossPnl = null,
                    OpenTimeUtc = ToNullableUtc(position.OpenTime),
                })
                .ToList();
            return Task.FromResult<IReadOnlyList<PositionDto>>(positions);
        }

        public Task<IReadOnlyList<OrderDto>> GetOrdersAsync(
            string? connectionId,
            string? accountId,
            System.Threading.CancellationToken cancellationToken)
        {
            var orders = CoreInstance.Orders
                .Where(order =>
                    Matches(ToId(order.ConnectionId), connectionId) &&
                    Matches(ToId(order.Account?.Id), accountId))
                .Select(MapOrder)
                .ToList();
            return Task.FromResult<IReadOnlyList<OrderDto>>(orders);
        }

        public Task<IReadOnlyList<OrderDto>> GetOrdersHistoryAsync(
            DateTime? fromUtc,
            DateTime? toUtc,
            int limit,
            string? connectionId,
            string? accountId,
            System.Threading.CancellationToken cancellationToken)
        {
            var from = fromUtc ?? DateTime.UtcNow.AddDays(-7);
            var to = toUtc ?? DateTime.UtcNow;

            // TODO(Phase 0) : confirmer la signature de Core.GetOrdersHistory(fromTime, toTime)
            // et le type retourné (OrderHistory).
            var history = CoreInstance.GetOrdersHistory(from, to);
            var orders = history
                .Where(order =>
                    Matches(ToId(order.ConnectionId), connectionId) &&
                    Matches(ToId(order.Account?.Id), accountId))
                .Take(Math.Max(1, limit))
                .Select(MapOrder)
                .ToList();
            return Task.FromResult<IReadOnlyList<OrderDto>>(orders);
        }

        public Task<IReadOnlyList<TradeDto>> GetTradesAsync(
            string? connectionId,
            string? accountId,
            int limit,
            System.Threading.CancellationToken cancellationToken)
        {
            var trades = CoreInstance.Trades
                .Where(trade =>
                    Matches(ToId(trade.ConnectionId), connectionId) &&
                    Matches(ToId(trade.Account?.Id), accountId))
                .Take(Math.Max(1, limit))
                .Select(trade => new TradeDto
                {
                    TradeId = ToId(trade.Id),
                    ConnectionId = ToId(trade.ConnectionId),
                    AccountId = ToId(trade.Account?.Id),
                    SymbolId = SafeString(trade.Symbol?.Name),
                    Side = MapSide(trade.Side),
                    Quantity = Math.Abs(ToDouble(trade.Quantity) ?? 0),
                    Price = ToDouble(trade.Price) ?? 0,
                    TimestampUtc = ToNullableUtc(trade.DateTime) ?? DateTime.UtcNow,
                    Fee = ToDouble(trade.Fee),
                    OrderId = ToId(trade.OrderId),
                })
                .ToList();
            return Task.FromResult<IReadOnlyList<TradeDto>>(trades);
        }

        public Task<TradingResultDto> PlaceOrderAsync(PlaceOrderRequestDto request, System.Threading.CancellationToken cancellationToken)
        {
            // TODO(Phase 0) : confirmer les noms exacts des champs de PlaceOrderRequestParameters
            // (OrderTypeId, TimeInForce, Price, TriggerPrice, StopLoss, TakeProfit, Comment…).
            var parameters = new PlaceOrderRequestParameters
            {
                Account = FindAccount(request.AccountId),
                Symbol = FindSymbol(request.SymbolId, request.ConnectionId),
                Side = MapSideEnum(request.Side),
                OrderTypeId = MapOrderTypeId(request.OrderType),
                Quantity = request.Quantity,
                Price = request.Price ?? 0,
                TriggerPrice = request.TriggerPrice ?? 0,
                TimeInForce = MapTimeInForce(request.TimeInForce),
                StopLoss = MapProtection(request.StopLoss, isStopLoss: true),
                TakeProfit = MapProtection(request.TakeProfit, isStopLoss: false),
            };

            var result = CoreInstance.PlaceOrder(parameters);
            return Task.FromResult(MapTradingResult(result));
        }

        public Task<TradingResultDto> ModifyOrderAsync(
            string orderId,
            ModifyOrderRequestDto request,
            System.Threading.CancellationToken cancellationToken)
        {
            var order = FindOrder(orderId);
            // TODO(Phase 0) : confirmer le type/candidat des paramètres de modification
            // (ModifyOrderRequestParameters ? overload de Core.ModifyOrder ?).
            var parameters = new ModifyOrderRequestParameters
            {
                Quantity = request.Quantity ?? Math.Abs(ToDouble(order.Quantity) ?? 0),
                Price = request.Price ?? ToDouble(order.Price) ?? 0,
                TriggerPrice = request.TriggerPrice ?? ToDouble(order.TriggerPrice) ?? 0,
            };
            if (!string.IsNullOrWhiteSpace(request.TimeInForce))
            {
                parameters.TimeInForce = MapTimeInForce(request.TimeInForce);
            }

            var result = CoreInstance.ModifyOrder(order, parameters);
            return Task.FromResult(MapTradingResult(result, orderId));
        }

        public Task<TradingResultDto> CancelOrderAsync(string orderId, System.Threading.CancellationToken cancellationToken)
        {
            var order = FindOrder(orderId);
            var result = CoreInstance.CancelOrder(order);
            return Task.FromResult(MapTradingResult(result, orderId));
        }

        public Task<TradingResultDto> ClosePositionAsync(
            string positionId,
            double? quantity,
            System.Threading.CancellationToken cancellationToken)
        {
            var position = CoreInstance.Positions.FirstOrDefault(
                candidate => string.Equals(ToId(candidate.Id), positionId, StringComparison.OrdinalIgnoreCase));
            if (position == null)
            {
                throw new GatewayNotFoundException($"Position inconnue : {positionId}.", new { positionId });
            }

            // TODO(Phase 0) : confirmer la signature de Core.ClosePosition(position, quantity).
            var result = quantity.HasValue
                ? CoreInstance.ClosePosition(position, quantity.Value)
                : CoreInstance.ClosePosition(position);
            return Task.FromResult(MapTradingResult(result, positionId: positionId));
        }

        // ------------------------------------------------------------------ Mappers

        private static Symbol FindSymbol(string symbolId, string? connectionId)
        {
            var symbol = CoreInstance.Symbols.FirstOrDefault(candidate =>
                string.Equals(SafeString(candidate.Name), symbolId, StringComparison.OrdinalIgnoreCase) &&
                Matches(ToId(candidate.ConnectionId), connectionId));
            if (symbol == null)
            {
                throw new GatewayNotFoundException(
                    $"Instrument inconnu : {symbolId}.",
                    new { symbolId, connectionId });
            }
            return symbol;
        }

        private static Account FindAccount(string accountId)
        {
            var account = CoreInstance.Accounts.FirstOrDefault(candidate =>
                string.Equals(ToId(candidate.Id), accountId, StringComparison.OrdinalIgnoreCase));
            if (account == null)
            {
                throw new GatewayNotFoundException($"Compte inconnu : {accountId}.", new { accountId });
            }
            return account;
        }

        private static Order FindOrder(string orderId)
        {
            var order = CoreInstance.Orders.FirstOrDefault(candidate =>
                string.Equals(ToId(candidate.Id), orderId, StringComparison.OrdinalIgnoreCase));
            if (order == null)
            {
                throw new GatewayNotFoundException($"Ordre inconnu ou terminé : {orderId}.", new { orderId });
            }
            return order;
        }

        private static OrderDto MapOrder(Order order)
        {
            return new OrderDto
            {
                OrderId = ToId(order.Id),
                ConnectionId = ToId(order.ConnectionId),
                AccountId = ToId(order.Account?.Id),
                SymbolId = SafeString(order.Symbol?.Name),
                Side = MapSide(order.Side),
                OrderType = SafeString(order.OrderTypeId).ToLowerInvariant().Replace(" ", "_"),
                Status = SafeString(order.Status).ToLowerInvariant(),
                Quantity = Math.Abs(ToDouble(order.TotalQuantity) ?? ToDouble(order.Quantity) ?? 0),
                FilledQuantity = ToDouble(order.FilledQuantity),
                Price = ToDouble(order.Price),
                TriggerPrice = ToDouble(order.TriggerPrice),
                TimeInForce = SafeString(order.TimeInForce),
                CreatedAtUtc = ToNullableUtc(order.CreationTime),
                Comment = SafeString(order.Comment),
            };
        }

        private static TradingResultDto MapTradingResult(
            TradingOperationResult result,
            string? orderId = null,
            string? positionId = null)
        {
            var success = result.Status == TradingOperationResultStatus.Success;
            var message = SafeString(result.Message);
            return success
                ? TradingResultDto.Success(message, orderId, positionId)
                : TradingResultDto.Failure(message, orderId, positionId);
        }

        private static Period MapPeriod(string timeframe)
        {
            switch ((timeframe ?? string.Empty).Trim().ToLowerInvariant())
            {
                case "1m":
                    return Period.MIN1;
                case "5m":
                    return Period.MIN5;
                case "15m":
                    return Period.MIN15;
                case "30m":
                    return Period.MIN30;
                case "1h":
                    return Period.HOUR1;
                case "2h":
                    return Period.HOUR2;
                case "4h":
                    return Period.HOUR4;
                case "1d":
                    return Period.DAY1;
                case "1w":
                    return Period.WEEK1;
                default:
                    throw new GatewayValidationException($"Timeframe non supporté : « {timeframe} ».");
            }
        }

        private static string MapSide(Side? side) =>
            side == Side.Sell ? "sell" : "buy";

        private static Side MapSideEnum(string? side) =>
            string.Equals(side, "sell", StringComparison.OrdinalIgnoreCase) ? Side.Sell : Side.Buy;

        private static string MapOrderTypeId(string? orderType)
        {
            switch ((orderType ?? string.Empty).Trim().ToLowerInvariant())
            {
                case "market":
                    return OrderType.Market;
                case "limit":
                    return OrderType.Limit;
                case "stop":
                    return OrderType.Stop;
                case "stop_limit":
                    return OrderType.StopLimit;
                default:
                    throw new GatewayValidationException($"orderType non supporté : « {orderType} ».");
            }
        }

        private static TimeInForce MapTimeInForce(string? timeInForce)
        {
            switch ((timeInForce ?? string.Empty).Trim().ToLowerInvariant())
            {
                case "day":
                    return TimeInForce.Day;
                case "gtd":
                    return TimeInForce.GTD;
                case "ioc":
                    return TimeInForce.IOC;
                case "fok":
                    return TimeInForce.FOK;
                case "gtc":
                case "":
                    return TimeInForce.GTC;
                default:
                    throw new GatewayValidationException($"timeInForce non supporté : « {timeInForce} ».");
            }
        }

        private static SlTpHolder? MapProtection(ProtectionDto? protection, bool isStopLoss)
        {
            if (protection == null)
            {
                return null;
            }
            if (protection.Price.HasValue)
            {
                return isStopLoss
                    ? SlTpHolder.CreateSL(protection.Price.Value)
                    : SlTpHolder.CreateTP(protection.Price.Value);
            }
            if (protection.OffsetTicks.HasValue)
            {
                // TODO(Phase 0) : confirmer l'API d'offset (PriceMeasurement.Offset / ticks).
                return isStopLoss
                    ? SlTpHolder.CreateSL(protection.OffsetTicks.Value)
                    : SlTpHolder.CreateTP(protection.OffsetTicks.Value);
            }
            throw new GatewayValidationException(
                isStopLoss ? "stopLoss exige price ou offsetTicks." : "takeProfit exige price ou offsetTicks.");
        }

        // ------------------------------------------------------------------ Conversion

        private static bool Matches(string actual, string? expected) =>
            string.IsNullOrWhiteSpace(expected) || string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);

        private static string ToId(object? value) => Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty;

        private static string SafeString(object? value) => Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty;

        private static double? ToDouble(object? value)
        {
            if (value == null)
            {
                return null;
            }
            try
            {
                return Convert.ToDouble(value, CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static DateTime? ToNullableUtc(DateTime value)
        {
            if (value == default(DateTime))
            {
                return null;
            }
            return value.Kind == DateTimeKind.Utc ? value : value.ToUniversalTime();
        }
    }
}
#endif
