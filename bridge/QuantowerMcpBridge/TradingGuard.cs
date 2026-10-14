using System;
using System.Threading;
using System.Threading.Tasks;
using QuantowerMcpBridge.Dtos;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Contrôles serveur des opérations de trading (plan §6 Phase 3.3) :
    /// plafonds quantité/notionnel, interdiction des Market, et refus global si le
    /// trading est désactivé côté bridge (défense en profondeur après le garde-fou MCP).
    /// </summary>
    public sealed class TradingGuard
    {
        private readonly BridgeConfig _config;

        public TradingGuard(BridgeConfig config)
        {
            _config = config;
        }

        public void EnsureTradingEnabled()
        {
            if (!_config.TradingEnabled)
            {
                throw new GatewayForbiddenException(
                    BridgeErrorCodes.TradingDisabled,
                    "Les opérations d'écriture sont désactivées sur le bridge (QUANTOWER_BRIDGE_TRADING_ENABLED=false).");
            }
        }

        public async Task ValidateOrderAsync(
            PlaceOrderRequestDto request,
            ICoreGateway gateway,
            CancellationToken cancellationToken)
        {
            if (_config.DenyMarketOrders && IsMarket(request.OrderType))
            {
                throw new GatewayForbiddenException(
                    BridgeErrorCodes.MarketOrdersDenied,
                    "Les ordres Market sont interdits sur le bridge (QUANTOWER_BRIDGE_DENY_MARKET_ORDERS=true).",
                    new { orderType = request.OrderType });
            }

            EnsureQuantityWithinLimit(request.Quantity);

            if (_config.MaxNotional <= 0)
            {
                return;
            }

            var referencePrice = request.Price ?? request.TriggerPrice;
            if (!referencePrice.HasValue)
            {
                // Ordre Market : le prix de référence vient du carnet (bid/ask).
                var quote = await gateway.GetQuoteAsync(request.SymbolId, request.ConnectionId, cancellationToken)
                    .ConfigureAwait(false);
                referencePrice = IsBuy(request.Side) ? quote.Ask ?? quote.Last : quote.Bid ?? quote.Last;
            }

            if (!referencePrice.HasValue)
            {
                throw new GatewayException(
                    BridgeErrorCodes.TradingLimitExceeded,
                    400,
                    "Impossible de vérifier le plafond notionnel : aucun prix de référence disponible.",
                    new { symbolId = request.SymbolId, orderType = request.OrderType });
            }

            var notional = request.Quantity * referencePrice.Value;
            if (notional > _config.MaxNotional)
            {
                throw new GatewayException(
                    BridgeErrorCodes.TradingLimitExceeded,
                    400,
                    $"Notionnel estimé {notional:0.##} supérieur au plafond du bridge ({_config.MaxNotional}).",
                    new
                    {
                        quantity = request.Quantity,
                        referencePrice = referencePrice.Value,
                        estimatedNotional = notional,
                        maxNotional = _config.MaxNotional,
                    });
            }
        }

        /// <summary>
        /// Contrôle du PATCH /orders/{id} : une modification de quantité ne doit pas contourner
        /// le plafond appliqué au placement (plan §4.5).
        /// </summary>
        public void ValidateModifyOrder(ModifyOrderRequestDto request)
        {
            if (request.Quantity.HasValue)
            {
                EnsureQuantityWithinLimit(request.Quantity.Value);
            }
        }

        private void EnsureQuantityWithinLimit(double quantity)
        {
            if (_config.MaxOrderQuantity > 0 && quantity > _config.MaxOrderQuantity)
            {
                throw new GatewayException(
                    BridgeErrorCodes.TradingLimitExceeded,
                    400,
                    $"Quantité {quantity} supérieure au plafond du bridge ({_config.MaxOrderQuantity}).",
                    new { quantity, maxOrderQuantity = _config.MaxOrderQuantity });
            }
        }

        private static bool IsMarket(string? orderType) =>
            string.Equals(orderType, "market", StringComparison.OrdinalIgnoreCase);

        private static bool IsBuy(string? side) =>
            string.Equals(side, "buy", StringComparison.OrdinalIgnoreCase);
    }
}
