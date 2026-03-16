import { createDefaultConfig } from "../types/config";

test("default config has required fields", () => {
  const cfg = createDefaultConfig();
  expect(cfg.profiles.length).toBeGreaterThanOrEqual(1);
  expect(cfg.profiles[0].server.host).toBeDefined();
  expect(typeof cfg.profiles[0].server.localPort).toBe("number");
  expect(cfg.profiles[0].nodeId).toBeDefined();
  expect(cfg.profiles[0].gatewayToken).toBe("");
  expect(cfg.activeProfileId).toBeTruthy();
});
