import { render, screen } from "@testing-library/react";
import { ConnectionPage } from "../pages/ConnectionPage";
import "../i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "detect_local_gateway") {
      return Promise.reject("not found");
    }
    return Promise.resolve({
      tunnelState: "disconnected",
      wsConnected: false,
    });
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: { transformCallback: vi.fn() },
});

test("renders profile sidebar and detail", () => {
  render(<ConnectionPage />);
  expect(screen.getByText("连接配置")).toBeInTheDocument();
});
