using System;
using System.Collections.Generic;

namespace QuantowerMcpBridge.Dtos
{
    /// <summary>Réponse de GET /health (plan §3).</summary>
    public sealed class HealthDto
    {
        public string Status { get; set; } = "ok";

        public string BridgeVersion { get; set; } = "0.0.0";

        public string? PlatformVersion { get; set; }

        public DateTime StartedAtUtc { get; set; }

        public double UptimeSeconds { get; set; }

        public bool TradingEnabled { get; set; }

        public CapsDto Caps { get; set; } = new CapsDto();

        public int ConnectionCount { get; set; }
    }

    /// <summary>Plafonds actifs du bridge (miroir de la config côté MCP).</summary>
    public sealed class CapsDto
    {
        public double MaxOrderQuantity { get; set; }

        public double MaxNotional { get; set; }

        public bool DenyMarketOrders { get; set; }
    }

    public sealed class ConnectionDto
    {
        public string ConnectionId { get; set; } = string.Empty;

        public string Name { get; set; } = string.Empty;

        public string Status { get; set; } = string.Empty;

        public string? Type { get; set; }
    }

    public sealed class AccountDto
    {
        public string AccountId { get; set; } = string.Empty;

        public string ConnectionId { get; set; } = string.Empty;

        public string Name { get; set; } = string.Empty;

        public double? Balance { get; set; }

        public double? Equity { get; set; }

        public string? Currency { get; set; }

        public double? NetPnl { get; set; }

        public double? BuyingPower { get; set; }
    }

    public sealed class SymbolDto
    {
        public string SymbolId { get; set; } = string.Empty;

        public string ConnectionId { get; set; } = string.Empty;

        public string Name { get; set; } = string.Empty;

        public string? Description { get; set; }

        public double? TickSize { get; set; }

        public double? LotStep { get; set; }

        public double? MinLot { get; set; }

        public double? MaxLot { get; set; }

        public string? BaseAsset { get; set; }

        public string? QuoteAsset { get; set; }
    }

    public sealed class QuoteDto
    {
        public string SymbolId { get; set; } = string.Empty;

        public string ConnectionId { get; set; } = string.Empty;

        public double? Bid { get; set; }

        public double? Ask { get; set; }

        public double? Last { get; set; }

        public double? Volume { get; set; }

        public double? Open { get; set; }

        public double? High { get; set; }

        public double? Low { get; set; }

        public double? PreviousClose { get; set; }

        public DateTime TimestampUtc { get; set; }
    }

    public sealed class BarDto
    {
        public DateTime TimestampUtc { get; set; }

        public double Open { get; set; }

        public double High { get; set; }

        public double Low { get; set; }

        public double Close { get; set; }

        public double Volume { get; set; }
    }

    public sealed class HistoryResponseDto
    {
        public string SymbolId { get; set; } = string.Empty;

        public string? ConnectionId { get; set; }

        public string Timeframe { get; set; } = string.Empty;

        public List<BarDto> Bars { get; set; } = new List<BarDto>();
    }

    public sealed class DomLevelDto
    {
        public double Price { get; set; }

        public double Size { get; set; }
    }

    public sealed class DomResponseDto
    {
        public string SymbolId { get; set; } = string.Empty;

        public string? ConnectionId { get; set; }

        public DateTime TimestampUtc { get; set; }

        public List<DomLevelDto> Bids { get; set; } = new List<DomLevelDto>();

        public List<DomLevelDto> Asks { get; set; } = new List<DomLevelDto>();
    }
}
