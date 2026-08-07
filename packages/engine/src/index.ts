import type { RuntimeBridgeFactory } from '@safescript/contracts';

export interface EngineOptions {
  readonly bridgeFactory: RuntimeBridgeFactory;
}
