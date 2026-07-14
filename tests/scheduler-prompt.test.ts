import { describe, expect, it } from "vitest";
import type { SchedulerPacket } from "@/lib/domain/types";
import { formatSchedulerPacketForModel } from "@/lib/server/scheduler-prompt";

describe("scheduler 增量提示词", () => {
  it("只呈现未读消息所需信息，不重复房间和 Agent 清单", () => {
    const packet: SchedulerPacket = {
      type: "scheduler_packet",
      room: { id: "room_harbor", title: "港湾协作室" },
      targetMessageId: "msg_two",
      cutoffSeq: 9,
      sender: { id: "human_local", name: "你" },
      messages: [
        {
          id: "msg_one",
          seq: 8,
          sender: { id: "builder", name: "执行者" },
          content: "    if ready:\n      run()\n",
          source: "agent_emit",
          kind: "progress",
          attachments: [],
        },
        {
          id: "msg_two",
          seq: 9,
          sender: { id: "human_local", name: "你" },
          content: "请检查附件",
          source: "user",
          kind: "user_input",
          attachments: [{
            id: "attachment_one",
            roomId: "room_harbor",
            messageId: "msg_two",
            fileName: "brief.md",
            mimeType: "text/markdown",
            byteSize: 42,
            storagePath: "uploads/attachment_one-brief.md",
            createdAt: "2026-07-14T00:00:00.000Z",
          }],
        },
      ],
      connectedRooms: [{ id: "room_other", title: "另一个房间" }],
      availableAgents: [{ id: "builder", label: "执行者", summary: "执行具体任务" }],
    };

    const prompt = formatSchedulerPacketForModel(packet);

    expect(prompt).toContain("[内部房间调度增量]");
    expect(prompt).toContain("目标消息 ID：msg_two");
    expect(prompt).toContain("执行者（builder）");
    expect(prompt).toContain("      if ready:\n        run()\n  \n");
    expect(prompt).toContain("brief.md | text/markdown | 42 bytes | id=attachment_one | path=uploads/attachment_one-brief.md");
    expect(prompt).not.toContain("connectedRooms");
    expect(prompt).not.toContain("availableAgents");
    expect(prompt).not.toContain("另一个房间");
    expect(prompt).not.toContain("执行具体任务");
    expect(prompt).not.toContain("2026-07-14");
  });

  it("兼容旧 packet 中缺少逐条 sender 的历史数据", () => {
    const packet: SchedulerPacket = {
      type: "cron_packet",
      room: { id: "room_harbor", title: "港湾协作室" },
      targetMessageId: "msg_legacy",
      cutoffSeq: 3,
      sender: { id: "cron:daily", name: "每日检查" },
      messages: [{ id: "msg_legacy", seq: 3, content: "检查未完成事项", source: "system", kind: "user_input", attachments: [] }],
      connectedRooms: [],
      availableAgents: [],
    };

    expect(formatSchedulerPacketForModel(packet)).toContain("每日检查（cron:daily）");
  });
});
