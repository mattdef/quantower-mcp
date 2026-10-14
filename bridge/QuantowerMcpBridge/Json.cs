using System.Text.Json;
using System.Text.Json.Serialization;

namespace QuantowerMcpBridge
{
    /// <summary>
    /// Options de sérialisation partagées : camelCase strict (contrat plan §3) et
    /// omission des valeurs null pour garder des payloads stables et lisibles.
    /// </summary>
    internal static class Json
    {
        public static readonly JsonSerializerOptions Options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false,
        };

        public static readonly JsonSerializerOptions OptionsIndented = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = true,
        };

        private static readonly JsonSerializerOptions ReadOptions = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        };

        public static string Serialize(object? value) => JsonSerializer.Serialize(value, Options);

        public static string SerializeIndented(object? value) => JsonSerializer.Serialize(value, OptionsIndented);

        public static T? Deserialize<T>(string json) where T : class =>
            JsonSerializer.Deserialize<T>(json, ReadOptions);
    }
}
