import type { Event, IDisposable } from "@robindone/rpc";
import type { RobinDoneProtocolMessage } from "@robindone/shared";

export type RobinDoneProtocolTransportKind = "stdio" | "websocket" | "memory";

export interface RobinDoneProtocolTransportClosedEvent {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
}

export interface RobinDoneProtocolTransport extends IDisposable {
  readonly kind: RobinDoneProtocolTransportKind;
  readonly onMessage: Event<RobinDoneProtocolMessage>;
  readonly onClose: Event<RobinDoneProtocolTransportClosedEvent>;
  send(message: RobinDoneProtocolMessage): Promise<void>;
  disposeAndWait?(): Promise<void>;
}
