import { render, screen } from "@testing-library/react";
import App from "../App";

// Mock Tauri API calls so they don't break tests
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve({}))
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {}))
}));

// Mock window.__TAURI_INTERNALS__ for events
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: {
    transformCallback: vi.fn()
  }
});

test("renders connector shell", () => {
  render(<App />);
  expect(screen.getByText("连接器控制台")).toBeInTheDocument();
});
