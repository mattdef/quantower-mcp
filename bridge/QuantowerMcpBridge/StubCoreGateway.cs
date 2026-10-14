using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using QuantowerMcpBridge.Dtos;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Implémentation « stub » du gateway : données déterministes, mutables en mémoire.
    ///
    /// Objectifs (plan §6 Phase 0 et exigence « compilation isolée ») :
    /// - permettre de compiler et d'exécuter le bridge SANS Quantower ni TradingPlatform.BusinessLayer ;
    /// - permettre au serveur MCP et à l'inspector d'être développés/testés avant la Phase 1 réelle.
    ///
    /// ⚠️ Cette implémentation n'est jamais chargée dans Quantower en production : le plugin utilise
    /// <see cref="QuantowerCoreGateway"/> (compilation avec QUANTOWER_SDK).
    /// </summary>
    public sealed class StubCoreGateway : ICoreGateway
    {
        private const string RejectAccountId = "ACC-REJECT";
        private const string RejectSymbolPrefix = "FAIL";

        private static readonly DateTime FixedNowUtc = new DateTime(2026, 10, 13, 20, 0, 0, DateTimeKind.Utc);

        private readonly List<ConnectionDto> _connections = new List<ConnectionDto>
        {
            new ConnectionDto
            {
                ConnectionId = "SIM-1",
                Name = "Quantower Trading Simulator (stub)",
                Status = "connected",
                Type = "simulator",
            },
        };

        private readonly List<AccountDto> _accounts = new List<AccountDto>
        {
            new AccountDto
            {
                AccountId = "ACC-DEMO-USD",
                ConnectionId = "SIM-1",
                Name = "Demo USD (stub)",
                Balance = 100_000,
                Equity = 100_250,
                Currency = "USD",
                NetPnl = 250,
                BuyingPower = 500_000,
            },
        };

        private readonly List<SymbolDto> _symbols = new List<SymbolDto>
        {
            new SymbolDto
            {
                SymbolId = "EUR/USD",
                ConnectionId = "SIM-1",
                Name = "EUR/USD",
                Description = "Euro vs US Dollar (stub)",
                TickSize = 0.00001,
                LotStep = 0.01,
                MinLot = 0.01,
                MaxLot = 100,
                BaseAsset = "EUR",
                QuoteAsset = "USD",
            },
            new SymbolDto
            {
                SymbolId = "BTC/USD",
                ConnectionId = "SIM-1",
                Name = "BTC/USD",
                Description = "Bitcoin vs US Dollar (stub)",
                TickSize = 0.5,
                LotStep = 0.001,
                MinLot = 0.001,
                MaxLot = 10,
                BaseAsset = "BTC",
                QuoteAsset = "USD",
            },
            new SymbolDto
            {
                SymbolId = "AAPL",
                ConnectionId = "SIM-1",
                Name = "AAPL",
                Description = "Apple Inc. (stub)",
                TickSize = 0.01,
                LotStep = 1,
                MinLot = 1,
                MaxLot = 1000,
                BaseAsset = "AAPL",
                QuoteAsset = "USD",
            },
        };

        private readonly Dictionary<string, double[]> _quotes = new Dictionary<string, double[]>(StringComparer.OrdinalIgnoreCase)
        {
            // [bid, ask, last, volume]
            { "EUR/USD", new[] { 1.08425, 1.08435, 1.0843, 125_000.0 } },
            { "BTC/USD", new[] { 68_450.5, 68_460.0, 68_455.0, 1_250.75 } },
            { "AAPL", new[] { 231.15, 231.2, 231.18, 45_230.0 } },
        };

        private readonly List<PositionDto> _positions = new List<PositionDto>
        {
            new PositionDto
            {
                PositionId = "POS-1",
                ConnectionId = "SIM-1",
                AccountId = "ACC-DEMO-USD",
                SymbolId = "EUR/USD",
                Side = "buy",
                Quantity = 0.5,
                OpenPrice = 1.08,
                CurrentPrice = 1.0843,
                NetPnl = 215,
                GrossPnl = 215,
                OpenTimeUtc = new DateTime(2026, 10, 13, 18, 0, 0, DateTimeKind.Utc),
            },
        };

        private readonly List<OrderDto> _workingOrders = new List<OrderDto>
        {
            new OrderDto
            {
                OrderId = "ORD-1001",
                ConnectionId = "SIM-1",
                AccountId = "ACC-DEMO-USD",
                SymbolId = "EUR/USD",
                Side = "buy",
                OrderType = "limit",
                Status = "working",
                Quantity = 0.25,
                FilledQuantity = 0,
                Price = 1.078,
                TimeInForce = "gtc",
                CreatedAtUtc = new DateTime(2026, 10, 13, 19, 30, 0, DateTimeKind.Utc),
                Comment = "stub bridge",
            },
        };

        private readonly List<OrderDto> _ordersHistory = new List<OrderDto>
        {
            new OrderDto
            {
                OrderId = "ORD-0900",
                ConnectionId = "SIM-1",
                AccountId = "ACC-DEMO-USD",
                SymbolId = "EUR/USD",
                Side = "buy",
                OrderType = "limit",
                Status = "filled",
                Quantity = 0.5,
                FilledQuantity = 0.5,
                Price = 1.08,
                TimeInForce = "gtc",
                CreatedAtUtc = new DateTime(2026, 10, 13, 17, 45, 0, DateTimeKind.Utc),
                Comment = "entrée position POS-1",
            },
        };

        private readonly List<TradeDto> _trades = new List<TradeDto>
        {
            new TradeDto
            {
                TradeId = "TRD-5001",
                ConnectionId = "SIM-1",
                AccountId = "ACC-DEMO-USD",
                SymbolId = "EUR/USD",
                Side = "buy",
                Quantity = 0.5,
                Price = 1.08,
                TimestampUtc = new DateTime(2026, 10, 13, 17, 45, 2, DateTimeKind.Utc),
                Fee = 0.5,
                OrderId = "ORD-0900",
            },
        };

        private readonly HashSet<string> _cancelledOrderIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private int _nextOrderNumber = 2000;

        /// <summary>Latence simulée pour exercer les timeouts côté MCP (0 = aucun délai).</summary>
        public int SimulatedLatencyMs { get; set; } = 20;

        /// <summary>Latence spécifique aux opérations d'écriture (défaut : 10 ms).</summary>
        public int SimulatedWriteLatencyMs { get; set; } = 10;

        public async Task<HealthDto> GetHealthAsync(CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedLatencyMs, cancellationToken).ConfigureAwait(false);
            return new HealthDto
            {
                Status = "ok",
                BridgeVersion = "0.1.0",
                PlatformVersion = "stub (Quantower non détecté)",
                StartedAtUtc = FixedNowUtc,
                UptimeSeconds = Math.Round((DateTime.UtcNow - FixedNowUtc).TotalSeconds, 3),
                TradingEnabled = true,
                Caps = new CapsDto(),
                ConnectionCount = _connections.Count,
            };
        }

        public async Task<IReadOnlyList<ConnectionDto>> GetConnectionsAsync(CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedLatencyMs, cancellationToken).ConfigureAwait(false);
            return _connections.ToList();
        }

        public async Task<IReadOnlyList<AccountDto>> GetAccountsAsync(string? connectionId, CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedLatencyMs, cancellationToken).ConfigureAwait(false);
            return _accounts.Where(account => Matches(account.ConnectionId, connectionId)).ToList();
        }

        public async Task<IReadOnlyList<SymbolDto>> SearchSymbolsAsync(
            string? query,
            string? connectionId,
            int limit,
            CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedLatencyMs, cancellationToken).ConfigureAwait(false);
            var text = (query ?? string.Empty).Trim();
            return _symbols
                .Where(symbol => Matches(symbol.ConnectionId, connectionId))
                .Where(symbol =>
                    text.Length == 0 ||
                    symbol.SymbolId.IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    symbol.Name.IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    (symbol.Description ?? string.Empty).IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0)
                .Take(Math.Max(1, limit))
                .ToList();
        }

        public async Task<QuoteDto> GetQuoteAsync(string symbolId, string? connectionId, CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedLatencyMs, cancellationToken).ConfigureAwait(false);
            var symbol = FindSymbol(symbolId, connectionId);
            var data = _quotes[symbol.SymbolId];
            return new QuoteDto
            {
                SymbolId = symbol.SymbolId,
                ConnectionId = symbol.ConnectionId,
                Bid = data[0],
                Ask = data[1],
                Last = data[2],
                Volume = data[3],
                Open = data[2] * 0.999,
                High = data[2] * 1.001,
                Low = data[2] * 0.998,
                PreviousClose = data[2] * 0.9995,
                TimestampUtc = FixedNowUtc,
            };
        }

        public async Task<HistoryResponseDto> GetHistoryAsync(
            string symbolId,
            string timeframe,
            DateTime? fromUtc,
            DateTime? toUtc,
            int limit,
            string? connectionId,
            CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedLatencyMs, cancellationToken).ConfigureAwait(false);
            var symbol = FindSymbol(symbolId, connectionId);
            var stepMs = TimeframeToMilliseconds(timeframe);
            var last = _quotes[symbol.SymbolId][2];
            var end = toUtc ?? FixedNowUtc;
            var amplitude = last * 0.001;
            var bars = new List<BarDto>();
            for (var index = limit - 1; index >= 0; index -= 1)
            {
                var offset = index - limit / 2.0;
                var barOpen = last + offset * amplitude * 0.25;
                var barClose = last + (offset + 1) * amplitude * 0.25;
                bars.Add(new BarDto
                {
                    TimestampUtc = end.AddMilliseconds(-index * stepMs),
                    Open = Round(barOpen),
                    High = Round(Math.Max(barOpen, barClose) + amplitude * 0.1),
                    Low = Round(Math.Min(barOpen, barClose) - amplitude * 0.1),
                    Close = Round(barClose),
                    Volume = Math.Round((double)(1000 + (index * 37) % 500)),
                });
            }

            if (fromUtc.HasValue)
            {
                bars = bars.Where(bar => bar.TimestampUtc >= fromUtc.Value).ToList();
            }

            return new HistoryResponseDto
            {
                SymbolId = symbol.SymbolId,
                ConnectionId = symbol.ConnectionId,
                Timeframe = timeframe,
                Bars = bars,
            };
        }

        public async Task<DomResponseDto> GetDomAsync(
            string symbolId,
            int depth,
            string? connectionId,
            CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedLatencyMs, cancellationToken).ConfigureAwait(false);
            var symbol = FindSymbol(symbolId, connectionId);
            var data = _quotes[symbol.SymbolId];
            var tick = symbol.TickSize ?? 0.01;
            var bids = new List<DomLevelDto>();
            var asks = new List<DomLevelDto>();
            for (var level = 0; level < depth; level += 1)
            {
                bids.Add(new DomLevelDto { Price = Round(data[0] - level * tick), Size = 1 + level * 0.5 });
                asks.Add(new DomLevelDto { Price = Round(data[1] + level * tick), Size = 1 + level * 0.5 });
            }

            return new DomResponseDto
            {
                SymbolId = symbol.SymbolId,
                ConnectionId = symbol.ConnectionId,
                TimestampUtc = FixedNowUtc,
                Bids = bids,
                Asks = asks,
            };
        }

        public async Task<IReadOnlyList<PositionDto>> GetPositionsAsync(
            string? connectionId,
            string? accountId,
            CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedLatencyMs, cancellationToken).ConfigureAwait(false);
            return _positions
                .Where(position => Matches(position.ConnectionId, connectionId) && Matches(position.AccountId, accountId))
                .ToList();
        }

        public async Task<IReadOnlyList<OrderDto>> GetOrdersAsync(
            string? connectionId,
            string? accountId,
            CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedLatencyMs, cancellationToken).ConfigureAwait(false);
            return _workingOrders
                .Where(order => Matches(order.ConnectionId, connectionId) && Matches(order.AccountId, accountId))
                .ToList();
        }

        public async Task<IReadOnlyList<OrderDto>> GetOrdersHistoryAsync(
            DateTime? fromUtc,
            DateTime? toUtc,
            int limit,
            string? connectionId,
            string? accountId,
            CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedLatencyMs, cancellationToken).ConfigureAwait(false);
            return _ordersHistory
                .Where(order => Matches(order.ConnectionId, connectionId) && Matches(order.AccountId, accountId))
                .Where(order =>
                    (order.CreatedAtUtc == null || !fromUtc.HasValue || order.CreatedAtUtc.Value >= fromUtc.Value) &&
                    (order.CreatedAtUtc == null || !toUtc.HasValue || order.CreatedAtUtc.Value <= toUtc.Value))
                .Take(Math.Max(1, limit))
                .ToList();
        }

        public async Task<IReadOnlyList<TradeDto>> GetTradesAsync(
            string? connectionId,
            string? accountId,
            int limit,
            CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedLatencyMs, cancellationToken).ConfigureAwait(false);
            return _trades
                .Where(trade => Matches(trade.ConnectionId, connectionId) && Matches(trade.AccountId, accountId))
                .Take(Math.Max(1, limit))
                .ToList();
        }

        public async Task<TradingResultDto> PlaceOrderAsync(
            PlaceOrderRequestDto request,
            CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedWriteLatencyMs, cancellationToken).ConfigureAwait(false);

            if (string.Equals(request.AccountId, RejectAccountId, StringComparison.OrdinalIgnoreCase) ||
                request.SymbolId.StartsWith(RejectSymbolPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return TradingResultDto.Failure(
                    "Rejected by broker: insufficient margin (stub bridge)",
                    orderId: null);
            }

            EnsureAccountExists(request.AccountId);
            var symbol = FindSymbol(request.SymbolId, request.ConnectionId);

            _nextOrderNumber += 1;
            var orderId = string.Format(CultureInfo.InvariantCulture, "ORD-{0}", _nextOrderNumber);
            _workingOrders.Add(new OrderDto
            {
                OrderId = orderId,
                ConnectionId = symbol.ConnectionId,
                AccountId = request.AccountId,
                SymbolId = symbol.SymbolId,
                Side = request.Side,
                OrderType = request.OrderType,
                Status = "working",
                Quantity = request.Quantity,
                FilledQuantity = 0,
                Price = request.Price,
                TriggerPrice = request.TriggerPrice,
                TimeInForce = request.TimeInForce,
                CreatedAtUtc = DateTime.UtcNow,
                Comment = request.Comment,
            });

            return TradingResultDto.Success($"Ordre {request.OrderType} accepté (stub bridge)", orderId);
        }

        public async Task<TradingResultDto> ModifyOrderAsync(
            string orderId,
            ModifyOrderRequestDto request,
            CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedWriteLatencyMs, cancellationToken).ConfigureAwait(false);
            var order = FindWorkingOrder(orderId);

            if (request.Quantity.HasValue)
            {
                order.Quantity = request.Quantity.Value;
            }
            if (request.Price.HasValue)
            {
                order.Price = request.Price.Value;
            }
            if (request.TriggerPrice.HasValue)
            {
                order.TriggerPrice = request.TriggerPrice.Value;
            }
            if (!string.IsNullOrWhiteSpace(request.TimeInForce))
            {
                order.TimeInForce = request.TimeInForce;
            }

            return TradingResultDto.Success($"Ordre {orderId} modifié (stub bridge)", orderId);
        }

        public async Task<TradingResultDto> CancelOrderAsync(string orderId, CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedWriteLatencyMs, cancellationToken).ConfigureAwait(false);
            var order = FindWorkingOrder(orderId);
            _workingOrders.Remove(order);
            _cancelledOrderIds.Add(orderId);
            return TradingResultDto.Success($"Ordre {orderId} annulé (stub bridge)", orderId);
        }

        public async Task<TradingResultDto> ClosePositionAsync(
            string positionId,
            double? quantity,
            CancellationToken cancellationToken)
        {
            await DelayAsync(SimulatedWriteLatencyMs, cancellationToken).ConfigureAwait(false);
            var position = _positions.FirstOrDefault(
                candidate => string.Equals(candidate.PositionId, positionId, StringComparison.OrdinalIgnoreCase));
            if (position == null)
            {
                throw new GatewayNotFoundException($"Position inconnue : {positionId}.", new { positionId });
            }

            var requested = quantity ?? position.Quantity;
            if (requested <= 0)
            {
                throw new GatewayValidationException("quantity doit être un nombre > 0.", new { positionId, quantity });
            }
            if (requested > position.Quantity)
            {
                throw new GatewayValidationException(
                    $"Quantité {requested} supérieure à la position ouverte {position.Quantity}.",
                    new { positionId, requested, openQuantity = position.Quantity });
            }

            if (Math.Abs(requested - position.Quantity) < 0.00000001)
            {
                _positions.Remove(position);
            }
            else
            {
                position.Quantity = Round(position.Quantity - requested);
            }

            return TradingResultDto.Success($"Position {positionId} fermée ({requested}) (stub bridge)", positionId: positionId);
        }

        private SymbolDto FindSymbol(string symbolId, string? connectionId)
        {
            var symbol = _symbols.FirstOrDefault(candidate =>
                string.Equals(candidate.SymbolId, symbolId, StringComparison.OrdinalIgnoreCase));
            if (symbol == null)
            {
                throw new GatewayNotFoundException(
                    $"Instrument inconnu : {symbolId}.",
                    new { symbolId, connectionId });
            }
            return symbol;
        }

        private void EnsureAccountExists(string accountId)
        {
            var exists = _accounts.Any(account => string.Equals(account.AccountId, accountId, StringComparison.OrdinalIgnoreCase));
            if (!exists)
            {
                throw new GatewayNotFoundException($"Compte inconnu : {accountId}.", new { accountId });
            }
        }

        private OrderDto FindWorkingOrder(string orderId)
        {
            if (_cancelledOrderIds.Contains(orderId))
            {
                throw new GatewayInvalidStateException($"Ordre {orderId} déjà annulé.", new { orderId });
            }
            var order = _workingOrders.FirstOrDefault(
                candidate => string.Equals(candidate.OrderId, orderId, StringComparison.OrdinalIgnoreCase));
            if (order == null)
            {
                var inHistory = _ordersHistory.Any(
                    candidate => string.Equals(candidate.OrderId, orderId, StringComparison.OrdinalIgnoreCase));
                if (inHistory)
                {
                    throw new GatewayInvalidStateException(
                        $"Ordre {orderId} terminé : opération impossible.",
                        new { orderId });
                }
                throw new GatewayNotFoundException($"Ordre inconnu : {orderId}.", new { orderId });
            }
            return order;
        }

        private static bool Matches(string actual, string? expected) =>
            string.IsNullOrWhiteSpace(expected) || string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);

        private long TimeframeToMilliseconds(string timeframe)
        {
            switch ((timeframe ?? string.Empty).Trim().ToLowerInvariant())
            {
                case "1m":
                    return 60_000;
                case "5m":
                    return 300_000;
                case "15m":
                    return 900_000;
                case "30m":
                    return 1_800_000;
                case "1h":
                    return 3_600_000;
                case "2h":
                    return 7_200_000;
                case "4h":
                    return 14_400_000;
                case "1d":
                    return 86_400_000;
                case "1w":
                    return 604_800_000;
                default:
                    throw new GatewayValidationException(
                        $"Timeframe non supporté : « {timeframe} ».",
                        new { timeframe, supported = new[] { "1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w" } });
            }
        }

        private static double Round(double value) => Math.Round(value, 6, MidpointRounding.AwayFromZero);

        private static Task DelayAsync(int milliseconds, CancellationToken cancellationToken)
        {
            if (milliseconds <= 0)
            {
                return Task.CompletedTask;
            }
            return Task.Delay(milliseconds, cancellationToken);
        }
    }
}
