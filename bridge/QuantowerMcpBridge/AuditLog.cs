using System;
using System.IO;
using System.Text.Json.Nodes;
using QuantowerMcpBridge.Dtos;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Journal d'audit des opérations de trading (plan §3 et §6 Phase 3.2) :
    /// une ligne JSON par opération, dans %LOCALAPPDATA%\quantower-mcp\audit.log.
    /// </summary>
    public sealed class AuditLog
    {
        private readonly string _path;
        private readonly ILogSink _log;
        private readonly object _gate = new object();

        public AuditLog(string path, ILogSink log)
        {
            _path = path;
            _log = log;
        }

        public string Path => _path;

        public void Write(string action, object? payload, TradingResultDto? result, string? clientIp)
        {
            var entry = new AuditEntry
            {
                TimestampUtc = DateTime.UtcNow,
                Action = action,
                ClientIp = clientIp,
                Payload = ToNode(payload),
                Result = ToNode(result),
            };

            try
            {
                var line = Json.Serialize(entry);
                lock (_gate)
                {
                    var directory = System.IO.Path.GetDirectoryName(_path);
                    if (!string.IsNullOrEmpty(directory))
                    {
                        Directory.CreateDirectory(directory);
                    }
                    File.AppendAllText(_path, line + Environment.NewLine);
                }
            }
            catch (Exception exception)
            {
                // Un échec d'écriture d'audit ne doit jamais faire échouer l'opération de trading.
                _log.Error($"Impossible d'écrire l'audit « {action} » dans {_path}", exception);
            }
        }

        private static JsonNode? ToNode(object? value) =>
            value == null ? null : JsonNode.Parse(Json.Serialize(value));

        private sealed class AuditEntry
        {
            public DateTime TimestampUtc { get; set; }

            public string Action { get; set; } = string.Empty;

            public string? ClientIp { get; set; }

            public JsonNode? Payload { get; set; }

            public JsonNode? Result { get; set; }
        }
    }
}
