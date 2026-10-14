/**
 * Contrat JSON bridge ↔ serveur MCP (plan §3).
 *
 * Les DTOs sont figés par les fixtures de scripts/fixtures/*.json : toute évolution
 * de champ doit mettre à jour à la fois le bridge C#, ces types et les fixtures.
 */

export type OrderSide = "buy" | "sell";
export type OrderTypeName = "market" | "limit" | "stop" | "stop_limit";
export type TimeInForceName = "day" | "gtc" | "gtd" | "ioc" | "fok";

export interface CapsInfo {
  maxOrderQuantity: number;
  maxNotional: number;
  denyMarketOrders: boolean;
}

export interface BridgeHealth {
  status: string;
  bridgeVersion: string;
  platformVersion?: string;
  startedAtUtc: string;
  uptimeSeconds: number;
  tradingEnabled: boolean;
  caps: CapsInfo;
  connectionCount: number;
}

export interface ConnectionInfo {
  connectionId: string;
  name: string;
  status: string;
  type?: string;
}

export interface AccountInfo {
  accountId: string;
  connectionId: string;
  name: string;
  balance?: number;
  equity?: number;
  currency?: string;
  netPnl?: number;
  buyingPower?: number;
}

export interface SymbolInfo {
  symbolId: string;
  connectionId: string;
  name: string;
  description?: string;
  tickSize?: number;
  lotStep?: number;
  minLot?: number;
  maxLot?: number;
  baseAsset?: string;
  quoteAsset?: string;
}

export interface QuoteInfo {
  symbolId: string;
  connectionId: string;
  bid?: number;
  ask?: number;
  last?: number;
  volume?: number;
  open?: number;
  high?: number;
  low?: number;
  previousClose?: number;
  timestampUtc: string;
}

export interface BarInfo {
  timestampUtc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface HistoryResponse {
  symbolId: string;
  connectionId?: string;
  timeframe: string;
  bars: BarInfo[];
}

export interface DomLevelInfo {
  price: number;
  size: number;
}

export interface DomResponse {
  symbolId: string;
  connectionId?: string;
  timestampUtc: string;
  bids: DomLevelInfo[];
  asks: DomLevelInfo[];
}

export interface PositionInfo {
  positionId: string;
  connectionId: string;
  accountId: string;
  symbolId: string;
  side: OrderSide;
  quantity: number;
  openPrice?: number;
  currentPrice?: number;
  netPnl?: number;
  grossPnl?: number;
  openTimeUtc?: string;
}

export interface OrderInfo {
  orderId: string;
  connectionId: string;
  accountId: string;
  symbolId: string;
  side: OrderSide;
  orderType: OrderTypeName | string;
  status: string;
  quantity: number;
  filledQuantity?: number;
  price?: number;
  triggerPrice?: number;
  timeInForce?: string;
  createdAtUtc?: string;
  comment?: string;
}

export interface TradeInfo {
  tradeId: string;
  connectionId: string;
  accountId: string;
  symbolId: string;
  side: OrderSide;
  quantity: number;
  price: number;
  timestampUtc: string;
  fee?: number;
  orderId?: string;
}

/** Mapping JSON de TradingOperationResult (plan §3). */
export interface TradingOperationResult {
  status: "success" | "failure";
  message?: string;
  orderId?: string;
  positionId?: string;
}

export interface ProtectionPayload {
  price?: number;
  offsetTicks?: number;
}

export interface PlaceOrderPayload {
  accountId: string;
  symbolId: string;
  side: OrderSide;
  orderType: OrderTypeName;
  quantity: number;
  price?: number;
  triggerPrice?: number;
  timeInForce?: TimeInForceName;
  connectionId?: string;
  stopLoss?: ProtectionPayload;
  takeProfit?: ProtectionPayload;
  comment?: string;
}

export interface ModifyOrderPayload {
  quantity?: number;
  price?: number;
  triggerPrice?: number;
  timeInForce?: TimeInForceName;
}

export interface BridgeErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
