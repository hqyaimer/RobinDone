export interface HelloMessage {
  type: "robindone-hello";
  version: string;
  platform: string;
  arch: string;
  pid: number;
}

export interface HelloAckMessage {
  type: "robindone-hello-ack";
  version: string;
  clientId: string;
}
