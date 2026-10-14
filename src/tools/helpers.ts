/**
 * Petits utilitaires partagés par les tools (validation explicite aux frontières).
 */

import { QuantowerError } from "../errors.js";

/**
 * Valide une date ISO 8601 fournie par le client MCP et renvoie sa forme normalisée UTC.
 * On valide à la main (plutôt qu'avec zod.datetime) pour produire un message d'erreur explicite.
 */
export function parseIsoDateOrThrow(value: string | undefined, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new QuantowerError(
      "VALIDATION_ERROR",
      `Champ « ${fieldName} » invalide : « ${value} » n'est pas une date ISO 8601.`,
      { hint: "Format attendu : 2026-10-01T00:00:00Z ou 2026-10-01T02:00:00+02:00." },
    );
  }
  return new Date(timestamp).toISOString();
}

/** Vérifie qu'au moins un filtre obligatoire est fourni (ex. cancel_all_orders). */
export function requireAtLeastOneFilter(
  filters: Array<{ name: string; value: string | undefined }>,
  toolName: string,
): void {
  const provided = filters.filter((filter) => filter.value !== undefined && filter.value !== "");
  if (provided.length === 0) {
    const names = filters.map((filter) => filter.name).join(" ou ");
    throw new QuantowerError(
      "VALIDATION_ERROR",
      `${toolName} exige au moins un filtre : ${names}.`,
      { hint: "Précisez connectionId et/ou accountId pour limiter la portée de l'opération." },
    );
  }
}

/** Décode une valeur d'URI issue d'un template de ressource, sans jamais lever. */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
