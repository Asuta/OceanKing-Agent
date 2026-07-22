// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomSidebar } from "@/components/workspace/room-sidebar";
import { commandBase, withRepository } from "./helpers";

afterEach(cleanup);

describe("房间侧栏置顶菜单", () => {
  it("右键房间后可发送置顶命令", async () => withRepository(async (repository) => {
    const sendCommand = vi.fn().mockResolvedValue(true);
    const snapshot = repository.getSnapshot();
    render(<RoomSidebar snapshot={snapshot} activeRoomId="room_harbor" activeAgentId={null} onSelect={vi.fn()} onSelectAgent={vi.fn()} sendCommand={sendCommand} busy={false} />);

    const roomButton = screen.getByText("港湾协作室").closest("button")!;
    fireEvent.contextMenu(roomButton, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶房间" }));

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith({ type: "set_room_pinned", roomId: "room_harbor", pinned: true }));
    expect(screen.queryByRole("menu")).toBeNull();
  }));

  it("已置顶房间显示标记，并支持键盘打开及关闭菜单", async () => withRepository((repository) => {
    repository.executeCommand({ ...commandBase(repository), type: "set_room_pinned", roomId: "room_harbor", pinned: true });
    render(<RoomSidebar snapshot={repository.getSnapshot()} activeRoomId="room_harbor" activeAgentId={null} onSelect={vi.fn()} onSelectAgent={vi.fn()} sendCommand={vi.fn().mockResolvedValue(true)} busy={false} />);

    const roomButton = screen.getByText("港湾协作室").closest("button")!;
    expect(screen.getByTitle("已置顶")).toBeTruthy();
    fireEvent.keyDown(roomButton, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "取消置顶" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  }));
});
