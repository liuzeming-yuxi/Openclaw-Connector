import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { ActivityPage } from "../pages/ActivityPage";

const invokeMock = vi.fn((command: string) => {
  if (command === "run_command") {
    return Promise.resolve({
      exitCode: 0,
      stdout: "hello world",
      stderr: "",
      durationMs: 42
    });
  }
  return Promise.resolve(undefined);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args)
}));

test("execute button triggers run_command", async () => {
  render(<ActivityPage />);

  const commandInput = screen.getByLabelText("命令");
  fireEvent.change(commandInput, { target: { value: "echo hello" } });
  fireEvent.click(screen.getByRole("button", { name: "执行" }));

  await waitFor(() => {
    expect(invokeMock).toHaveBeenCalledWith("run_command", { command: "echo hello" });
  });
});
