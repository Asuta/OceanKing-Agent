// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomTitleEditor } from "@/components/workspace/room-panel";

afterEach(cleanup);

describe("房间标题编辑器", () => {
  it("保存时去除首尾空白并发送改名命令", async () => {
    const sendCommand = vi.fn().mockResolvedValue(true);
    render(<RoomTitleEditor roomId="room_one" title="新协作室" busy={false} sendCommand={sendCommand} />);

    fireEvent.click(screen.getByRole("button", { name: "修改房间名称" }));
    fireEvent.change(screen.getByRole("textbox", { name: "房间名称" }), { target: { value: "  产品讨论室  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存房间名称" }));

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith({ type: "rename_room", roomId: "room_one", title: "产品讨论室" }));
    expect(screen.queryByRole("textbox", { name: "房间名称" })).toBeNull();
  });

  it("命令失败时保留输入以便用户修正或重试", async () => {
    const sendCommand = vi.fn().mockResolvedValue(false);
    render(<RoomTitleEditor roomId="room_one" title="新协作室" busy={false} sendCommand={sendCommand} />);

    fireEvent.click(screen.getByRole("button", { name: "修改房间名称" }));
    fireEvent.change(screen.getByRole("textbox", { name: "房间名称" }), { target: { value: "未保存名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存房间名称" }));

    await waitFor(() => expect(sendCommand).toHaveBeenCalledOnce());
    expect((screen.getByRole("textbox", { name: "房间名称" }) as HTMLInputElement).value).toBe("未保存名称");
  });

  it("按 Escape 取消并恢复当前房间名称", () => {
    render(<RoomTitleEditor roomId="room_one" title="新协作室" busy={false} sendCommand={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "修改房间名称" }));
    const input = screen.getByRole("textbox", { name: "房间名称" });
    fireEvent.change(input, { target: { value: "不采用的名称" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.getByRole("heading", { name: "新协作室" })).toBeTruthy();
  });
});
