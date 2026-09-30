import type { AdapterSessionCodec } from "@armyofagents/adapter-utils";

function sessionId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const value of [record.sessionId, record.session_id]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize: (raw) => { const id = sessionId(raw); return id ? { sessionId: id } : null; },
  serialize: (raw) => { const id = sessionId(raw); return id ? { sessionId: id } : null; },
  getDisplayId: sessionId,
};

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
