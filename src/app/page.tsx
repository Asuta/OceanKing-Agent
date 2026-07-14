import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import { getWorkspaceEventCursor } from "@/lib/server/events";
import { getRepository } from "@/lib/server/repository";
import { ensureRuntimeStarted } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export default function Home() {
  ensureRuntimeStarted();
  // Capture the transport cursor first so every event after this snapshot boundary can be replayed.
  const initialEventCursor = getWorkspaceEventCursor();
  const initialSnapshot = getRepository().getSnapshot();
  return <WorkspaceShell initialSnapshot={initialSnapshot} initialEventCursor={initialEventCursor} />;
}
