import { render, screen, fireEvent, act } from "@testing-library/react";
import { ConnectionPage } from "../pages/ConnectionPage";
import { invoke } from "@tauri-apps/api/core";

// Mock Tauri API calls
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve({
    tunnelState: "disconnected",
    wsConnected: false
  }))
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {}))
}));

// Mock window.__TAURI_INTERNALS__
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: {
    transformCallback: vi.fn()
  }
});

test("connect button triggers connect command", async () => {
  render(<ConnectionPage />);

  // The label texts are present but they don't have htmlFor connected to the inputs in our quick rewrite
  // We'll find by placeholder or the value instead
  
  // Find the host input by its initial value 127.0.0.1
  const inputs = screen.getAllByRole('textbox');
  
  // Update host (first input)
  fireEvent.change(inputs[0], { target: { value: "192.168.1.100" } });
  
  // Update user (second input)
  fireEvent.change(inputs[1], { target: { value: "admin" } });

  const btn = screen.getByText("连接网关");
  
  await act(async () => {
    fireEvent.click(btn);
  });

  expect(invoke).toHaveBeenCalledWith("connect", expect.objectContaining({
    server: expect.objectContaining({ host: "192.168.1.100", user: "admin" })
  }));
});
