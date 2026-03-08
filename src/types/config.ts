export interface ServerConfig {
  host: string;
  user: string;
  keyPath: string;
  localPort: number;
  remotePort: number;
}

export interface RuntimeConfig {
  heartbeatIntervalSec: number;
  reconnectIntervalSec: number;
}

export interface ConnectorConfig {
  server: ServerConfig;
  runtime: RuntimeConfig;
  globalAllow: boolean;
  gatewayToken: string;
  nodeId: string;
  nodeName: string;
  cdpPort: number;
  cdpRemotePort: number;
}

export function createDefaultConfig(): ConnectorConfig {
  return {
    server: {
      host: "127.0.0.1",
      user: "",
      keyPath: "~/.ssh/id_ed25519",
      localPort: 18789,
      remotePort: 18789
    },
    runtime: {
      heartbeatIntervalSec: 15,
      reconnectIntervalSec: 5
    },
    globalAllow: true,
    gatewayToken: "",
    nodeId: crypto.randomUUID(),
    nodeName: "用户本地",
    cdpPort: 9222,
    cdpRemotePort: 19222
  };
}
