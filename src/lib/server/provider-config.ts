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
  const thinkingMode = process.env.OPENAI_THINKING_MODE;
  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT;
  return {
    apiFormat: format === "responses" || format === "chat_completions" ? format : "auto",
    thinkingMode: thinkingMode === "enabled" || thinkingMode === "disabled" ? thinkingMode : "provider_default",
    reasoningEffort: reasoningEffort === "max" ? "max" : "high",
    model,
    availableModels,
    contextTokenThreshold: Number(process.env.OCEANKING_CONTEXT_TOKEN_THRESHOLD ?? 100_000),
    maxToolSteps: Number(process.env.OCEANKING_MAX_TOOL_STEPS ?? 12),
    maxRoomRounds: Number(process.env.OCEANKING_MAX_ROOM_ROUNDS ?? 32),
    projectContextRoots: [],
  };
}

export function normalizeRuntimeSettings(persisted: Partial<ModelAndRuntimeSettings>): ModelAndRuntimeSettings {
  const defaults = environmentRuntimeDefaults();
  return {
    ...defaults,
    ...persisted,
    contextTokenThreshold: Number.isInteger(persisted.contextTokenThreshold) && persisted.contextTokenThreshold! >= 1_024
      ? persisted.contextTokenThreshold!
      : defaults.contextTokenThreshold,
    projectContextRoots: persisted.projectContextRoots ?? [],
  };
}
