import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { ActivityPage } from "../pages/ActivityPage";

const invokeMock = vi.fn((command: string) => {
  if (command === "execute_task") {
    return Promise.resolve({
      exitCode: 0,
      stdout: "hello world",
      stderr: "",
      durationMs: 42
    });
  }
  if (command === "list_agent_bindings") {
    return Promise.resolve({ "agent-1": "mac-node-1" });
  }
  return Promise.resolve(undefined);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));

test("execute button triggers execute_task command", async () => {
  render(<ActivityPage />);

  const commandInput = screen.getByLabelText("命令");
  const nodeInput = screen.getByLabelText("本机 Node");

  fireEvent.change(commandInput, { target: { value: "echo hello" } });
  fireEvent.change(nodeInput, { target: { value: "mac-node-1" } });

  fireEvent.click(screen.getByRole("button", { name: "执行" }));

  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith("execute_task", expect.objectContaining({
      localNodeId: "mac-node-1"
    }));
  });
});
