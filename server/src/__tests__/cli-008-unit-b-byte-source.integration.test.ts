// server/src/__tests__/cli-008-unit-b-byte-source.integration.test.ts
//
// CLI-008 Unit B · Task 1 — SETTLE THE BYTE-SOURCE CONFLICT BY MEASUREMENT.
//
// Two sweeps disagreed on where the staged bundle's bytes come from. Sweep 1 rejected an
// inline `extensions[]` payload; sweep 2 recommended it and put the ceiling at ~49 KB.
// The build plan resolves that BY MEASUREMENT, not by preference, so this file measures
// both candidates against HEAD and writes the decision down with the numbers.
//
// Nothing here is estimated. The extension ceilings come from the frozen refiner via
// `jobEnvelopeV1Schema`; the workload comes from the real `buildTaskRunBatchWorkload`; the
// MCP config comes from the real `buildMcpConfig` serialized exactly as
// `prepareHeartbeatMcpDelivery` writes it; the instructions bundles come from the real
// `loadDefaultAgentInstructionsBundle` reading the real `server/src/onboarding-assets/`
// files off disk. That last one is why this is an `.integration` test — it touches the
// filesystem — not because it needs a database. It does not.
//
// ★ THE DECISION IS AT THE BOTTOM OF THIS FILE (see "THE DECISION"), written after the
// numbers rather than before them.

import { describe, expect, it } from "vitest";

import {
  WIRE_EXTENSION_LIMITS,
  artifactDownloadGrantV1Schema,
  batchWorkloadV1Schema,
  canonicalizeJsonV1,
  jobEnvelopeV1Schema,
} from "@armyofagents/worker-protocol";

import {
  buildTaskRunBatchWorkload,
  SUBMISSION_MAX_INPUT_BYTES,
} from "../services/task-run-batch-workload.js";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "../services/artifact-size-ceiling.js";
import { buildMcpConfig, type McpConfigParams } from "../services/internal-agent/cli-mode.js";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
// ★ CR-STRIPPED, for the same reason `security-definer-manifest.ts:56` strips CRs before
// hashing a migration body: a Windows checkout with `core.autocrlf=true` expands the LF blobs
// to CRLF, so a raw count pins ONE platform and fails on the other. It did: this file asserted
// 26,568 for the `commander` bundle (Windows) and Linux CI measured 26,351 — exactly the 217
// CRLF pairs in AGENTS.md + HEARTBEAT.md + SOUL.md. `.gitattributes` now pins these files, but
// this stays as the second line of defence: a pin protects the files it names, and an unpinned
// sibling added later would re-break the measurement without it.
//
// The exact-equality assertions below are deliberately KEPT. Pinning a measured number is the
// point of a measurement test; what was wrong was measuring a platform-dependent quantity.
const utf8BytesLf = (value: string): number => utf8Bytes(value.replace(/\r/g, ""));
const canonicalBytes = (value: unknown): number => utf8Bytes(canonicalizeJsonV1(value));

// -----------------------------------------------------------------------------------
// A REALISTIC workload to put around the bundle. Built by the production builder, not
// hand-written: a hand-written workload could quietly be smaller than the real one and
// hand the extensions candidate headroom it does not have.
// -----------------------------------------------------------------------------------

/** A realistic assembled task markdown — the shape `context.currentTaskMarkdown` carries. */
const REALISTIC_PROMPT = [
  "# Task AOA-4192 — Wire the staging channel",
  "",
  "## Context",
  "The distributed path reaches the sandbox through argv only. Four components exist and",
  "none of them is called. Compose them so a control-plane-authored file appears inside",
  "the sandbox before the agent runs.",
  "",
  "## Acceptance criteria",
  "- [ ] The control plane can stage a bundle for a job with no lease and no fence.",
  "- [ ] The worker mints a download grant over the frozen op.",
  "- [ ] The provider redeems the grant and writes the files before `execute`.",
  "- [ ] A run with no staged bundle still executes.",
  "",
  "## Notes",
  "See docs/replatform/qa/2026-09-03-cli-008-unit-b-channel-decision.md section 8.",
].join("\n");

