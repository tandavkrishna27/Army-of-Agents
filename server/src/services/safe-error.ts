const MAX_FIELD_LENGTH = 500;
const SECRET_PATTERN =
  /(bearer\s+|token[=:]\s*|api[_-]?key[=:]\s*|password[=:]\s*)[^\s,;"']+/gi;
const TOKEN_LIKE_PATTERN =
  /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const ABSOLUTE_PATH_PATTERN =
  /(?:[A-Za-z]:\\|\/(?:app|aoa|etc|home|opt|root|srv|tmp|Users|var|workspace)\/)[^\s,;"']+/g;
const URL_PATTERN = /https?:\/\/[^\s,;"']+/g;

function cap(value: string): string {
  return value.length <= MAX_FIELD_LENGTH
    ? value
    : `${value.slice(0, MAX_FIELD_LENGTH - 1)}…`;
}

function sanitizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "[redacted-url]";
  }
}

export function sanitizeErrorText(value: string): string {
  return cap(
    value
      .replace(SECRET_PATTERN, "$1[redacted]")
      .replace(TOKEN_LIKE_PATTERN, "[redacted-token]")
      .replace(URL_PATTERN, sanitizeUrl)
      .replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]"),
  );
}

/** Safe structured representation for logs. Never use the raw error as a field. */
export function serializeSafeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { name: "NonError", message: sanitizeErrorText(String(error)) };
  }

  const candidate = error as Error & {
    code?: unknown;
    status?: unknown;
    syscall?: unknown;
    cause?: unknown;
  };
  const serialized: Record<string, unknown> = {
    name: sanitizeErrorText(error.name || "Error"),
    message: sanitizeErrorText(error.message),
  };
  if (typeof candidate.code === "string") {
    serialized.code = sanitizeErrorText(candidate.code);
  }
  if (
    typeof candidate.status === "number" &&
    Number.isInteger(candidate.status)
  ) {
    serialized.httpStatus = candidate.status;
  }
  if (
    typeof candidate.syscall === "string" &&
    ["read", "write", "rename", "mkdir"].includes(candidate.syscall)
  ) {
    serialized.operation = candidate.syscall;
  }
  if (error.stack) {
    serialized.stack = sanitizeErrorText(error.stack);
  }
  if (candidate.cause !== undefined) {
    serialized.causeClass =
      candidate.cause instanceof Error
        ? sanitizeErrorText(candidate.cause.name || "Error")
        : typeof candidate.cause;
  }
  return serialized;
}
