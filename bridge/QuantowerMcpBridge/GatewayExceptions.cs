using System;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Erreur métier du gateway, mappée en erreur HTTP JSON par HttpServer :
    /// { error: { code, message, details } } (plan §3).
    /// </summary>
    public class GatewayException : Exception
    {
        public GatewayException(string code, int statusCode, string message, object? details = null, Exception? inner = null)
            : base(message, inner)
        {
            Code = code;
            StatusCode = statusCode;
            Details = details;
        }

        public string Code { get; }

        public int StatusCode { get; }

        public object? Details { get; }
    }

    /// <summary>400 — payload ou paramètre invalide.</summary>
    public sealed class GatewayValidationException : GatewayException
    {
        public GatewayValidationException(string message, object? details = null)
            : base("VALIDATION_ERROR", 400, message, details)
        {
        }
    }

    /// <summary>401 — token absent ou incorrect.</summary>
    public sealed class GatewayUnauthorizedException : GatewayException
    {
        public GatewayUnauthorizedException(string message, object? details = null)
            : base("BRIDGE_UNAUTHORIZED", 401, message, details)
        {
        }
    }

    /// <summary>403 — requête interdite (trading désactivé, échange explicitement refusé…).</summary>
    public sealed class GatewayForbiddenException : GatewayException
    {
        public GatewayForbiddenException(string code, string message, object? details = null)
            : base(code, 403, message, details)
        {
        }
    }

    /// <summary>404 — entité inconnue (symbole, compte, ordre, position).</summary>
    public sealed class GatewayNotFoundException : GatewayException
    {
        public GatewayNotFoundException(string message, object? details = null)
            : base("NOT_FOUND", 404, message, details)
        {
        }
    }

    /// <summary>409 — état incompatible (double annulation, ordre terminé…).</summary>
    public sealed class GatewayInvalidStateException : GatewayException
    {
        public GatewayInvalidStateException(string message, object? details = null)
            : base("INVALID_STATE", 409, message, details)
        {
        }
    }

    /// <summary>500 — échec de la plateforme Quantower.</summary>
    public sealed class GatewayPlatformException : GatewayException
    {
        public GatewayPlatformException(string message, object? details = null, Exception? inner = null)
            : base("PLATFORM_ERROR", 500, message, details, inner)
        {
        }
    }

    /// <summary>504 — opération trop longue (file d'attente ou appel plateforme).</summary>
    public sealed class GatewayTimeoutException : GatewayException
    {
        public GatewayTimeoutException(string message, object? details = null)
            : base("TIMEOUT", 504, message, details)
        {
        }
    }

    /// <summary>501 — fonctionnalité non implémentée (ex. WebSocket /events en v1).</summary>
    public sealed class GatewayNotImplementedException : GatewayException
    {
        public GatewayNotImplementedException(string message, object? details = null)
            : base("NOT_IMPLEMENTED", 501, message, details)
        {
        }
    }
}
