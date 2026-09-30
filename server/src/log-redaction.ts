import os from "node:os";

export interface CurrentUserRedactionOptions {
  enabled: boolean;
}

const REDACTED_USERNAME = "***";

function getCurrentUsername(): string {
  return os.userInfo().username;
}

let cachedUsername: string | null = null;

function getCachedUsername(): string {
  if (!cachedUsername) {
    cachedUsername = getCurrentUsername();
  }
  return cachedUsername;
}

function redactUsernameInString(text: string, username: string): string {
  if (!username) return text;
  // Escape special regex characters in username
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "gi");
  return text.replace(re, REDACTED_USERNAME);
}

export function redactCurrentUserText(
  text: string,
  options: CurrentUserRedactionOptions,
): string {
  if (!options.enabled) return text;
  const username = getCachedUsername();
  return redactUsernameInString(text, username);
}

export function redactCurrentUserValue(
  value: unknown,
  options: CurrentUserRedactionOptions,
): unknown {
  if (!options.enabled) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactCurrentUserText(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCurrentUserValue(item, options));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactCurrentUserValue(val, options);
    }
    return result;
  }
  return value;
}
