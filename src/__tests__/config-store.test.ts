import { createDefaultConfig } from "../types/config";

test("default config has required fields", () => {
  const cfg = createDefaultConfig();
  expect(cfg.server.host).toBeDefined();
  expect(typeof cfg.server.localPort).toBe("number");
  expect(cfg.nodeId).toBeDefined();
  expect(cfg.gatewayToken).toBe("");
});
