export type ReasoningPreviewStep = {
  step: number;
  content: string;
  status: "streaming" | "answer_started" | "completed";
};

export type ReasoningPreview = {
  steps: ReasoningPreviewStep[];
  phase: "thinking" | "answering" | "working";
};

export function appendAssistantPreview(preview: string | undefined, persisted: string, delta: string): string {
  return `${preview ?? persisted}${delta}`;
}

export function appendReasoningPreview(preview: ReasoningPreview | undefined, step: number, delta: string): ReasoningPreview {
  const steps = preview?.steps ?? [];
  const existingIndex = steps.findIndex((entry) => entry.step === step);
  if (existingIndex < 0) return { steps: [...steps, { step, content: delta, status: "streaming" }], phase: "thinking" };
  return {
    steps: steps.map((entry, index) => index === existingIndex
      ? { ...entry, content: `${entry.content}${delta}`, status: "streaming" }
      : entry),
    phase: "thinking",
  };
}

export function markReasoningAnswerStarted(preview: ReasoningPreview | undefined): ReasoningPreview {
  if (!preview?.steps.length) return { steps: [], phase: "answering" };
  const latestIndex = preview.steps.length - 1;
  if (preview.phase === "answering" && preview.steps[latestIndex]?.status !== "streaming") return preview;
  return {
    steps: preview.steps.map((entry, index) => index === latestIndex && entry.status === "streaming" ? { ...entry, status: "answer_started" } : entry),
    phase: "answering",
  };
}

export function completeReasoningPreview(preview: ReasoningPreview | undefined): ReasoningPreview | undefined {
  if (!preview) return preview;
  if (!preview.steps.length) return preview.phase === "working" ? preview : { ...preview, phase: "working" };
  const latestIndex = preview.steps.length - 1;
  if (preview.phase === "working" && preview.steps[latestIndex]?.status === "completed") return preview;
  return { steps: preview.steps.map((entry, index) => index === latestIndex ? { ...entry, status: "completed" } : entry), phase: "working" };
}

export function unpersistedAssistantPreview(persisted: string, preview: string | undefined): string {
  return preview?.startsWith(persisted) ? preview.slice(persisted.length) : "";
}

export function mergedAssistantPreview(persisted: string, preview: string | undefined): string {
  if (!preview) return persisted;
  if (preview.startsWith(persisted)) return preview;
  if (persisted.startsWith(preview)) return persisted;
  return preview;
}
