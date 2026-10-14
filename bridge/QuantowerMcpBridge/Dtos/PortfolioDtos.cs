using System;

namespace QuantowerMcpBridge.Dtos
{
    public sealed class PositionDto
    {
        public string PositionId { get; set; } = string.Empty;

        public string ConnectionId { get; set; } = string.Empty;

        public string AccountId { get; set; } = string.Empty;

        public string SymbolId { get; set; } = string.Empty;

        /// <summary>"buy" ou "sell".</summary>
        public string Side { get; set; } = "buy";

        public double Quantity { get; set; }

        public double? OpenPrice { get; set; }

        public double? CurrentPrice { get; set; }

        public double? NetPnl { get; set; }

        public double? GrossPnl { get; set; }

        public DateTime? OpenTimeUtc { get; set; }
    }

    public sealed class OrderDto
    {
        public string OrderId { get; set; } = string.Empty;

        public string ConnectionId { get; set; } = string.Empty;

        public string AccountId { get; set; } = string.Empty;

        public string SymbolId { get; set; } = string.Empty;

        public string Side { get; set; } = "buy";

        /// <summary>market | limit | stop | stop_limit.</summary>
        public string OrderType { get; set; } = "limit";

        /// <summary>working | filled | cancelled | rejected | partially_filled.</summary>
        public string Status { get; set; } = "working";

        public double Quantity { get; set; }

        public double? FilledQuantity { get; set; }

        public double? Price { get; set; }

        public double? TriggerPrice { get; set; }

        public string? TimeInForce { get; set; }

        public DateTime? CreatedAtUtc { get; set; }

        public string? Comment { get; set; }
    }

    public sealed class TradeDto
    {
        public string TradeId { get; set; } = string.Empty;

        public string ConnectionId { get; set; } = string.Empty;

        public string AccountId { get; set; } = string.Empty;

        public string SymbolId { get; set; } = string.Empty;

        public string Side { get; set; } = "buy";

        public double Quantity { get; set; }

        public double Price { get; set; }

        public DateTime TimestampUtc { get; set; }

        public double? Fee { get; set; }

        public string? OrderId { get; set; }
    }
}
