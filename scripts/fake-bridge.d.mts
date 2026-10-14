/**
 * Déclarations TypeScript pour le bridge factice (scripts/fake-bridge.mjs).
 */

export type FakeBridgeFailMode = "none" | "unauthorized" | "server-error" | "timeout";

export interface FakeBridgeOptions {
  /** 0 ou omis = port éphémère choisi par l'OS. */
  port?: number;
  token?: string;
  latencyMs?: number;
  failMode?: FakeBridgeFailMode;
}

export interface RecordedRequest {
  method: string;
  url: string;
  authorization?: string;
  body?: unknown;
}

export interface FakeBridgeHandle {
  url: string;
  port: number;
  token: string;
  requests: RecordedRequest[];
  setFailMode(mode: FakeBridgeFailMode): void;
  setLatency(ms: number): void;
  close(): Promise<void>;
}

export function startFakeBridge(options?: FakeBridgeOptions): Promise<FakeBridgeHandle>;