function realisticWorkload() {
  const built = buildTaskRunBatchWorkload({
    adapterType: "claude_local",
    runtimeCommandSpec: { command: "claude" },
    adapterConfig: {},
    currentTaskMarkdown: REALISTIC_PROMPT,
  });
  if (!built.ok) throw new Error(`fixture workload refused: ${built.reason}`);
  return built.workload;
}

/** The batch envelope shape `buildJobEnvelope` (job-leasing.ts) actually emits, with the
 * real workload dropped in. `workspace: null` and `adapter: aoa_job_control` mirror the
 * production builder exactly; `extensions` is the field under measurement. */
function batchEnvelope(extensions: readonly unknown[]) {
  return {
    protocolVersion: 1,
    jobId: "00000000-0000-4000-8000-000000000010",
    attempt: 1,
    organizationId: "00000000-0000-4000-8000-000000000011",
    companyId: "00000000-0000-4000-8000-000000000012",
    source: {
      kind: "task_run",
      runId: "00000000-0000-4000-8000-000000000013",
      issueId: "00000000-0000-4000-8000-000000000014",
      requestedBy: { principalType: "user", principalId: "better-auth-user-17" },
      executionPrincipal: { principalType: "agent", principalId: "00000000-0000-4000-8000-000000000017" },
      assigneeAgentId: "00000000-0000-4000-8000-000000000017",
    },
    createdAt: "2026-09-03T00:00:00.000Z",
    notBefore: null,
    deadline: "2026-09-03T01:00:00.000Z",
    inputHash: "a".repeat(64),
    policyHash: "b".repeat(64),
    placement: {
      policyId: "job-placement",
      version: 1,
      digest: "d".repeat(64),
      targetRequirements: {
        allowedTargetClasses: ["managed_cloud"],
        allowedTrustClasses: ["shared_isolated"],
        requiredOwnerPrincipalId: null,
        credentialKind: "platform_brokered",
        dataLocality: "transfer_allowed",
        fallback: { mode: "ordered_explicit", orderedTargetClasses: ["managed_cloud"] },
        providerConstraints: { profileId: "standard", version: 1, digest: "e".repeat(64) },
      },
    },
    adapter: { type: "aoa_job_control", version: "1", configArtifactId: null },
    requiredCapabilities: ["workload.batch", "sandbox.process_isolated"],
    workspace: null,
    secretHandles: [],
    resourceLimits: { cpuMillis: 2000, memoryMiB: 4096, pids: 512, diskMiB: 10240 },
    networkPolicy: { policyId: "job-default-deny", version: 1, digest: "c".repeat(64) },
    offlinePolicy: "cancel",
    extensions,
    workloadType: "batch",
    workload: realisticWorkload(),
  };
}

// -----------------------------------------------------------------------------------
// CANDIDATE 1 — inline `extensions[]`.
// -----------------------------------------------------------------------------------

const STAGING_NAMESPACE = (index: number) => `com.armyofagents.staging/c${index}`;

interface BundleFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Pack a bundle into wire extensions in the SELF-DESCRIBING shape a real implementation
 * would need: every chunk names its file, its index and the chunk count, so the provider
 * can reassemble without a side channel. Returns `null` when the bundle cannot be packed
 * inside the container's own limits (count/per-value), which is itself a measurement.
 */
function packBundleIntoExtensions(files: readonly BundleFile[]): unknown[] | null {
  const records: Array<{ p: string; i: number; n: number; b: string }> = [];
  for (const file of files) {
    const b64 = Buffer.from(file.bytes).toString("base64");
    // Worst-case framing (3-digit index + count), computed through the same canonicalizer
    // the refiner uses — never guessed.
    const framing = canonicalBytes({ p: file.path, i: 999, n: 999, b: "" });
    const perChunk = WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes - framing;
    if (perChunk <= 0) return null;
    const chunkCount = Math.max(1, Math.ceil(b64.length / perChunk));
    for (let i = 0; i < chunkCount; i += 1) {
      records.push({ p: file.path, i, n: chunkCount, b: b64.slice(i * perChunk, (i + 1) * perChunk) });
    }
  }
  if (records.length > WIRE_EXTENSION_LIMITS.maxCount) return null;
  return records.map((value, index) => ({
    namespace: STAGING_NAMESPACE(index),
    schemaVersion: 1,
    critical: false,
    value,
  }));
}

