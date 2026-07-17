export function appendAssistantPreview(preview: string | undefined, persisted: string, delta: string): string {
  return `${preview ?? persisted}${delta}`;
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
