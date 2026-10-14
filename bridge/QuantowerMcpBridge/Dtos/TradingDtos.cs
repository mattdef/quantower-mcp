using System;

namespace QuantowerMcpBridge.Dtos
{
    /// <summary>Corps de POST /orders (plan §3).</summary>
    public sealed class PlaceOrderRequestDto
    {
        public string AccountId { get; set; } = string.Empty;

        public string SymbolId { get; set; } = string.Empty;

        /// <summary>"buy" ou "sell".</summary>
        public string Side { get; set; } = "buy";

        /// <summary>market | limit | stop | stop_limit.</summary>
        public string OrderType { get; set; } = "market";

        public double Quantity { get; set; }

        public double? Price { get; set; }

        public double? TriggerPrice { get; set; }

        /// <summary>day | gtc | gtd | ioc | fok (optionnel : défaut plateforme).</summary>
        public string? TimeInForce { get; set; }

        public string? ConnectionId { get; set; }

        public ProtectionDto? StopLoss { get; set; }

        public ProtectionDto? TakeProfit { get; set; }

        public string? Comment { get; set; }
    }

    /// <summary>SL/TP : prix absolu ou offset en ticks (SlTpHolder.CreateSL/CreateTP côté Quantower).</summary>
    public sealed class ProtectionDto
    {
        public double? Price { get; set; }

        public int? OffsetTicks { get; set; }
    }

    /// <summary>Corps de PATCH /orders/{id}.</summary>
    public sealed class ModifyOrderRequestDto
    {
        public double? Quantity { get; set; }

        public double? Price { get; set; }

        public double? TriggerPrice { get; set; }

        public string? TimeInForce { get; set; }
    }

    /// <summary>Corps de POST /positions/{id}/close (quantity omise = fermeture totale).</summary>
    public sealed class ClosePositionRequestDto
    {
        public double? Quantity { get; set; }
    }

    /// <summary>Mapping JSON de TradingOperationResult (Status + Message).</summary>
    public sealed class TradingResultDto
    {
        /// <summary>"success" ou "failure".</summary>
        public string Status { get; set; } = "success";

        public string? Message { get; set; }

        public string? OrderId { get; set; }

        public string? PositionId { get; set; }

        public static TradingResultDto Success(string? message, string? orderId = null, string? positionId = null) =>
            new TradingResultDto
            {
                Status = "success",
                Message = message,
                OrderId = orderId,
                PositionId = positionId,
            };

        public static TradingResultDto Failure(string? message, string? orderId = null, string? positionId = null) =>
            new TradingResultDto
            {
                Status = "failure",
                Message = message,
                OrderId = orderId,
                PositionId = positionId,
            };
    }
}
