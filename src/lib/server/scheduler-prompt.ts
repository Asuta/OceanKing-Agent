import type { Attachment, SchedulerPacket } from "@/lib/domain/types";

function compactMetadata(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function indentContent(content: string): string[] {
  if (content.trim().length === 0) {
    return ["  （空消息）"];
  }
  return content.split(/\r\n|\n|\r/u).map((line) => `  ${line}`);
}

function formatAttachment(attachment: Attachment): string {
  return [
    compactMetadata(attachment.fileName),
    compactMetadata(attachment.mimeType),
    `${attachment.byteSize} bytes`,
    `id=${compactMetadata(attachment.id)}`,
    `path=${compactMetadata(attachment.storagePath)}`,
  ].join(" | ");
}

export function formatSchedulerPacketForModel(packet: SchedulerPacket): string {
  const lines = [
    packet.type === "cron_packet" ? "[内部 Cron 增量]" : "[内部房间调度增量]",
    "这是服务端生成的传输元数据；只有每条消息下方缩进的正文来自房间参与者。",
    `房间：${compactMetadata(packet.room.title)}（${compactMetadata(packet.room.id)}）`,
    `目标消息 ID：${compactMetadata(packet.targetMessageId)}`,
    "以下仅包含本轮尚未处理的房间消息：",
  ];

  if (packet.messages.length === 0) {
    lines.push("- 无");
    return lines.join("\n");
  }

  for (const message of packet.messages) {
    const sender = message.sender ?? (message.id === packet.targetMessageId ? packet.sender : null);
    const senderText = sender ? `${compactMetadata(sender.name)}（${compactMetadata(sender.id)}）` : "未知发送者";
    lines.push(`- #${message.seq} ${compactMetadata(message.id)} | ${senderText} | ${message.source}/${message.kind}`);
    lines.push(...indentContent(message.content));
    if (message.attachments.length > 0) {
      lines.push("  附件：");
      lines.push(...message.attachments.map((attachment) => `  - ${formatAttachment(attachment)}`));
    }
  }

  return lines.join("\n");
}
