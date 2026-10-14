using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using QuantowerMcpBridge.Dtos;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Serveur HTTP JSON local du bridge (plan §3) :
    /// - bind loopback uniquement + vérification de l'IP distante ;
    /// - authentification Bearer obligatoire sur toutes les routes (y compris /health) ;
    /// - validation stricte des paramètres et payloads ;
    /// - erreurs standardisées { error: { code, message, details } } ;
    /// - journal d'audit des opérations de trading.
    ///
    /// WebSocket /events : non implémenté en v1 (phase 4+/v2, plan §9) -> 501 NOT_IMPLEMENTED.
    /// </summary>
    public sealed class HttpServer : IDisposable
    {
        private static readonly string[] SupportedTimeframes = { "1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w" };

        /// <summary>
        /// Variantes loopback toujours enregistrées comme préfixes HttpListener : HTTP.SYS compare aussi
        /// l'en-tête Host au préfixe, donc un préfixe « localhost » répondrait 400 « Invalid Hostname »
        /// aux clients utilisant http://127.0.0.1/… (et inversement).
        /// </summary>
        private static readonly string[] LoopbackHostAliases = { "localhost", "127.0.0.1", "[::1]" };

        private readonly BridgeConfig _config;
        private readonly ICoreGateway _gateway;
        private readonly AuditLog _audit;
        private readonly TradingGuard _guard;
        private readonly ILogSink _log;
        private readonly HttpListener _listener = new HttpListener();
        private readonly CancellationTokenSource _cancellation = new CancellationTokenSource();

        public HttpServer(
            BridgeConfig config,
            ICoreGateway gateway,
            AuditLog audit,
            TradingGuard guard,
            ILogSink log)
        {
            _config = config;
            _gateway = gateway;
            _audit = audit;
            _guard = guard;
            _log = log;
        }

        /// <summary>URL de base (ex. http://localhost:8765).</summary>
        public string BaseUrl => string.Format(CultureInfo.InvariantCulture, "http://{0}:{1}", _config.Host, _config.Port);

        public void Start()
        {
            var prefixes = BuildPrefixes();
            foreach (var prefix in prefixes)
            {
                _listener.Prefixes.Add(prefix);
            }

            try
            {
                _listener.Start();
            }
            catch (HttpListenerException exception)
            {
                throw new GatewayPlatformException(
                    string.Format(
                        CultureInfo.InvariantCulture,
                        "Impossible d'écouter sur {0} : {1}. Vérifiez que le port est libre ; en cas d'accès refusé, " +
                        "ajoutez une réservation URL HTTP.SYS pour chaque préfixe (ex. netsh http add urlacl " +
                        "url=http://localhost:{2}/ user=%USERNAME%, puis idem pour les autres préfixes) puis relancez Quantower.",
                        string.Join(", ", prefixes),
                        exception.Message,
                        _config.Port),
                    new { port = _config.Port, prefixes },
                    exception);
            }

            _ = Task.Run(() => AcceptLoopAsync(_cancellation.Token));
            _log.Info(
                $"Bridge HTTP à l'écoute sur {string.Join(", ", prefixes)} (trading={(_config.TradingEnabled ? "activé" : "désactivé")})");
        }

        /// <summary>
        /// Préfixes HTTP.SYS à enregistrer : les variantes loopback (localhost, 127.0.0.1, [::1]) plus
        /// l'hôte configuré s'il diffère. La sécurité réseau reste portée par <see cref="IsLoopback"/>
        /// (toute IP distante est rejetée en 403, quel que soit le préfixe).
        /// </summary>
        private List<string> BuildPrefixes()
        {
            var hosts = new List<string>(LoopbackHostAliases);
            if (!hosts.Exists(host => string.Equals(host, _config.Host, StringComparison.OrdinalIgnoreCase)))
            {
                hosts.Add(_config.Host);
            }

            var prefixes = new List<string>(hosts.Count);
            foreach (var host in hosts)
            {
                prefixes.Add(string.Format(CultureInfo.InvariantCulture, "http://{0}:{1}/", host, _config.Port));
            }
            return prefixes;
        }

        public void Dispose()
        {
            _cancellation.Cancel();
            try
            {
                _listener.Stop();
                _listener.Close();
            }
            catch (Exception)
            {
                // Arrêt best-effort : le processus Quantower peut se terminer de toute façon.
            }
            _cancellation.Dispose();
            _log.Info("Bridge HTTP arrêté.");
        }

        // ------------------------------------------------------------------ Boucle

        private async Task AcceptLoopAsync(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                HttpListenerContext context;
                try
                {
                    context = await _listener.GetContextAsync().ConfigureAwait(false);
                }
                catch (Exception)
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        return;
                    }
                    continue;
                }

                // Le traitement se fait hors du thread d'acceptation : le serveur ne se bloque jamais.
                _ = Task.Run(() => HandleAsync(context), CancellationToken.None);
            }
        }

        private async Task HandleAsync(HttpListenerContext context)
        {
            var request = context.Request;
            try
            {
                context.Response.Headers["Cache-Control"] = "no-store";

                if (!IsLoopback(request))
                {
                    await WriteJsonAsync(
                            context,
                            403,
                            ErrorBody(BridgeErrorCodes.Forbidden, "Le bridge n'accepte que les connexions locales (loopback)."))
                        .ConfigureAwait(false);
                    return;
                }

                if (!IsAuthorized(request))
                {
                    await WriteJsonAsync(
                            context,
                            401,
                            ErrorBody(BridgeErrorCodes.BridgeUnauthorized, "Token absent ou invalide."))
                        .ConfigureAwait(false);
                    return;
                }

                var segments = ParsePathSegments(request);
                var method = (request.HttpMethod ?? "GET").ToUpperInvariant();
                var (status, payload) = await RouteAsync(method, segments, request, _cancellation.Token)
                    .ConfigureAwait(false);
                await WriteJsonAsync(context, status, payload).ConfigureAwait(false);
            }
            catch (GatewayException gatewayError)
            {
                await WriteJsonAsync(
                        context,
                        gatewayError.StatusCode,
                        ErrorBody(gatewayError.Code, gatewayError.Message, gatewayError.Details))
                    .ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                _log.Error("Erreur non gérée pendant le traitement de la requête", exception);
                await WriteJsonAsync(
                        context,
                        500,
                        ErrorBody(
                            BridgeErrorCodes.PlatformError,
                            "Erreur interne du bridge.",
                            new { detail = Truncate(exception.Message, 300) }))
                    .ConfigureAwait(false);
            }
            finally
            {
                try
                {
                    context.Response.Close();
                }
                catch (Exception)
                {
                    // Le client a pu fermer la connexion : rien à faire.
                }
            }
        }

        // ------------------------------------------------------------------ Routage

        private async Task<(int Status, object? Payload)> RouteAsync(
            string method,
            List<string> path,
            HttpListenerRequest request,
            CancellationToken cancellationToken)
        {
            if (method == "GET" && Matches(path, "health"))
            {
                var health = await _gateway.GetHealthAsync(cancellationToken).ConfigureAwait(false);
                // Les plafonds et le flag trading reflètent la configuration réelle du bridge.
                health.TradingEnabled = _config.TradingEnabled;
                health.Caps = new CapsDto
                {
                    MaxOrderQuantity = _config.MaxOrderQuantity,
                    MaxNotional = _config.MaxNotional,
                    DenyMarketOrders = _config.DenyMarketOrders,
                };
                return (200, health);
            }

            if (method == "GET" && Matches(path, "connections"))
            {
                return (200, await _gateway.GetConnectionsAsync(cancellationToken).ConfigureAwait(false));
            }

            if (method == "GET" && Matches(path, "accounts"))
            {
                var connectionId = QueryString(request, "connectionId");
                return (200, await _gateway.GetAccountsAsync(connectionId, cancellationToken).ConfigureAwait(false));
            }

            if (method == "GET" && Matches(path, "symbols"))
            {
                var query = QueryString(request, "q");
                var connectionId = QueryString(request, "connectionId");
                var limit = QueryInt(request, "limit", 50, 1, 500);
                return (200, await _gateway
                    .SearchSymbolsAsync(query, connectionId, limit, cancellationToken)
                    .ConfigureAwait(false));
            }

            if (method == "GET" && IsSymbolRoute(path, "quote"))
            {
                var symbolId = path[1];
                var connectionId = QueryString(request, "connectionId");
                return (200, await _gateway.GetQuoteAsync(symbolId, connectionId, cancellationToken).ConfigureAwait(false));
            }

            if (method == "GET" && IsSymbolRoute(path, "history"))
            {
                var symbolId = path[1];
                var timeframe = QueryString(request, "timeframe") ?? "1h";
                if (Array.IndexOf(SupportedTimeframes, timeframe.ToLowerInvariant()) < 0)
                {
                    throw new GatewayValidationException(
                        $"Timeframe non supporté : « {timeframe} ».",
                        new { timeframe, supported = SupportedTimeframes });
                }

                var from = QueryDate(request, "from");
                var to = QueryDate(request, "to");
                var limit = QueryInt(request, "limit", 100, 1, _config.MaxHistoryBars);
                var connectionId = QueryString(request, "connectionId");
                return (200, await _gateway
                    .GetHistoryAsync(symbolId, timeframe, from, to, limit, connectionId, cancellationToken)
                    .ConfigureAwait(false));
            }

            if (method == "GET" && IsSymbolRoute(path, "dom"))
            {
                var symbolId = path[1];
                var depth = QueryInt(request, "depth", 10, 1, 50);
                var connectionId = QueryString(request, "connectionId");
                return (200, await _gateway.GetDomAsync(symbolId, depth, connectionId, cancellationToken).ConfigureAwait(false));
            }

            if (method == "GET" && Matches(path, "positions"))
            {
                var connectionId = QueryString(request, "connectionId");
                var accountId = QueryString(request, "accountId");
                return (200, await _gateway.GetPositionsAsync(connectionId, accountId, cancellationToken).ConfigureAwait(false));
            }

            if (method == "GET" && Matches(path, "orders"))
            {
                var connectionId = QueryString(request, "connectionId");
                var accountId = QueryString(request, "accountId");
                return (200, await _gateway.GetOrdersAsync(connectionId, accountId, cancellationToken).ConfigureAwait(false));
            }

            if (method == "GET" && Matches(path, "orders", "history"))
            {
                var from = QueryDate(request, "from");
                var to = QueryDate(request, "to");
                var limit = QueryInt(request, "limit", 100, 1, 1000);
                var connectionId = QueryString(request, "connectionId");
                var accountId = QueryString(request, "accountId");
                return (200, await _gateway
                    .GetOrdersHistoryAsync(from, to, limit, connectionId, accountId, cancellationToken)
                    .ConfigureAwait(false));
            }

            if (method == "GET" && Matches(path, "trades"))
            {
                var connectionId = QueryString(request, "connectionId");
                var accountId = QueryString(request, "accountId");
                var limit = QueryInt(request, "limit", 100, 1, 1000);
                return (200, await _gateway
                    .GetTradesAsync(connectionId, accountId, limit, cancellationToken)
                    .ConfigureAwait(false));
            }

            if (method == "POST" && Matches(path, "orders"))
            {
                return await PlaceOrderAsync(request, cancellationToken).ConfigureAwait(false);
            }

            if (method == "PATCH" && path.Count == 2 && path[0] == "orders")
            {
                return await ModifyOrderAsync(path[1], request, cancellationToken).ConfigureAwait(false);
            }

            if (method == "DELETE" && path.Count == 2 && path[0] == "orders")
            {
                return await CancelOrderAsync(path[1], request, cancellationToken).ConfigureAwait(false);
            }

            if (method == "POST" && path.Count == 3 && path[0] == "positions" && path[2] == "close")
            {
                return await ClosePositionAsync(path[1], request, cancellationToken).ConfigureAwait(false);
            }

            if (Matches(path, "events"))
            {
                throw new GatewayNotImplementedException(
                    "Le WebSocket /events n'est pas implémenté en v1 (prévu en phase 4+/v2, plan §9).");
            }

            throw new GatewayNotFoundException(
                $"Route inconnue : {method} /{string.Join("/", path)}.",
                new { method, path = "/" + string.Join("/", path) });
        }

        // ------------------------------------------------------------------ Écriture

        private async Task<(int Status, object? Payload)> PlaceOrderAsync(
            HttpListenerRequest request,
            CancellationToken cancellationToken)
        {
            _guard.EnsureTradingEnabled();
            var body = await ReadBodyAsync<PlaceOrderRequestDto>(request).ConfigureAwait(false)
                ?? throw new GatewayValidationException("Corps JSON obligatoire pour POST /orders.");
            ValidatePlaceOrder(body);
            await _guard.ValidateOrderAsync(body, _gateway, cancellationToken).ConfigureAwait(false);

            var result = await _gateway.PlaceOrderAsync(body, cancellationToken).ConfigureAwait(false);
            _audit.Write("place_order", body, result, ClientIp(request));
            return (200, result);
        }

        private async Task<(int Status, object? Payload)> ModifyOrderAsync(
            string orderId,
            HttpListenerRequest request,
            CancellationToken cancellationToken)
        {
            _guard.EnsureTradingEnabled();
            var body = await ReadBodyAsync<ModifyOrderRequestDto>(request).ConfigureAwait(false)
                ?? throw new GatewayValidationException("Corps JSON obligatoire pour PATCH /orders/{id}.");

            if (!body.Quantity.HasValue && !body.Price.HasValue && !body.TriggerPrice.HasValue &&
                string.IsNullOrWhiteSpace(body.TimeInForce))
            {
                throw new GatewayValidationException(
                    "Aucune modification fournie : renseignez quantity, price, triggerPrice ou timeInForce.");
            }
            if (body.Quantity.HasValue && body.Quantity.Value <= 0)
            {
                throw new GatewayValidationException("quantity doit être un nombre > 0.", new { quantity = body.Quantity });
            }

            // Même plafond que le placement : une modification ne doit pas le contourner (plan §4.5).
            _guard.ValidateModifyOrder(body);

            var result = await _gateway.ModifyOrderAsync(orderId, body, cancellationToken).ConfigureAwait(false);
            _audit.Write("modify_order", new { orderId, changes = body }, result, ClientIp(request));
            return (200, result);
        }

        private async Task<(int Status, object? Payload)> CancelOrderAsync(
            string orderId,
            HttpListenerRequest request,
            CancellationToken cancellationToken)
        {
            _guard.EnsureTradingEnabled();
            var result = await _gateway.CancelOrderAsync(orderId, cancellationToken).ConfigureAwait(false);
            _audit.Write("cancel_order", new { orderId }, result, ClientIp(request));
            return (200, result);
        }

        private async Task<(int Status, object? Payload)> ClosePositionAsync(
            string positionId,
            HttpListenerRequest request,
            CancellationToken cancellationToken)
        {
            _guard.EnsureTradingEnabled();
            var body = await ReadBodyAsync<ClosePositionRequestDto>(request).ConfigureAwait(false)
                ?? new ClosePositionRequestDto();

            if (body.Quantity.HasValue && body.Quantity.Value <= 0)
            {
                throw new GatewayValidationException("quantity doit être un nombre > 0.", new { quantity = body.Quantity });
            }

            var result = await _gateway
                .ClosePositionAsync(positionId, body.Quantity, cancellationToken)
                .ConfigureAwait(false);
            _audit.Write("close_position", new { positionId, quantity = body.Quantity }, result, ClientIp(request));
            return (200, result);
        }

        // ------------------------------------------------------------------ Validation

        private static void ValidatePlaceOrder(PlaceOrderRequestDto body)
        {
            RequireNonEmpty(body.AccountId, "accountId");
            RequireNonEmpty(body.SymbolId, "symbolId");

            var side = RequireNonEmpty(body.Side, "side").ToLowerInvariant();
            if (side != "buy" && side != "sell")
            {
                throw new GatewayValidationException($"side invalide : « {body.Side} » (attendu buy|sell).");
            }

            var orderType = RequireNonEmpty(body.OrderType, "orderType").ToLowerInvariant();
            if (orderType != "market" && orderType != "limit" && orderType != "stop" && orderType != "stop_limit")
            {
                throw new GatewayValidationException(
                    $"orderType invalide : « {body.OrderType} » (attendu market|limit|stop|stop_limit).");
            }

            // Normalisation : le gateway et l'audit ne manipulent que ces formes canoniques.
            body.Side = side;
            body.OrderType = orderType;
            body.TimeInForce = string.IsNullOrWhiteSpace(body.TimeInForce) ? null : body.TimeInForce!.Trim().ToLowerInvariant();

            if (body.Quantity <= 0 || double.IsNaN(body.Quantity) || double.IsInfinity(body.Quantity))
            {
                throw new GatewayValidationException("quantity doit être un nombre fini > 0.", new { quantity = body.Quantity });
            }

            if ((orderType == "limit" || orderType == "stop_limit") && !body.Price.HasValue)
            {
                throw new GatewayValidationException($"orderType « {orderType} » exige un champ price.");
            }
            if ((orderType == "stop" || orderType == "stop_limit") && !body.TriggerPrice.HasValue)
            {
                throw new GatewayValidationException($"orderType « {orderType} » exige un champ triggerPrice.");
            }
            if (body.Price.HasValue && body.Price.Value <= 0)
            {
                throw new GatewayValidationException("price doit être > 0.", new { price = body.Price });
            }
            if (body.TriggerPrice.HasValue && body.TriggerPrice.Value <= 0)
            {
                throw new GatewayValidationException("triggerPrice doit être > 0.", new { triggerPrice = body.TriggerPrice });
            }

            ValidateProtection(body.StopLoss, "stopLoss");
            ValidateProtection(body.TakeProfit, "takeProfit");
        }

        private static void ValidateProtection(ProtectionDto? protection, string fieldName)
        {
            if (protection == null)
            {
                return;
            }
            if (!protection.Price.HasValue && !protection.OffsetTicks.HasValue)
            {
                throw new GatewayValidationException($"{fieldName} exige price ou offsetTicks.");
            }
            if (protection.Price.HasValue && protection.Price.Value <= 0)
            {
                throw new GatewayValidationException($"{fieldName}.price doit être > 0.");
            }
        }

        private static string RequireNonEmpty(string? value, string fieldName)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new GatewayValidationException($"Champ obligatoire manquant : {fieldName}.", new { field = fieldName });
            }
            return value!;
        }

        // ------------------------------------------------------------------ HTTP helpers

        private bool IsAuthorized(HttpListenerRequest request)
        {
            var header = request.Headers["Authorization"];
            if (string.IsNullOrWhiteSpace(header))
            {
                return false;
            }
            const string prefix = "Bearer ";
            if (!header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
            return FixedTimeEquals(header.Substring(prefix.Length).Trim(), _config.Token);
        }

        private static bool IsLoopback(HttpListenerRequest request)
        {
            var remote = request.RemoteEndPoint;
            return remote != null && IPAddress.IsLoopback(remote.Address);
        }

        private static string? ClientIp(HttpListenerRequest request) => request.RemoteEndPoint?.Address.ToString();

        /// <summary>Comparaison de chaînes à temps constant (évite les attaques temporelles sur le token).</summary>
        private static bool FixedTimeEquals(string left, string right)
        {
            var leftBytes = Encoding.UTF8.GetBytes(left);
            var rightBytes = Encoding.UTF8.GetBytes(right);
            var difference = leftBytes.Length ^ rightBytes.Length;
            for (var index = 0; index < leftBytes.Length && index < rightBytes.Length; index += 1)
            {
                difference |= leftBytes[index] ^ rightBytes[index];
            }
            return difference == 0;
        }

        private static List<string> ParsePathSegments(HttpListenerRequest request)
        {
            var rawUrl = request.RawUrl ?? "/";
            var questionMark = rawUrl.IndexOf('?');
            var rawPath = questionMark >= 0 ? rawUrl.Substring(0, questionMark) : rawUrl;
            var segments = new List<string>();
            foreach (var segment in rawPath.Split('/'))
            {
                if (segment.Length == 0)
                {
                    continue;
                }
                segments.Add(Uri.UnescapeDataString(segment));
            }
            return segments;
        }

        private static bool Matches(List<string> path, params string[] expected)
        {
            if (path.Count != expected.Length)
            {
                return false;
            }
            for (var index = 0; index < expected.Length; index += 1)
            {
                if (!string.Equals(path[index], expected[index], StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }
            return true;
        }

        private static bool IsSymbolRoute(List<string> path, string subRoute)
        {
            return path.Count == 3 &&
                   string.Equals(path[0], "symbols", StringComparison.OrdinalIgnoreCase) &&
                   string.Equals(path[2], subRoute, StringComparison.OrdinalIgnoreCase) &&
                   path[1].Length > 0;
        }

        private static string? QueryString(HttpListenerRequest request, string name)
        {
            var value = request.QueryString[name];
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }

        private static int QueryInt(HttpListenerRequest request, string name, int defaultValue, int min, int max)
        {
            var raw = QueryString(request, name);
            if (raw == null)
            {
                return defaultValue;
            }
            if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value))
            {
                throw new GatewayValidationException(
                    $"Paramètre « {name} » invalide : « {raw} » (entier attendu).",
                    new { parameter = name, value = raw });
            }
            if (value < min || value > max)
            {
                throw new GatewayValidationException(
                    $"Paramètre « {name} » hors plage [{min}, {max}] : {value}.",
                    new { parameter = name, value, min, max });
            }
            return value;
        }

        private static DateTime? QueryDate(HttpListenerRequest request, string name)
        {
            var raw = QueryString(request, name);
            if (raw == null)
            {
                return null;
            }
            if (!DateTime.TryParse(
                    raw,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal,
                    out var value))
            {
                throw new GatewayValidationException(
                    $"Paramètre « {name} » invalide : « {raw} » (date ISO 8601 attendue).",
                    new { parameter = name, value = raw });
            }
            return DateTime.SpecifyKind(value, DateTimeKind.Utc);
        }

        private static async Task<T?> ReadBodyAsync<T>(HttpListenerRequest request) where T : class
        {
            if (!request.HasEntityBody)
            {
                return null;
            }
            using (var reader = new StreamReader(request.InputStream, request.ContentEncoding ?? Encoding.UTF8))
            {
                var raw = await reader.ReadToEndAsync().ConfigureAwait(false);
                if (string.IsNullOrWhiteSpace(raw))
                {
                    return null;
                }
                try
                {
                    return Json.Deserialize<T>(raw);
                }
                catch (Exception exception)
                {
                    throw new GatewayValidationException(
                        "Corps JSON invalide.",
                        new { detail = Truncate(exception.Message, 200) });
                }
            }
        }

        private static async Task WriteJsonAsync(HttpListenerContext context, int statusCode, object? payload)
        {
            var response = context.Response;
            response.StatusCode = statusCode;
            response.ContentType = "application/json; charset=utf-8";
            var bytes = Encoding.UTF8.GetBytes(Json.Serialize(payload));
            response.ContentLength64 = bytes.Length;
            try
            {
                await response.OutputStream.WriteAsync(bytes, 0, bytes.Length).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Client déconnecté avant la fin de l'écriture : rien à signaler.
            }
        }

        private static ErrorBodyDto ErrorBody(string code, string message, object? details = null) =>
            new ErrorBodyDto
            {
                Error = new ErrorDto { Code = code, Message = message, Details = details },
            };

        private static string Truncate(string value, int maxLength) =>
            value.Length <= maxLength ? value : value.Substring(0, maxLength) + "…";
    }
}
