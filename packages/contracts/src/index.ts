export interface RuntimeBridge {
  readonly protocolVersion: '1';
}

export type RuntimeBridgeFactory = () => RuntimeBridge;
