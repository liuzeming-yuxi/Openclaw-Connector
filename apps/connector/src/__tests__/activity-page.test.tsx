import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { ActivityPage } from "../pages/ActivityPage";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {}))
}));

test("activity page renders with empty state", () => {
  render(<ActivityPage />);
  expect(screen.getByText("活动")).toBeInTheDocument();
  expect(
    screen.getByText("暂无活动记录。连接 Gateway 后将显示任务日志。")
  ).toBeInTheDocument();
});
