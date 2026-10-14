/**
 * Garde-fous trading obligatoires (plan §4.5) :
 * - mode read_only par défaut (les tools ne sont même pas enregistrés) ;
 * - confirm: true exigé ;
 * - plafonds quantité / notionnel + interdiction éventuelle des ordres Market.
 */

import type { AppConfig } from "../config.js";
import type { PlaceOrderPayload } from "../bridge-types.js";
import { QuantowerError, confirmationRequiredError, tradingDisabledError } from "../errors.js";
import type { QuantowerClient } from "../quantower-client.js";

export function assertTradingEnabled(config: AppConfig, toolName: string): void {
  if (!config.trading.enabled) {
    throw tradingDisabledError(toolName);
  }
}

export function assertConfirmed(confirm: boolean | undefined, toolName: string, action: string): void {
  if (confirm !== true) {
    throw confirmationRequiredError(toolName, action);
  }
}

export interface OrderLimitEstimate {
  referencePrice?: number;
  estimatedNotional?: number;
}

/**
 * Contrôle du plafond de quantité seul, partagé par le placement et la modification
 * (une modification de quantité ne doit pas contourner le plafond, plan §4.5).
 */
export function assertQuantityWithinLimit(config: AppConfig, quantity: number): void {
  const { maxOrderQuantity } = config.trading;
  if (maxOrderQuantity > 0 && quantity > maxOrderQuantity) {
    throw new QuantowerError(
      "LIMIT_EXCEEDED",
      `Quantité ${quantity} supérieure au plafond QUANTOWER_MAX_ORDER_QUANTITY=${maxOrderQuantity}.`,
      { details: { quantity, maxOrderQuantity } },
    );
  }
}

/**
 * Applique les plafonds configurés avant l'envoi au bridge.
 * Pour un ordre Market (pas de prix dans la requête), le prix de référence est
 * lu depuis le carnet (bid/ask via /quote) afin de contrôler le notionnel.
 */
export async function assertOrderWithinLimits(
  config: AppConfig,
  client: QuantowerClient,
  order: PlaceOrderPayload,
): Promise<OrderLimitEstimate> {
  const { maxNotional, denyMarketOrders } = config.trading;

  if (denyMarketOrders && order.orderType === "market") {
    throw new QuantowerError(
      "LIMIT_EXCEEDED",
      "Les ordres Market sont interdits par QUANTOWER_DENY_MARKET_ORDERS=true.",
      { details: { orderType: order.orderType }, hint: "Utilisez un ordre Limit/Stop ou retirez l'interdiction." },
    );
  }

  assertQuantityWithinLimit(config, order.quantity);

  if (maxNotional <= 0) {
    return {};
  }

  const referencePrice = await resolveReferencePrice(client, order);
  if (referencePrice === undefined) {
    throw new QuantowerError(
      "LIMIT_EXCEEDED",
      "Impossible de vérifier le plafond notionnel : aucun prix de référence disponible (ordre Market sans quote).",
      {
        details: { symbolId: order.symbolId, orderType: order.orderType },
        hint: "Fournissez un price, vérifiez le symbole, ou désactivez le plafond avec QUANTOWER_MAX_NOTIONAL=0.",
      },
    );
  }

  const estimatedNotional = order.quantity * referencePrice;
  if (estimatedNotional > maxNotional) {
    throw new QuantowerError(
      "LIMIT_EXCEEDED",
      `Notionnel estimé ${estimatedNotional.toFixed(2)} supérieur au plafond QUANTOWER_MAX_NOTIONAL=${maxNotional}.`,
      { details: { quantity: order.quantity, referencePrice, estimatedNotional, maxNotional } },
    );
  }

  return { referencePrice, estimatedNotional };
}

async function resolveReferencePrice(
  client: QuantowerClient,
  order: PlaceOrderPayload,
): Promise<number | undefined> {
  if (order.price !== undefined) {
    return order.price;
  }
  if (order.triggerPrice !== undefined) {
    return order.triggerPrice;
  }
  const quote = await client.getQuote(order.symbolId, order.connectionId);
  const preferred = order.side === "buy" ? quote.ask ?? quote.last : quote.bid ?? quote.last;
  return preferred ?? quote.last;
}
