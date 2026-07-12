import fs from "node:fs/promises";
import path from "node:path";
import { getRepository } from "@/lib/server/repository";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ attachmentId: string }> }) {
  const { attachmentId } = await context.params; const repository = getRepository(); const snapshot = repository.getSnapshot();
  const attachment = snapshot.rooms.flatMap((room) => room.messages.flatMap((message) => message.attachments)).find((item) => item.id === attachmentId);
  const target = repository.getAttachmentPath(attachmentId);
  if (!target) return new Response("Not found", { status: 404 });
  const data = await fs.readFile(target);
  return new Response(data, { headers: { "content-type": attachment?.mimeType ?? "application/octet-stream", "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(attachment?.fileName ?? attachmentId))}`, "cache-control": "private, max-age=3600" } });
}
