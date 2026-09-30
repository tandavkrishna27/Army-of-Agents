export { execute, runClaudeLogin } from "./execute.js";
export {
  runClaudeLoginStreaming,
  resolveClaudeConfigHome,
  CLAUDE_CREDENTIAL_FILE_NAME,
} from "./login.js";
export {
  sweepOrphanedIsolatedClaudeConfigDirs,
  ISOLATED_CLAUDE_CONFIG_MAX_AGE_MS,
  // Overlay-auth allowlist: env keys an operator may set on adapterConfig.env that
  // survive the ambient strip. Re-exported here so consumers (and the resolver's
  // drift-guard test) can import it via the package's `./server` subpath — the
  // module's own file is not a NodeNext-resolvable subpath export.
  CLAUDE_OVERLAY_AUTH_KEYS,
  type ClaudeConfigDirSweepResult,
} from "./ambient-config.js";
export { listClaudeSkills, syncClaudeSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export {
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
import type { AdapterSessionCodec } from "@armyofagents/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    const workspaceId = readNonEmptyString(params.workspaceId) ?? readNonEmptyString(params.workspace_id);
    const repoUrl = readNonEmptyString(params.repoUrl) ?? readNonEmptyString(params.repo_url);
    const repoRef = readNonEmptyString(params.repoRef) ?? readNonEmptyString(params.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};