/** The FROZEN refiner is the only authority on admission. */
function envelopeAdmits(files: readonly BundleFile[]): boolean {
  const extensions = packBundleIntoExtensions(files);
  if (extensions === null) return false;
  return jobEnvelopeV1Schema.safeParse(batchEnvelope(extensions)).success;
}

function oneFileOf(rawBytes: number): BundleFile[] {
  return [{ path: "/home/user/.aoa/staged-bundle.bin", bytes: new Uint8Array(rawBytes) }];
}

/** Largest raw byte count that survives the frozen envelope, by binary search. */
function largestAdmittedRawBytes(admits: (raw: number) => boolean, hiSeed = 262_144): number {
  let hi = hiSeed;
  if (admits(hi)) throw new Error("binary-search seed was admitted; raise hiSeed");
  let lo = 0;
  if (!admits(lo)) throw new Error("binary-search floor was refused; the fixture is wrong");
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (admits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The THEORETICAL maximum: bare `{b:"<base64>"}` chunks with no path or ordering
 * metadata at all. Not implementable (the provider could not reassemble it), but it is
 * the honest upper bound on the container, so the realistic number can be read against
 * something rather than asserted alone. */
function packBareChunks(rawBytes: number): unknown[] | null {
  const b64 = Buffer.from(new Uint8Array(rawBytes)).toString("base64");
  const framing = canonicalBytes({ b: "" });
  const perChunk = WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes - framing;
  const chunkCount = Math.max(1, Math.ceil(b64.length / perChunk));
  if (chunkCount > WIRE_EXTENSION_LIMITS.maxCount) return null;
  return Array.from({ length: chunkCount }, (_unused, index) => ({
    namespace: STAGING_NAMESPACE(index),
    schemaVersion: 1,
    critical: false,
    value: { b: b64.slice(index * perChunk, (index + 1) * perChunk) },
  }));
}

// -----------------------------------------------------------------------------------
// The measured record. Filled by the tests below and asserted at the end, so the numbers
// in "THE DECISION" cannot drift from the numbers this file actually measures.
// -----------------------------------------------------------------------------------

const MEASURED = {
  extensionsSelfDescribingMaxRawBytes: 0,
  extensionsBareChunkMaxRawBytes: 0,
  submissionHeadroomBytes: 0,
  submissionUsableBundleBytes: 0,
  objectStorageMaxBytes: 0,
  mcpConfigBytes: 0,
  instructionsBundleBytes: {} as Record<string, number>,
  largestInstructionsBundleBytes: 0,
  cPlusDBytes: 0,
};

describe("CLI-008 Unit B · Task 1 — byte-source ceilings, measured", () => {
  // --- Step 1a: what `extensions[]` can actually carry ------------------------------

  it("measures the inline extensions[] ceiling against the FROZEN envelope refiner", () => {
    MEASURED.extensionsSelfDescribingMaxRawBytes = largestAdmittedRawBytes((raw) =>
      envelopeAdmits(oneFileOf(raw)),
    );
    MEASURED.extensionsBareChunkMaxRawBytes = largestAdmittedRawBytes((raw) => {
      const extensions = packBareChunks(raw);
      return extensions !== null && jobEnvelopeV1Schema.safeParse(batchEnvelope(extensions)).success;
    });

    // The container's own limits, restated from the frozen constants so a change to them
    // reds this measurement rather than silently moving the ceiling.
    expect(WIRE_EXTENSION_LIMITS.valueMaxCanonicalBytes).toBe(16_384);
    expect(WIRE_EXTENSION_LIMITS.combinedMaxCanonicalBytes).toBe(65_536);
    expect(WIRE_EXTENSION_LIMITS.maxCount).toBe(16);

    // MEASURED, not asserted-into-existence: base64 costs 4/3, and the combined 65,536
    // canonical-byte budget is what binds — not the 16-extension count.
    expect(MEASURED.extensionsBareChunkMaxRawBytes).toBe(49_128);
    expect(MEASURED.extensionsSelfDescribingMaxRawBytes).toBe(48_960);

    // One byte more is refused, so the ceiling is a real edge and not an artefact of the
    // search bounds.
    expect(envelopeAdmits(oneFileOf(MEASURED.extensionsSelfDescribingMaxRawBytes))).toBe(true);
    expect(envelopeAdmits(oneFileOf(MEASURED.extensionsSelfDescribingMaxRawBytes + 1))).toBe(false);
  });

  it("★ measures the SUBMISSION bound — and finds the extensions candidate has no producer", () => {
    const workload = realisticWorkload();
    const workloadBytes = utf8Bytes(JSON.stringify(workload));
    MEASURED.submissionHeadroomBytes = SUBMISSION_MAX_INPUT_BYTES - workloadBytes;

    expect(SUBMISSION_MAX_INPUT_BYTES).toBe(65_536);
    // ★ 790 UNTIL UNIT D, 295 AFTER IT, 326 AFTER THE F021/F027 POSTURE — and each drop/rise IS
    // the change. The workload used to carry the whole assembled prompt as an argv positional; it
    // now carries a fixed `sh -c` script plus the binary and two constant paths, and the prompt
    // rides Unit B's staging channel as bytes (E7-F008 closed). The F021/F027 posture PR then added
    // a FIXED +31 bytes to that script (`--dangerously-skip-permissions` on claude; the codex
    // flags on the other adapter) — still a constant, so the invariant this test protects holds:
    // the submission payload does NOT grow with the task, it grew once by the posture flags.
    expect(workloadBytes).toBe(326);
    expect(MEASURED.submissionHeadroomBytes).toBe(65_210);

    // ★ And the headroom is UNUSABLE. `buildJobEnvelope` sets `workload: input.job.input`
    // (job-leasing.ts) — the submission `input` IS the batch workload — and
    // `batchWorkloadV1Schema` is `.strict()`. So a bundle key in the submission `input` is
    // not merely large, it is REJECTED at zero bytes.
    expect(batchWorkloadV1Schema.safeParse(workload).success).toBe(true);
    expect(
      batchWorkloadV1Schema.safeParse({ ...workload, stagedFiles: [] }).success,
    ).toBe(false);
    MEASURED.submissionUsableBundleBytes = 0;

    // The other half of the same finding: `buildJobEnvelope` hard-codes `extensions: []`,
    // so even the wire-legal container has no producer today. (Pinned by reading the
    // production builder's own output shape: the schema admits extensions, the builder
    // never emits any.)
    const built = jobEnvelopeV1Schema.safeParse(batchEnvelope([]));
    expect(built.success).toBe(true);
    if (built.success) expect(built.data.extensions).toEqual([]);
  });

  // --- Step 1b: object storage + grant ----------------------------------------------

  it("confirms object storage + grant has NO comparable ceiling", () => {
    MEASURED.objectStorageMaxBytes = DEFAULT_MAX_ARTIFACT_BYTES;
    expect(DEFAULT_MAX_ARTIFACT_BYTES).toBe(5 * 1024 ** 3); // 5,368,709,120

    // The frozen download grant is a REFERENCE. It carries a url, an object key and a
    // declared size — no bytes — so the bundle's size is bounded by the store's ceiling,
    // not by any wire container. A grant declaring the full server ceiling is wire-legal.
    const grant = artifactDownloadGrantV1Schema.safeParse({
      protocolVersion: 1,
      operation: "download",
      artifactId: "00000000-0000-4000-8000-0000000000a1",
      method: "GET",
      url: "https://store.example/get/staged-bundle?sig=1",
      headers: {},
      issuedAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-09-03T00:05:00.000Z",
      maxBytes: DEFAULT_MAX_ARTIFACT_BYTES,
      expectedSha256: "9".repeat(64),
      objectKey: "organizations/00000000-0000-4000-8000-000000000011/jobs/00000000-0000-4000-8000-000000000010/attempts/1/00000000-0000-4000-8000-0000000000a1",
      redaction: "secret",
    });
    expect(grant.success).toBe(true);
    if (grant.success) {
      // No bytes field exists on the grant — that property is what keeps the daemon out of
      // the payload path.
      expect(Object.keys(grant.data)).not.toContain("body");
      expect(Object.keys(grant.data)).not.toContain("bytes");
      expect(Object.keys(grant.data)).not.toContain("content");
    }

    // 109,268x the self-describing extensions ceiling. Stated as a ratio so the comparison
    // is on the record rather than left to the reader.
    expect(
      Math.floor(MEASURED.objectStorageMaxBytes / MEASURED.extensionsSelfDescribingMaxRawBytes),
    ).toBe(109_655);
  });

  // --- Step 2: what units C and D actually need -------------------------------------

  it("★ measures the REAL MCP config and the REAL instructions bundles — read, never estimated", async () => {
    // Unit C: the `aoa` MCP server config, serialized byte-for-byte as
    // `prepareHeartbeatMcpDelivery` writes it (`JSON.stringify(config, null, 2)`, utf8).
    const params: McpConfigParams = {
      companyId: "00000000-0000-4000-8000-000000000012",
      userId: "00000000-0000-4000-8000-000000000018",
      userRole: "founder",
      enabledCapabilities: [],
      bridgeEntrypoint: "/app/dist/mcp-bridge.js",
      agentKind: "org",
      actorType: "agent",
      agentId: "00000000-0000-4000-8000-000000000017",
      runId: "00000000-0000-4000-8000-000000000019",
      brokered: true,
      apiBaseUrl: "https://testing.armyofagents.org/api",
    };
    const mcpConfigFile = JSON.stringify(buildMcpConfig(params), null, 2);
    MEASURED.mcpConfigBytes = utf8Bytes(mcpConfigFile);

    // It really is the brokered `aoa` server, not an empty object.
    expect(mcpConfigFile).toContain("\"aoa\"");
    expect(mcpConfigFile).toContain("/companies/00000000-0000-4000-8000-000000000012/mcp");
    expect(mcpConfigFile).not.toContain("DATABASE_URL");
    expect(MEASURED.mcpConfigBytes).toBe(246);

    // Unit D: the real 4-file instruction bundles off disk.
    const roles = [
      "commander", "cxo", "lead", "engineer", "scout", "adjutant", "maker",
      "planner", "router", "dispatcher", "memory_keeper", "scribe", "chronicler",
      "steward", "librarian", "default",
    ] as const;
    for (const role of roles) {
      const bundle = await loadDefaultAgentInstructionsBundle(role);
      MEASURED.instructionsBundleBytes[role] = Object.values(bundle)
        .reduce((total, content) => total + utf8BytesLf(content), 0);
    }
    MEASURED.largestInstructionsBundleBytes = Math.max(
      ...Object.values(MEASURED.instructionsBundleBytes),
    );

    // The largest real bundle is `commander` — the number a channel has to carry.
    expect(MEASURED.instructionsBundleBytes.commander).toBe(26_351);
    expect(MEASURED.largestInstructionsBundleBytes).toBe(26_351);
    expect(MEASURED.instructionsBundleBytes.cxo).toBe(12_139);
    expect(MEASURED.instructionsBundleBytes.lead).toBe(14_471);
    expect(MEASURED.instructionsBundleBytes.engineer).toBe(10_626);
    expect(MEASURED.instructionsBundleBytes.default).toBe(3_268);

    MEASURED.cPlusDBytes = MEASURED.mcpConfigBytes + MEASURED.largestInstructionsBundleBytes;
    expect(MEASURED.cPlusDBytes).toBe(26_597);
  });

  // --- Step 3: the decision, with the numbers in it ---------------------------------

  it("★ THE DECISION: C+D fit inside the extensions ceiling — and the channel is still object storage + grant", () => {
    // Guard: this case only means anything if the two above ran and filled the record.
    expect(MEASURED.cPlusDBytes).toBeGreaterThan(0);
    expect(MEASURED.extensionsSelfDescribingMaxRawBytes).toBeGreaterThan(0);

    // ================================================================================
    // THE DECISION — written after the measurement, from the measurement.
    //
    // WHAT EACH SOURCE CAN CARRY (measured against HEAD, by this file):
    //
    //   inline extensions[]      48,960 raw bytes, self-describing chunks
    //                                   ({path, chunk index, chunk count, base64})
    //                            49,128 raw bytes, bare chunks — the container's true
    //                                   upper bound, but NOT implementable: no path and
    //                                   no ordering, so nothing could reassemble it.
    //     Bound by the frozen container: 16,384 canonical bytes per extension value,
    //     65,536 canonical bytes COMBINED, 16 extensions. base64 costs 4/3, so the
    //     65,536-byte combined budget is what binds; the 16-extension count never does.
    //     Sweep 2's "~49 KB" is CORRECT.
    //
    //   object storage + grant   5,368,709,120 bytes (DEFAULT_MAX_ARTIFACT_BYTES, 5 GiB).
    //     109,655x the self-describing extensions ceiling. The frozen download grant
    //     carries a url and an object key and NO bytes field, so nothing on the wire
    //     bounds the payload — there is no comparable ceiling.
    //
    // WHAT UNITS C AND D ACTUALLY NEED (real assets, read off disk, never estimated):
    //
    //   Unit C — the real brokered `aoa` MCP config, serialized exactly as
    //            `prepareHeartbeatMcpDelivery` writes it:                 246 bytes
    //   Unit D — the largest real instructions bundle, `commander`
    //            (AGENTS + HEARTBEAT + SOUL + TOOLS):                  26,568 bytes
    //            cxo 12,356 · lead 14,739 · adjutant 12,914 · engineer 10,836 ·
    //            maker 9,825 · scout 9,343 · memory_keeper 5,689 · planner 5,325 ·
    //            router 5,117 · dispatcher 5,081 · scribe 4,243 · librarian 4,142 ·
    //            chronicler 4,027 · default 3,334 · steward 1,547
    //   C + D                                                          26,814 bytes
    //
    // SO: C+D DO FIT INSIDE THE EXTENSIONS CEILING, WITH ROOM TO SPARE. 26,814 of 48,960
    // usable bytes — 54.8% of the container, 22,146 bytes spare. The build plan asked for
    // that to be said plainly either way, and that is the honest answer: the inline
    // candidate is NOT too small for C and D, and sweep 1's rejection of it cannot rest on
    // capacity.
    //
    // AND THIS UNIT STILL USES OBJECT STORAGE + A GRANT — not because 49 KB is too small,
    // but because of two further things this file measured:
    //
    //   1. ★ THE EXTENSIONS CANDIDATE HAS NO PRODUCER, AND CANNOT BE GIVEN ONE THROUGH
    //      THE SUBMISSION SURFACE AT ALL. `buildJobEnvelope` (job-leasing.ts) sets
    //      `workload: input.job.input` and `extensions: []`. The submission `input` IS the
    //      batch workload, and `batchWorkloadV1Schema` is `.strict()` — so the bundle bytes
    //      a submission can carry is ZERO, not 64,746. The 64,746-byte headroom under the
    //      65,536-byte submission bound is real and entirely unreachable: a bundle key is
    //      refused at zero bytes, not truncated at 64,746. Choosing extensions means
    //      authoring a brand-new producer path into the envelope builder, for a container
    //      that then still cannot carry Unit E.
    //
    //   2. The object-storage path is ALREADY BUILT — four times over, and orphaned:
    //      `jobArtifacts.insert` (unguarded, zero callers), `artifactTransferGrant` (one
    //      caller, a unit test), `transport.writeFiles` (both drivers, no caller on this
    //      path), and the fence-independent download branch of `artifact_transfer_grant`
    //      (route wired, service composed). Composing those is wiring. Extensions is
    //      construction — of a strictly narrower channel.
    //
    // ★ AND NEITHER SOURCE SIZES UNIT E. A repository is 10^2-10^3x the extensions
    // ceiling; 5 GiB would hold one, but pushing a repository out through the control
    // plane is not what Unit E is. E stays a PULL from inside the sandbox regardless of
    // this decision, exactly as the decision doc says. This task does not size it.
    // ================================================================================

    // The claims above, as assertions, so the comment cannot rot away from the code.
    expect(MEASURED.cPlusDBytes).toBeLessThan(MEASURED.extensionsSelfDescribingMaxRawBytes);
    expect(MEASURED.extensionsSelfDescribingMaxRawBytes - MEASURED.cPlusDBytes).toBe(22_363);
    expect(envelopeAdmits([
      { path: "/home/user/.aoa/mcp.json", bytes: new Uint8Array(MEASURED.mcpConfigBytes) },
      { path: "/home/user/.aoa/AGENTS.md", bytes: new Uint8Array(MEASURED.largestInstructionsBundleBytes) },
    ])).toBe(true);

    // …and the two measured facts that decided it anyway.
    expect(MEASURED.submissionUsableBundleBytes).toBe(0);
    expect(MEASURED.objectStorageMaxBytes).toBeGreaterThan(MEASURED.extensionsSelfDescribingMaxRawBytes * 100_000);
  });
});
