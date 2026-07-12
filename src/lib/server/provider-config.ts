import type { ModelAndRuntimeSettings } from "@/lib/domain/types";

export function configuredModelList(): string[] {
  const configured = process.env.OPENAI_MODELS ?? process.env.OPENAI_MODEL ?? "gpt-5-mini";
  return [...new Set(configured.split(",").map((model) => model.trim()).filter(Boolean))];
}

export function normalizeOpenAiBaseUrl(raw = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses)$/i, "");
}

export function environmentRuntimeDefaults(): ModelAndRuntimeSettings {
  const availableModels = configuredModelList();
  const configuredDefault = process.env.OPENAI_MODEL?.trim();
  const model = configuredDefault && availableModels.includes(configuredDefault) ? configuredDefault : availableModels[0] ?? "gpt-5-mini";
  const format = process.env.OPENAI_API_FORMAT;
  return {
    apiFormat: format === "responses" || format === "chat_completions" ? format : "auto",
    model,
    availableModels,
    maxToolSteps: Number(process.env.OCEANKING_MAX_TOOL_STEPS ?? 12),
    maxRoomRounds: Number(process.env.OCEANKING_MAX_ROOM_ROUNDS ?? 32),
    projectContextRoots: [],
  };
}
