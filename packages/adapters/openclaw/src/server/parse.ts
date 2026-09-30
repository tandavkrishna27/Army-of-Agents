export function parseOpenClawResponse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isOpenClawUnknownSessionError(_text: string): boolean {
  return false;
}
