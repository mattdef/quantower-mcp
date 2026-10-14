/**
 * Wrapper typé du bridge factice (scripts/fake-bridge.mjs) pour les tests vitest.
 */

import type {
  FakeBridgeFailMode,
  FakeBridgeHandle,
  FakeBridgeOptions,
  RecordedRequest,
} from "../../scripts/fake-bridge.mjs";

export type { FakeBridgeFailMode, FakeBridgeHandle, FakeBridgeOptions, RecordedRequest };

export async function startMockBridge(options: FakeBridgeOptions = {}): Promise<FakeBridgeHandle> {
  const module = await import("../../scripts/fake-bridge.mjs");
  return module.startFakeBridge(options);
}
