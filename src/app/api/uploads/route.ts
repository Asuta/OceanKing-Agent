import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { publishWorkspaceEvent } from "@/lib/server/events";
import { assertLocalRequest } from "@/lib/server/http";
import { getRepository } from "@/lib/server/repository";
import { createId } from "@/lib/utils/id";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejected = assertLocalRequest(request); if (rejected) return rejected;
  const form = await request.formData(); const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "缺少文件" }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "附件不能超过 20MB" }, { status: 413 });
  const id = createId("attachment"); const safeName = path.basename(file.name).replace(/[^\p{L}\p{N}._-]+/gu, "_");
  const relative = path.join("uploads", `${id}-${safeName}`); const repository = getRepository();
  await fs.writeFile(path.join(repository.dataDir, relative), Buffer.from(await file.arrayBuffer()));
  const attachment = repository.registerAttachment({ id, fileName: file.name, mimeType: file.type || "application/octet-stream", byteSize: file.size, storagePath: relative });
  publishWorkspaceEvent("workspace.changed", id, { kind: "attachment" });
  return NextResponse.json(attachment, { status: 201 });
}
