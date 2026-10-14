using System;
using System.Collections.Generic;
using System.Globalization;

namespace QuantowerMcpBridge
{
    /// <summary>Journalisation minimale du bridge (console + intégration possible à un logger Quantower).</summary>
    public interface ILogSink
    {
        void Debug(string message);
        void Info(string message);
        void Warn(string message);
        void Error(string message, Exception? exception = null);
    }

    /// <summary>Implémentation console (le bridge tourne dans Quantower ou en standalone).</summary>
    public sealed class ConsoleLogSink : ILogSink
    {
        private readonly string _scope;

        public ConsoleLogSink(string scope)
        {
            _scope = scope;
        }

        public void Debug(string message) => Write("DEBUG", message);

        public void Info(string message) => Write("INFO", message);

        public void Warn(string message) => Write("WARN", message);

        public void Error(string message, Exception? exception = null)
        {
            Write("ERROR", exception is null ? message : $"{message} — {exception.GetType().Name}: {exception.Message}");
        }

        private void Write(string level, string message)
        {
            var line = string.Format(
                CultureInfo.InvariantCulture,
                "[{0:O}] {1} {2}: {3}",
                DateTime.UtcNow,
                level,
                _scope,
                message);
            Console.Error.WriteLine(line);
        }
    }

    /// <summary>Logger en mémoire, pratique pour les tests et le host stub.</summary>
    public sealed class CollectingLogSink : ILogSink
    {
        private readonly List<string> _lines = new List<string>();

        public IReadOnlyList<string> Lines => _lines;

        public void Debug(string message) => Add("DEBUG", message);

        public void Info(string message) => Add("INFO", message);

        public void Warn(string message) => Add("WARN", message);

        public void Error(string message, Exception? exception = null) =>
            Add("ERROR", exception is null ? message : $"{message} — {exception.Message}");

        private void Add(string level, string message)
        {
            lock (_lines)
            {
                _lines.Add($"{level} {message}");
            }
        }
    }

    /// <summary>Logger silencieux (tests unitaires).</summary>
    public sealed class NullLogSink : ILogSink
    {
        public static readonly NullLogSink Instance = new NullLogSink();

        public void Debug(string message)
        {
        }

        public void Info(string message)
        {
        }

        public void Warn(string message)
        {
        }

        public void Error(string message, Exception? exception = null)
        {
        }
    }
}
