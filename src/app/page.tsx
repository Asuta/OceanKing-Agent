import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import { getRepository } from "@/lib/server/repository";
import { ensureRuntimeStarted } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export default function Home() {
  ensureRuntimeStarted();
  return <WorkspaceShell initialSnapshot={getRepository().getSnapshot()} />;
}
