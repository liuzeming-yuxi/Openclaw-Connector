import { createDefaultConfig } from "../types/config";

test("accepts exactly one server profile", () => {
  const cfg = createDefaultConfig();
  expect(cfg.server.host).toBeDefined();
  expect(typeof cfg.server.localPort).toBe("number");
});
