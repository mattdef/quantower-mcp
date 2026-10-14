namespace QuantowerMcpBridge.Dtos
{
    /// <summary>Enveloppe d'erreur du contrat : { error: { code, message, details } } (plan §3).</summary>
    public sealed class ErrorBodyDto
    {
        public ErrorDto Error { get; set; } = new ErrorDto();
    }

    public sealed class ErrorDto
    {
        public string Code { get; set; } = "PLATFORM_ERROR";

        public string Message { get; set; } = string.Empty;

        public object? Details { get; set; }
    }

    /// <summary>Codes d'erreur du bridge (repris côté serveur MCP par src/errors.ts).</summary>
    public static class BridgeErrorCodes
    {
        public const string BridgeUnauthorized = "BRIDGE_UNAUTHORIZED";
        public const string Forbidden = "FORBIDDEN";
        public const string NotFound = "NOT_FOUND";
        public const string ValidationError = "VALIDATION_ERROR";
        public const string InvalidState = "INVALID_STATE";
        public const string TradingDisabled = "TRADING_DISABLED";
        public const string TradingLimitExceeded = "TRADING_LIMIT_EXCEEDED";
        public const string MarketOrdersDenied = "MARKET_ORDERS_DENIED";
        public const string Timeout = "TIMEOUT";
        public const string PlatformError = "PLATFORM_ERROR";
        public const string NotImplemented = "NOT_IMPLEMENTED";
    }
}
