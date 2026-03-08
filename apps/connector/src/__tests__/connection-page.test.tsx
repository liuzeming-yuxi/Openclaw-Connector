import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { ConnectionPage } from "../pages/ConnectionPage";

const invokeMock = vi.fn((command: string) => {
  if (command === "connect") {
    return Promise.resolve({
      state: "connected",
      reconnectAttempts: 0,
      lastError: null
    });
  }
  if (command === "get_connection_status") {
    return Promise.resolve({
      tunnelState: "connected",
      tunnelReconnectAttempts: 0,
      tunnelLastError: null,
      wsConnected: true
    });
  }
  return Promise.resolve(undefined);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));

test("connect button triggers connect command", async () => {
  render(<ConnectionPage />);

  const hostInput = screen.getByLabelText("主机");
  const userInput = screen.getByLabelText("用户");

  fireEvent.change(hostInput, { target: { value: "1.2.3.4" } });
  fireEvent.change(userInput, { target: { value: "root" } });
  fireEvent.click(screen.getByRole("button", { name: "连接" }));

  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith("connect", expect.any(Object));
  });
});
