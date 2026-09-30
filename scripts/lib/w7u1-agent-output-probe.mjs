// scripts/lib/w7u1-agent-output-probe.mjs
//
// W7U1 — THE PURE CORE OF THE OUTPUT PROBE PACK.
//
// The pack answers ONE question with a real, keyed E2B run:
//
//   Can a real `claude` / `codex`, invoked under the EXACT PRODUCTION ARGV
//   (`buildSandboxInvocation`, server/src/services/task-run-sandbox-invocation.ts),
//   write a file inside the sandbox AT ALL?
//
// It BUILDS NO OUTPUT MECHANISM. It measures whether one is possible, and it must be
// able to answer **no** as cleanly as it answers yes.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE LOGIC IS SEPARATED FROM THE SANDBOX
// ─────────────────────────────────────────────────────────────────────────────
// The keyed lane runs ONCE, on an operator's authorisation, with a real key. Every
// decision it makes must therefore be provable WITHOUT the key, or the run is the
// first and only exercise of the code that reads it — which is the exact shape of
// the eight divergences the first keyed conformance run surfaced
// (`CLI-realE2B-hardening-result.md`). So every classification, every verdict and
// the secret redactor live here as pure functions with killable mutants, tested by
// `scripts/lib/__tests__/w7u1-agent-output-probe.test.mjs` in the required `policy`
// job. The sandbox-touching half is
// `packages/sandbox-e2b-provider/src/__tests__/keyed-w7u1-agent-output-probe.test.ts`.
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE STATES, ALWAYS — AND WHY "inconclusive" IS NOT A FAILURE STATE
// ─────────────────────────────────────────────────────────────────────────────
// A probe that can only pass is worthless, and a probe whose error is
// indistinguishable from a negative result is worse than worthless: it converts an
// apparatus failure into a finding. So every verdict is one of:
//
//   "yes"          — the thing happened, and the evidence names it
//   "no"           — the thing did NOT happen, and the run was sound enough to say so
//   "inconclusive" — the apparatus did not establish either; the reason is CARRIED,
//                    never flattened to a boolean
//
// `no` is a RESULT and the lane stays green for it. `inconclusive` is the only state
// that reds the lane, because it is the only one that means "run me again".
//
// Zero imports on purpose: this module is loaded both by `node --test` (policy) and by
// a vitest test inside `@armyofagents/sandbox-e2b-provider`, whose runtime-source
// import boundary allows exactly five packages. Nothing here reaches the network, the
// filesystem, or `process`.

/** The three states every probe and every verdict reports. */
export const PROBE_STATES = Object.freeze(["yes", "no", "inconclusive"]);

// ─────────────────────────────────────────────────────────────────────────────
// 0. WHICH IMAGE ANSWERED — the template is resolved EXPLICITLY, never by omission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The E2B template alias that CARRIES THE AGENT CLIs.
 *
 * ★★★ MEASURED, not chosen. `e2b/e2b.Dockerfile` builds this alias and its final layer is
 * `RUN command -v claude && command -v codex && claude --version && codex --version`, so a
 * template that built at all has both binaries on PATH. `e2b/README.md` §2-3 registers it
 * under this alias and threads it end to end as `E2B_TEMPLATE=aoa-base`; the campaign QA
 * record (`docs/replatform/qa/2026-08-31-campaign-blockers-and-fleet-terrain.md` §9d)
 * measured it `buildStatus: ready` on the operator's account (templateID
 * `7vg8mu6gaoz2inw62lv8`).
 */
export const CLI_BEARING_TEMPLATE_ALIAS = "aoa-base";

/**
 * The E2B default, which has NO AGENT CLIs — and, per the last recorded push trigger
 * (`.github/keyed-e2b-trigger` entry #4, 2026-08-26), "coreutils only".
 *
 * ★★★ IT IS NAMED HERE SO IT CAN BE REFUSED. E7-F022 measured that every keyed lane pipes
 * `inputs.e2b_template` straight into `E2B_TEMPLATE` and that an omitted input therefore
 * "silently defaults to the bare `base` template" — an image with no agent in it. For the
 * sibling lanes that costs nothing (their subject is the invocation SHAPE). For THIS pack
 * it would spend the founder's single authorised, token-spending run on a sandbox that
 * cannot host the thing being measured.
 */
export const BARE_BASE_TEMPLATE_ALIAS = "base";

/**
 * Resolve the template the pack will actually run against.
 *
 * ★ AN OMITTED INPUT RESOLVES TO THE CLI-BEARING TEMPLATE, NOT TO BARE `base`. The
 * alternative — requiring the input — was rejected because the lane's documented bootstrap
 * route is a `push` to the trigger file, and a `push` event carries NO inputs at all: a
 * hard requirement would make the only route that is guaranteed to work the only route
 * that can never run. So omission resolves to the image that can answer the question, and
 * the resolution is REPORTED (`source`, `note`) rather than assumed, so a reader of the
 * durable record can always tell which image answered and why.
 *
 * An explicitly supplied alias is honoured VERBATIM — including `base`, if an operator
 * deliberately wants the no-CLI measurement. Explicit is explicit; only omission is
 * corrected.
 *
 * @param {unknown} raw the `E2B_TEMPLATE` / `inputs.e2b_template` value, possibly empty
 * @returns {{templateId: string, source: "explicit"|"default-cli-bearing", note: string}}
 */
export function resolveTemplate(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length > 0) {
    return {
      templateId: trimmed,
      source: "explicit",
      note:
        trimmed === BARE_BASE_TEMPLATE_ALIAS
          ? `EXPLICITLY set to the bare "${BARE_BASE_TEMPLATE_ALIAS}" template, which carries NO agent CLIs (E7-F022). ` +
            "Probe A will report `template-has-no-node-runtime` / `cli-install-failed` and the lane will red."
          : "explicitly supplied by the dispatch input",
    };
  }
  return {
    templateId: CLI_BEARING_TEMPLATE_ALIAS,
    source: "default-cli-bearing",
    note:
      `no template was supplied, so the pack resolved to "${CLI_BEARING_TEMPLATE_ALIAS}" — the alias `
      + `e2b/e2b.Dockerfile builds with claude+codex asserted on PATH. It does NOT fall back to `
      + `"${BARE_BASE_TEMPLATE_ALIAS}": E7-F022 measured that bare base has no agent CLIs, and running the `
      + "decisive probe against an image with no agent would spend the one authorised run on nothing.",
  };
}

/**
 * How a READ of an in-sandbox path terminated.
 *
 * ★★★ THE READ CHANNEL IS A CHANNEL, EXACTLY LIKE THE EXEC CHANNEL. `readBack` used to
 * catch EVERY throw and answer `found:false`, which made a transport fault during the
 * readback byte-identical to "the agent wrote nothing" — an apparatus failure printed
 * to the operator as a capability answer, on the single authorised run that is supposed
 * to settle the question. The exec-side controls do NOT cover it: A0's success is
 * temporally PRIOR to A1's readback, not concurrent with it, so a fault that first
 * appears during A1's read is invisible to A0.
 *
 * `real-transport.ts` already draws the line the probe needs: `readFile` raises
 * `E2bTransportNotFoundError` for a genuine "no such file" and rethrows anything else
 * verbatim. So the caller keys off `err instanceof E2bTransportNotFoundError`:
 *
 *   "not-found" — the path is genuinely absent. A NEGATIVE RESULT is admissible.
 *   "faulted"   — the read itself failed for any other reason. NOTHING may be concluded
 *                 about the file, and the arm/probe is INCONCLUSIVE.
 *   null        — the read succeeded.
 */
export const READ_ERROR_KINDS = Object.freeze(["not-found", "faulted"]);

/**
 * Is a listing command's terminal channel usable as evidence of what is in a directory?
 *
 * ★ ONLY `returned` IS. A listing that TIMED OUT produced no directory contents and yet
 * used to leave `listingOk` true, so probe B would go on to report
 * `template-prefills-nothing` on the strength of a listing that never happened — the
 * same "a fault becomes a confident negative" shape as the read channel, one probe over.
 * `timedOut`, `threw`, `not-run` and `binary-missing` are all "we did not look".
 */
export function isListingUsable(channel) {
  return channel === "returned";
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE PERMISSION POSTURE — probe A2's ONLY variable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The permission posture each adapter's LEGACY (shipped, non-distributed) path applies
 * for an unattended run, and the exact anchor inside the DISTRIBUTED script that it
 * would have to be inserted at.
 *
 * ★ MEASURED, not assumed — this is the premise the whole unit rests on and it was
 * re-verified at `31d33a3b0` before a line of this file was written:
 *
 *   * `task-run-sandbox-invocation.ts:181-206` holds FOUR script literals (claude with
 *     and without a bundle, codex with and without) and **none of the four carries any
 *     permission posture** — no `--dangerously-skip-permissions`, no `--settings`, no
 *     `--allowedTools`, no `--dangerously-bypass-approvals-and-sandbox`.
 *   * The shipped product treats the flag as REQUIRED for an unattended run:
 *     `claude-local/src/server/execute.ts:745` (unbridged) and
 *     `internal-agent/cli-mode.ts:598` push it; `codex-local/src/server/execute.ts:555`
 *     pushes codex's.
 *   * And the absence is recorded as a MEASURED defect, not a theory:
 *     `resolve-crew-adapter.ts:147-151` — without it a `--print` crew run "silently
 *     no-op[s] on every MCP tool call (permission gate hangs)", found in UAT
 *     iteration 2 and fixed by BACKFILLING the flag onto existing rows.
 *
 * So A1 (production argv, no posture) versus A2 (same everything, posture added) is a
 * differential over the one variable the source says should matter.
 *
 * ★★ THE FLAG IS APPLIED BY REWRITING THE EMITTED SCRIPT, INSIDE THE PROBE. Production
 * is not touched: `buildSandboxInvocation` emits A1's argv verbatim, and A2 is that
 * argv with one substring replaced. The alternative — editing the production literal —
 * would make the probe a test of a change nobody has decided to make.
 *
 * `anchor` positions are taken from the legacy adapters so A2 is the shape the shipped
 * product actually spawns: claude appends the flag after the base
 * `--print - --output-format stream-json --verbose` block (`execute.ts:736,745`), and
 * codex inserts it between `exec --json` and the `-` positional (`execute.ts:553-566`).
 */
export const PERMISSION_POSTURES = Object.freeze({
  claude_local: Object.freeze({
    flag: "--dangerously-skip-permissions",
    anchor: "--output-format stream-json --verbose",
    replacement: "--output-format stream-json --verbose --dangerously-skip-permissions",
  }),
  codex_local: Object.freeze({
    flag: "--dangerously-bypass-approvals-and-sandbox",
    anchor: "exec --json -",
    replacement: "exec --json --dangerously-bypass-approvals-and-sandbox -",
  }),
});

/** Raised when the production script no longer contains the anchor A2 rewrites. */
export class PermissionPostureAnchorError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermissionPostureAnchorError";
  }
}

/** Count NON-OVERLAPPING occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack, needle) {
  if (needle.length === 0) throw new Error("countOccurrences: empty needle");
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Probe A2's transform: the production script, plus the adapter's permission posture.
 *
 * ★★★ THIS FUNCTION EXISTS TO REFUSE, NOT TO REWRITE. If a future edit to
 * `task-run-sandbox-invocation.ts` moves or removes the anchor, a permissive
 * implementation would return the script UNCHANGED — and then A2 would be
 * byte-identical to A1, the differential would compare a thing with itself, and the
 * pack would report "the flag makes no difference" while never having applied it. That
 * is this programme's [[checks-that-nothing-runs]] class, one layer in. So every way
 * of failing to apply the flag THROWS:
 *
 *   * unknown adapter                 → nothing to apply
 *   * anchor absent                   → the production shape moved
 *   * anchor ambiguous (≠1 match)     → we cannot say WHERE it would land
 *   * the flag is ALREADY present     → the unit's premise has collapsed; that is the
 *                                       finding, and silently "adding" it would hide it
 *   * the result equals the input     → belt and braces; a no-op rewrite is a lie
 */
export function withPermissionPosture(script, adapterType) {
  const posture = PERMISSION_POSTURES[adapterType];
  if (!posture) {
    throw new PermissionPostureAnchorError(
      `no permission posture is defined for adapterType "${adapterType}"; probe A2 cannot vary what it does not know`,
    );
  }
  if (script.includes(posture.flag)) {
    throw new PermissionPostureAnchorError(
      `the production script ALREADY carries ${posture.flag} for ${adapterType}. ` +
        `W7U1's premise (the distributed argv has no permission posture) is REFUTED — report that, do not probe it.`,
    );
  }
  const matches = countOccurrences(script, posture.anchor);
  if (matches !== 1) {
    throw new PermissionPostureAnchorError(
      `expected exactly 1 occurrence of the A2 anchor ${JSON.stringify(posture.anchor)} in the ${adapterType} ` +
        `script, found ${matches}. The production shape moved; re-derive the anchor before trusting any A1-vs-A2 comparison.`,
    );
  }
  const rewritten = script.replace(posture.anchor, posture.replacement);
  if (rewritten === script) {
    throw new PermissionPostureAnchorError(
      `the ${adapterType} A2 rewrite was a NO-OP; A2 would be identical to A1 and the differential would be vacuous`,
    );
  }
  return rewritten;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SECRET REDACTION — nothing the pack prints may carry a credential
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace every occurrence of every supplied secret VALUE with a fixed marker.
 *
 * The pack prints the agent's raw stdout and stderr, because "exited 0 and wrote
 * nothing" and "printed a permission prompt and stalled" are different answers and the
 * operator has to be able to tell them apart. A CLI that echoes its own configuration
 * — or an error that quotes the environment — would otherwise put the key in a public
 * Actions log. So EVERY string this pack emits goes through here.
 *
 * Short values are ignored: a 3-character "secret" would redact ordinary prose and make
 * the log unreadable, which is its own way of losing the evidence.
 */
export const REDACTION_MARKER = "«redacted»";
export const MIN_REDACTABLE_SECRET_LENGTH = 8;

export function redactSecrets(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets ?? []) {
    if (typeof secret !== "string") continue;
    if (secret.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    out = out.split(secret).join(REDACTION_MARKER);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2b. DID THE CLI ACTUALLY START? — the positive evidence an exoneration needs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The head stream event each agent CLI emits once it has started, and nothing else does.
 *
 * ★★★ THIS EXISTS BECAUSE A REFUSAL AND A RESULT LOOKED THE SAME. E7-F028 measured the
 * cost on a founder-authorised, token-spending run: `classifyProbeAArm` mapped EVERY
 * non-zero exit to `did-not-write`, so codex — which exited 1 having refused before it
 * ever contacted a model — was recorded as a capability answer, and `verdictProbeA` went
 * on to state `a1-did-not-write-and-the-posture-is-not-the-cause`: a sentence the same
 * run's own stderr contradicts. Concluding "the posture is not the cause" from two
 * refusals is [[e2b-denyOut-accepted-echoed-inert]]'s error class — deciding a control is
 * inert from a signal that never exercised it.
 *
 * ★★ MEASURED PER CLI, TWICE OVER — from the adapters that parse these events in the
 * shipped product, AND from this pack's own recorded stdout in run 34087197668. Not
 * guessed, and not inherited from the brief:
 *
 *   claude_local → `{"type":"system","subtype":"init",…}`
 *     * `packages/adapters/claude-local/src/server/parse.ts:19`
 *       `if (type === "system" && asString(event.subtype, "") === "init")`
 *       (same pair at `claude-local/src/cli/format-event.ts:34` and
 *       `claude-local/src/ui/parse-stdout.ts:44`).
 *     * Run 34087197668, `[w7u1/A/claude_local] A1 … stdout="{\"type\":\"system\",
 *       \"subtype\":\"init\",\"cwd\":\"/home/user\",\"session_id\":\"de6ba132-…\",…"`.
 *       ★ BOTH keys are required, and on the SAME LINE: `"type":"system"` alone also
 *       heads non-init system events, so matching it alone would call a CLI "started"
 *       on an event that says nothing of the kind.
 *
 *   codex_local  → `{"type":"thread.started","thread_id":…}`
 *     * `packages/adapters/codex-local/src/server/parse.ts:64` (`extractCodexSessionId`,
 *       `if (asString(event.type, "") !== "thread.started") continue;`) and `:136`
 *       (`parseCodexJsonl`, `if (type === "thread.started")`).
 *     * Run 34087197668, `[w7u1/A/codex_local] A2 … stdout="{\"type\":\"thread.started\",
 *       \"thread_id\":\"01a07a5b-b6b9-7fe2-9729-999757da1442\"}\n{\"type\":\"turn.started\"}…"`,
 *       against `[w7u1/A/codex_local] A1 … exit=1 … stdout=""` — the refusal, with no
 *       head event at all. That contrast IS the measurement.
 *
 * ★ WHITESPACE-TOLERANT, LINE-SCOPED. The measured output is compact JSONL, but a
 * pretty-printed variant must not silently read as "did not start"; equally, requiring
 * the pair on ONE line stops two unrelated events from combining into false evidence.
 */
export const STARTUP_STREAM_EVIDENCE = Object.freeze({
  claude_local: Object.freeze({
    describe: 'claude\'s stream-json head event `{"type":"system","subtype":"init",…}`',
    required: Object.freeze([/"type"\s*:\s*"system"/, /"subtype"\s*:\s*"init"/]),
  }),
  codex_local: Object.freeze({
    describe: 'codex\'s JSONL head event `{"type":"thread.started","thread_id":…}`',
    required: Object.freeze([/"type"\s*:\s*"thread\.started"/]),
  }),
});

/**
 * Did THIS arm's stdout show the CLI reaching its own startup?
 *
 * ★★★ IT ANSWERS ONLY THE POSITIVE DIRECTION, AND THAT IS THE POINT. `ran:true` means a
 * head event was seen. `ran:false` means NO SUCH EVENT WAS SEEN — never "the CLI did not
 * run". The distinction matters because this value is consumed fail-closed: absence of
 * evidence blocks an exoneration, it never manufactures one.
 *
 * An unknown adapter yields `ran:false` with a reason, for the same fail-closed cause: a
 * pack that cannot say what starting looks like cannot certify that anything started.
 *
 * @param {unknown} stdout the arm's captured stdout (already redacted by the caller)
 * @param {unknown} adapterType `"claude_local"` | `"codex_local"`
 * @returns {{ran: boolean, evidence: string, detail: string}}
 */
export function detectStartupEvidence(stdout, adapterType) {
  const spec = STARTUP_STREAM_EVIDENCE[adapterType];
  if (!spec) {
    return {
      ran: false,
      evidence: "",
      detail:
        `no startup stream event is defined for adapterType ${JSON.stringify(String(adapterType ?? ""))}, so this ` +
        "arm cannot be shown to have run at all",
    };
  }
  const text = typeof stdout === "string" ? stdout : "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (spec.required.every((re) => re.test(line))) {
      return { ran: true, evidence: line.slice(0, 200), detail: `${spec.describe} was present on this arm's stdout` };
    }
  }
  return {
    ran: false,
    evidence: "",
    detail:
      `${spec.describe} was NOT present on this arm's stdout (${text.trim().length} chars captured), so nothing ` +
      "shows the CLI reached its own startup",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2b-ii. DID THE ARM REACH A MODEL? — what an exoneration actually needs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The stream events that evidence an arm RECEIVING OUTPUT FROM A MODEL, per agent CLI.
 *
 * ★★★ THE EXONERATION PREDICATE HAS BEEN WRONG THREE TIMES. This comment records the whole
 * cascade rather than only the current rule, because every earlier version was NECESSARY
 * AND INSUFFICIENT and the next one probably is too:
 *
 *   v1  any non-zero exit ⇒ `did-not-write`. Could not tell a REFUSAL from a RESULT, so
 *       codex's trusted-directory refusal was booked as the agent's capability answer and
 *       the lane went green on `the-posture-is-not-the-cause` (E7-F028, run 34087197668).
 *   v2  "at least one arm demonstrably ran". WRONG ARM: only A2 carries the posture, so A1
 *       running proves nothing about a posture-only fix — the gate could be satisfied by
 *       the arm the claim is not about.
 *   v3  require `a2.ran === true`. Better, and still insufficient.
 *   v4  ★ `ran` IS COMPUTED FROM THE HEAD EVENT ALONE. Two arms that START and then show no
 *       model-contact evidence satisfy v3 and exonerate a posture nothing was shown to have
 *       exercised — GREEN, in the durable record. That is not hypothetical: codex A2 in run
 *       34087197668 emitted `{"type":"thread.started",…}` and `{"type":"turn.started"}` and
 *       then FOUR `{"type":"error","message":"Reconnecting… N/5 … 401 Unauthorized"}` lines
 *       — numbered 2/5, 3/5, 4/5, 5/5 — against `wss://api.openai.com/v1/responses`.
 *       ★★ THE SECOND HALF OF THAT SENTENCE IS ABOUT THE RECORD, NOT ABOUT THE AGENT, and
 *       it is stated that way deliberately. A2 STARTED, and NO model-contact evidence is
 *       present in the stdout the run preserved — which was EXACTLY 900 characters.
 *       ★★★ 900 IS THE CAP (`safe(exec.stdout, 900)`), HIT EXACTLY, AND THAT IS ITSELF THE
 *       PROOF OF TRUNCATION: a stdout that stopped on its own would land on some arbitrary
 *       length, not precisely on the limit. So it is KNOWN that there was more, and UNKNOWN
 *       what it said. The capture ends MID-TOKEN at `{"type":"i`, while codex A3's parallel
 *       line shows the same position reads `{"type":"item.completed","item":{"id":"item_0`
 *       with the item type cut off. So whether A2 emitted an `agent_message` after its
 *       reconnects CANNOT BE DETERMINED from what was preserved — which is exactly why v4
 *       fails CLOSED (`reachedModel !== true` ⇒ `inconclusive`) instead of concluding
 *       anything about the agent. "It reached nothing" was never a supportable sentence.
 *
 * So the gate is not "did the CLI start" but "did THIS ARM get far enough that the posture
 * could matter", and the nearest checkable proxy is MODEL OUTPUT ON ITS OWN STDOUT.
 *
 * ★★ MEASURED FROM THE SHIPPED ADAPTERS, and the NEGATIVE direction was measured too —
 * that is the half v4 missed:
 *
 *   claude_local
 *     * `{"type":"assistant","message":{"content":[…]}}` — the model's own message.
 *       `packages/adapters/claude-local/src/server/parse.ts:25-37` reads exactly
 *       `event.message.content`'s blocks off this event.
 *     * `{"type":"result",…,"usage":{"output_tokens":N}}` with `is_error !== true` — a
 *       BILLED turn (`parse.ts:40-64`). ★ THE `is_error` GUARD IS NOT DECORATION: the same
 *       adapter records at `parse.ts:127-128` that a revoked-token run returns
 *       `{"subtype":"success","is_error":true,"api_error_status":401,…}`. A `result` event
 *       IS emitted when no model was ever reached, so `result` alone would re-open v4.
 *
 *   codex_local
 *     * `{"type":"item.completed","item":{"type":"agent_message"|"reasoning","text":…}}` —
 *       model-authored text (`packages/adapters/codex-local/src/server/parse.ts:189-201`).
 *     * `{"type":"turn.completed","usage":{"output_tokens":N}}` — a billed turn (`:229-235`).
 *     * ★ NEITHER `thread.started` NOR `turn.started` COUNTS. Those two ARE the v4 defect in
 *       stream form.
 *
 * ★ TWO STRENGTHS, REPORTED SEPARATELY BECAUSE THEY ARE NOT EQUAL. `billed-usage` is a
 * token count that cannot exist without a completed round trip. `model-authored-content` is
 * text the CLI ATTRIBUTES to the model, which a future CLI could in principle synthesise
 * locally on a transport failure. The verdict names which one fired so a reader can weigh it.
 */
export const MODEL_CONTACT_EVIDENCE = Object.freeze({
  claude_local: Object.freeze({
    describe: "claude's `assistant` message event, or a non-error `result` event reporting billed output tokens",
    /** @param {Record<string, unknown>} event */
    detect(event) {
      if (event.type === "assistant") {
        const message = event.message;
        const content = message && typeof message === "object" && !Array.isArray(message) ? message.content : undefined;
        if (Array.isArray(content) && content.length > 0) {
          return { kind: "model-authored-content", note: "an `assistant` event carrying a non-empty message.content" };
        }
      }
      if (event.type === "result" && event.is_error !== true) {
        const usage = event.usage;
        const out = usage && typeof usage === "object" && !Array.isArray(usage) ? usage.output_tokens : undefined;
        if (typeof out === "number" && out > 0) {
          return { kind: "billed-usage", note: `a non-error \`result\` event reporting usage.output_tokens=${out}` };
        }
      }
      return null;
    },
  }),
  codex_local: Object.freeze({
    describe:
      "codex's `item.completed` carrying an `agent_message`/`reasoning` item, or a `turn.completed` reporting billed output tokens",
    /** @param {Record<string, unknown>} event */
    detect(event) {
      if (event.type === "item.completed") {
        const item = event.item;
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const itemType = item.type;
          const text = item.text;
          if (
            (itemType === "agent_message" || itemType === "reasoning") &&
            typeof text === "string" &&
            text.trim().length > 0
          ) {
            return {
              kind: "model-authored-content",
              note: `an \`item.completed\` carrying a non-empty \`${itemType}\` item`,
            };
          }
        }
      }
      if (event.type === "turn.completed") {
        const usage = event.usage;
        const out = usage && typeof usage === "object" && !Array.isArray(usage) ? usage.output_tokens : undefined;
        if (typeof out === "number" && out > 0) {
          return { kind: "billed-usage", note: `a \`turn.completed\` reporting usage.output_tokens=${out}` };
        }
      }
      return null;
    },
  }),
});

/**
 * ★★★ WHAT THE EXONERATION CANNOT SEE — WRITTEN WHERE THE VERDICT IS READ.
 *
 * This predicate is a PROXY and will still be a proxy after this repair. A limit stated
 * only in a PR body is invisible to whoever reads the verdict six months from now, so this
 * string is emitted VERBATIM into the exoneration verdict's `detail` — which is what the
 * durable record and the job summary carry — and is quoted in the runbook's verdict row,
 * with a test pinning the two together.
 *
 * It bounds the claim in four directions, each of them a real reachable case:
 *   1. REACHED ≠ TRIED. Model output does not establish that the model was given the
 *      intended prompt, understood it, or ever ATTEMPTED a write. An agent that answered
 *      and then declined for its own reasons is indistinguishable here from one that tried
 *      and was denied.
 *   2. IT IS ABOUT A2 ONLY. This branch does not gate A1, so the accompanying "A1 did not
 *      write" may itself rest on an arm that died early. The claim is narrow: ADDING THE
 *      POSTURE IS NOT SUFFICIENT. It is not "A1's negative is sound".
 *   3. THE CAPTURE BOUNDS IT. The keyed lane hands the classifier the FIRST 8000 characters
 *      of stdout (`safe(exec.stdout, 8000)`). A CLI that emitted more than that before its
 *      first model output would read as "did not reach a model" — fail-closed, so a false
 *      INCONCLUSIVE, never a false exoneration.
 *   4. `model-authored-content` IS CLI-ATTRIBUTED. A future CLI that synthesised an
 *      assistant/agent message locally on a transport failure would satisfy it. Only
 *      `billed-usage` is a round trip that cannot be produced locally.
 */
export const EXONERATION_RESIDUAL =
  'WHAT THIS VERDICT DOES NOT ESTABLISH: "A2 reached a model" is inferred from ONE stream event on A2\'s ' +
  "captured stdout. It does NOT establish that the model was given the intended prompt, that it understood the " +
  "task, or that it ever ATTEMPTED a write. It says nothing about A1, which this branch does not gate, so the " +
  'accompanying "A1 did not write" may itself rest on an arm that died early — the claim is only that ADDING THE ' +
  "POSTURE IS NOT SUFFICIENT. It is bounded by the capture (the evidence must fall within the first 8000 " +
  "characters of stdout the pack records) and, for `model-authored-content`, by the CLI's own attribution: only " +
  "`billed-usage` is a round trip that cannot be produced locally.";

/**
 * Did THIS arm's stdout show the CLI receiving OUTPUT FROM A MODEL?
 *
 * ★★ SAME FAIL-CLOSED CONTRACT AS `detectStartupEvidence`, and for a stronger reason.
 * `reached:false` means NO SUCH EVENT WAS SEEN — never "no model was reached". Absence of
 * evidence must never manufacture an exoneration; an unknown adapter, an unparseable line
 * and an empty stdout all come back false.
 *
 * @param {unknown} stdout the arm's captured stdout (already redacted by the caller)
 * @param {unknown} adapterType `"claude_local"` | `"codex_local"`
 * @returns {{reached: boolean, evidence: string, evidenceKind: string, detail: string}}
 */
export function detectModelContactEvidence(stdout, adapterType) {
  const spec = MODEL_CONTACT_EVIDENCE[adapterType];
  if (!spec) {
    return {
      reached: false,
      evidence: "",
      evidenceKind: "none",
      detail:
        `no model-contact stream event is defined for adapterType ${JSON.stringify(String(adapterType ?? ""))}, so ` +
        "this arm cannot be shown to have reached a model at all",
    };
  }
  const text = typeof stdout === "string" ? stdout : "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || !line.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const hit = spec.detect(event);
    if (hit) {
      return {
        reached: true,
        evidence: line.slice(0, 200),
        evidenceKind: hit.kind,
        detail: `${hit.note} was present on this arm's stdout (${hit.kind})`,
      };
    }
  }
  return {
    reached: false,
    evidence: "",
    evidenceKind: "none",
    detail:
      `${spec.describe} was NOT present on this arm's stdout (${text.trim().length} chars captured), so nothing ` +
      "shows this arm ever received output from a model",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2c. DOES THE RESOLVED TEMPLATE ACTUALLY CARRY THE AGENT CLIs?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two binaries `e2b/e2b.Dockerfile` PROMISES are on PATH in the CLI-bearing image.
 *
 * Its final assertion layer is, verbatim:
 *   `RUN command -v claude && command -v codex && claude --version && codex --version`
 * with the comment *"Fail the build if either CLI is not resolvable — the whole point of
 * the template."* This constant, and the script below, are that same assertion moved to
 * the one place it was never made: the lane that spends the founder's model tokens.
 */
export const TEMPLATE_CLI_BINARIES = Object.freeze(["claude", "codex"]);

/**
 * The in-sandbox script whose output `evaluateTemplateCliPreflight` reads.
 *
 * ★ IT PRINTS A POSITIVE MARKER PER BINARY, NOT JUST FAILURES. A script that printed only
 * what is missing would make "nothing was printed" — a script that never ran, a shell that
 * died, a truncated capture — indistinguishable from "both are present", which is this
 * programme's [[checks-that-nothing-runs]] class exactly. Every binary must be explicitly
 * accounted for or the preflight refuses.
 */
export const TEMPLATE_CLI_PROBE_SCRIPT =
  'for b in claude codex; do if command -v "$b" >/dev/null 2>&1; ' +
  'then echo "W7U1_HAVE:$b"; else echo "W7U1_MISSING:$b"; fi; done';

export const TEMPLATE_CLI_HAVE_PREFIX = "W7U1_HAVE:";
export const TEMPLATE_CLI_MISSING_PREFIX = "W7U1_MISSING:";

/**
 * Probe T — the lane-time template precondition, evaluated BEFORE any model tokens.
 *
 * ★★★ E7-F022 NAMED THIS FIX AND NOBODY HAD BUILT IT. That finding's own owner paragraph
 * says the remedy is *"a boot-time or lane-time assertion that the registered template
 * contains what the Dockerfile promises"*, and measured why: `E2B_TEMPLATE` silently
 * defaults to the bare `base` image on the sibling keyed lanes, so *"a keyed run against
 * bare `base` can be reported green while the CLIs were never present"*. This lane already
 * corrects an OMITTED input to `aoa-base` (`resolveTemplate`) — but a NAME is not a
 * FILESYSTEM. An operator can dispatch any alias, an account can hold a stale build of
 * `aoa-base`, and either way the pack would install its own CLI over the top and answer as
 * if the image had been the one the Dockerfile describes.
 *
 * ★★ IT IS A THREE-STATE VERDICT LIKE EVERY OTHER PROBE, NOT A THROW. A failed precondition
 * is `inconclusive` — "the apparatus was not in a state to answer; run me again" — which is
 * the only state that reds this lane. It is emitted into the durable record beside the
 * others, so a green run carries POSITIVE evidence that the image was checked rather than
 * the silence of a check nobody can see.
 *
 * @param {{channel?: string, exitCode?: number|null, stdout?: unknown, template?: unknown}} [obs]
 * @returns {{probe: string, state: string, reason: string, detail: string}}
 */
export function evaluateTemplateCliPreflight(obs = {}) {
  const { channel, exitCode, stdout, template } = obs;
  const named = typeof template === "string" && template.length > 0 ? template : "(unnamed)";
  const line = (state, reason, detail) => ({ probe: "T", state, reason, detail });

  if (channel !== "returned") {
    return line(
      "inconclusive",
      "template-preflight-did-not-run",
      `the CLI-presence check did not reach a terminal in template "${named}" (channel=${String(channel)}). ` +
        "Nothing is established about what the image carries, so probe A must not spend model tokens against it.",
    );
  }

  const text = typeof stdout === "string" ? stdout : "";
  const missing = [];
  const unreadable = [];
  const present = [];
  for (const bin of TEMPLATE_CLI_BINARIES) {
    // ★ EXPLICIT PRESENCE IS REQUIRED. "no MISSING line" is NOT presence.
    if (text.includes(`${TEMPLATE_CLI_HAVE_PREFIX}${bin}`)) present.push(bin);
    else if (text.includes(`${TEMPLATE_CLI_MISSING_PREFIX}${bin}`)) missing.push(bin);
    else unreadable.push(bin);
  }

  if (missing.length > 0) {
    return line(
      "inconclusive",
      "template-does-not-carry-the-agent-clis",
      `template "${named}" does NOT carry ${missing.join(" + ")} on PATH` +
        (unreadable.length > 0 ? ` (and said nothing at all about ${unreadable.join(" + ")})` : "") +
        `. e2b/e2b.Dockerfile's final layer asserts \`command -v claude && command -v codex\` for the CLI-bearing ` +
        `alias "${CLI_BEARING_TEMPLATE_ALIAS}", so this image is not the one the pack's question is about ` +
        // ★★★ THIS SENTENCE USED TO READ "Probe A was NOT run and NO model tokens were spent."
        // IT WAS FALSE FROM THE MOMENT THE PREFLIGHT GATE BECAME A CAVEAT: probe A now RUNS
        // on an uncertified image (it installs its own CLI), and this detail is INTERPOLATED
        // INTO PROBE A'S OWN ANSWER by `probeAPreflightCaveat` — so the durable record
        // carried "probe A was NOT run" appended to probe A's result. The keyed test that
        // banned the phrase could not see it: it drove the caveat with a SYNTHETIC verdict
        // whose detail was the string "d". It is now driven by this function.
        "(E7-F022). Probe A RUNS ANYWAY — it installs its own CLI and does not depend on the image " +
        "carrying one — so its answer stands, measured in an image whose pre-baked CLIs were not " +
        `confirmed. Re-dispatch with \`e2b_template: ${CLI_BEARING_TEMPLATE_ALIAS}\`, or rebuild that ` +
        "template on this account, then re-run to remove the caveat.",
    );
  }
  if (unreadable.length > 0) {
    return line(
      "inconclusive",
      "template-preflight-unreadable",
      `the CLI-presence check returned (exit=${String(exitCode)}) but said nothing about ${unreadable.join(" + ")} ` +
        `in template "${named}": ${JSON.stringify(text.slice(0, 200))}. Presence is NOT inferred from the absence ` +
        "of a MISSING line, so nothing is established and probe A was not run.",
    );
  }
  return line(
    "yes",
    "template-carries-the-agent-clis",
    `template "${named}" carries ${present.join(" + ")} on PATH — the same assertion e2b/e2b.Dockerfile's final ` +
      "layer makes at build time, re-made here against the image that actually answered.",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ONE ARM OF PROBE A
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An arm's outcome, kept SEPARATE from the file result on purpose.
 *
 * "no file", "hung", and "exited 127" are three different answers with three different
 * consequences, and a probe that collapses them into `false` has thrown away the part
 * the reader needs. `state` is the capability answer; `cause` is why.
 *
 *   "wrote"          — the target file exists AND carries this arm's nonce
 *   "did-not-write"  — the arm reached a terminal and the file is absent (or empty of
 *                      the nonce) — a genuine negative
 *   "indeterminate"  — nothing can be read from this arm: the binary was not runnable,
 *                      the target path already existed, SOMETHING ELSE wrote content we
 *                      did not ask for, or ★ THE CLI REFUSED BEFORE IT PRODUCED A BYTE
 *                      (`cli-refused-at-startup`, E7-F028)
 *
 * Every arm additionally carries TWO independent pieces of progress evidence, and they are
 * deliberately not one field:
 *   `ran`          — its stdout showed the CLI's OWN head event (`detectStartupEvidence`).
 *   `reachedModel` — its stdout showed OUTPUT FROM A MODEL (`detectModelContactEvidence`).
 * Both are separate from `state` because a `did-not-write` arm can be a CLI that never
 * started (the collapse E7-F028 measured) OR a CLI that started and died before any model
 * (the collapse that survived E7-F028's fix — see MODEL_CONTACT_EVIDENCE, v4).
 */
export function classifyProbeAArm(arm) {
  const { label, targetPreExisted, execution, file, nonce, adapterType } = arm;
  // ★★★ EVERY ARM CARRIES ITS OWN "DID IT START" EVIDENCE, WHATEVER ITS STATE. The
  // exoneration branch of `verdictProbeA` consumes it, and it must be present on a
  // `did-not-write` arm as well as an `indeterminate` one — the whole defect E7-F028
  // measured is that a `did-not-write` arm can be a CLI that never ran.
  const startup = detectStartupEvidence(execution?.stdout, adapterType);
  // ★★★ AND ITS OWN "DID IT REACH A MODEL" EVIDENCE, WHICH IS A DIFFERENT QUESTION.
  // `ran` answers "did the CLI start"; `reachedModel` answers "did it get far enough that
  // the permission posture could matter". Keeping them SEPARATE is the point: they were
  // conflated once (v4 of the exoneration predicate — see MODEL_CONTACT_EVIDENCE) and an
  // arm that starts and then dies on a 401 satisfies the first and refutes the second.
  const contact = detectModelContactEvidence(execution?.stdout, adapterType);
  const at = (state, cause, detail) => ({
    label,
    state,
    cause,
    detail: detail ?? "",
    ran: startup.ran,
    runEvidence: startup.evidence,
    runEvidenceDetail: startup.detail,
    reachedModel: contact.reached,
    modelEvidence: contact.evidence,
    modelEvidenceKind: contact.evidenceKind,
    modelEvidenceDetail: contact.detail,
  });

  if (targetPreExisted === true) {
    return at(
      "indeterminate",
      "target-path-already-existed",
      "the arm's target path was present BEFORE the arm ran, so a file found afterwards attributes to nothing",
    );
  }

  // ★★★ A FAULTED READ IS NOT AN ABSENT FILE, AND IT IS CHECKED BEFORE ANYTHING ELSE.
  // See READ_ERROR_KINDS. Everything below this line reasons about a file that is
  // present or genuinely absent; a read that FAILED establishes neither, and folding it
  // into "absent" is how an infrastructure fault gets printed as
  // "the agent did not write". The exec channel cannot stand in for this: a read fault
  // occurring during A1's readback is later than A0's success and outside its scope.
  if (file?.errorKind === "faulted") {
    return at(
      "indeterminate",
      "read-faulted",
      `the arm's target path could not be READ (a fault, not a genuine "no such file"): ${String(file?.detail ?? "")}. ` +
        "Nothing may be concluded about whether the agent wrote; re-run.",
    );
  }

  const found = file?.found === true;
  const content = typeof file?.content === "string" ? file.content : "";
  const carriesNonce = found && typeof nonce === "string" && nonce.length > 0 && content.includes(nonce);

  if (found && !carriesNonce) {
    // Something wrote at the path we watched, but not what we asked for. That is not a
    // capability answer; it is a broken attribution — E7-F020's class, one layer down.
    return at(
      "indeterminate",
      "file-present-without-the-nonce",
      "a file exists at the target path but does not contain this arm's nonce; nothing may be attributed to the agent",
    );
  }
  if (carriesNonce) return at("wrote", "nonce-present", "");

  // No file. WHY there is no file decides whether this is a measurement or a miss.
  const channel = execution?.channel;
  if (channel === "not-run") {
    return at("indeterminate", "arm-did-not-run", String(execution?.detail ?? ""));
  }
  if (channel === "binary-missing" || execution?.exitCode === 127) {
    return at(
      "indeterminate",
      "binary-not-runnable",
      "the CLI exited 127 (command not found) or was never installed — the experiment did not happen",
    );
  }
  if (channel === "threw") {
    // ★ A FAULT IS NOT A NEGATIVE RESULT. Against real E2B a non-zero exit comes back
    // as a RESULT (E7-F014's conversion) and a genuine sandbox/transport fault still
    // THROWS. Reading a throw as "the agent did not write" would manufacture a
    // capability answer out of an infrastructure failure — the same mistake, one layer
    // up, that E7-F014's fix refused to make in the other direction.
    return at("indeterminate", "arm-faulted", String(execution?.detail ?? ""));
  }
  if (channel === "timedOut") {
    return at(
      "did-not-write",
      "stalled",
      "the invocation did not terminate within its budget and no file appeared — the shape a permission gate takes in --print mode",
    );
  }

  // ★★★ A REFUSAL IS NOT A RESULT. E7-F028: this function's catch-all used to map EVERY
  // non-zero exit to `did-not-write`, so "the CLI refused before it ever reached a model"
  // was recorded as the agent's answer. It is not hypothetical — run 34087197668's codex
  // A1 exited 1 with `stdout=""` and the stderr
  // `"Not inside a trusted directory and --skip-git-repo-check was not specified."`,
  // and the pack booked it as a capability measurement and stayed GREEN.
  //
  // ★★ THE TEST IS EMPTY STDOUT, NOT "no startup event", AND THE TWO ARE KEPT SEPARATE ON
  // PURPOSE. A CLI that produced no bytes at all before a non-zero exit did not get far
  // enough to say anything — that is an apparatus-level miss whatever the reason. The
  // richer question ("did it demonstrably START?") rides `ran`, is computed for every arm
  // above, and is consumed by `verdictProbeA`'s exoneration branch. Folding the two into
  // one test would let a fix to either silently satisfy the other.
  const stdoutText = typeof execution?.stdout === "string" ? execution.stdout : "";
  const exitCode = execution?.exitCode;
  if (channel === "returned" && typeof exitCode === "number" && exitCode !== 0 && stdoutText.trim().length === 0) {
    return at(
      "indeterminate",
      "cli-refused-at-startup",
      `the CLI exited ${String(exitCode)} having written NOTHING to stdout, so it never reached the point of doing ` +
        "or declining the work. That is an apparatus-level miss, not a capability answer: read this arm's stderr in " +
        "the job log for the refusal it named.",
    );
  }

  return at("did-not-write", `exited-${String(execution?.exitCode ?? "unknown")}`, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. PROBE A's VERDICT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probe A: can the production argv write a file?
 *
 * ★ THE CONTROLS GATE THE MEASUREMENT, AND THEY GATE IT FIRST. A bare "no file" is
 * useless because three different causes produce it — the write/read path is broken,
 * the agent could not run, or the agent genuinely cannot write. So:
 *
 *   A0 HARNESS CONTROL     write the same shape of file at the same shape of path by
 *                          PLAIN SHELL, and read it back. If A0 fails, nothing in A
 *                          means anything: the failure is in the probe.
 *   A1 THE QUESTION        production argv, no permission posture.
 *   A2 THE DIFFERENTIAL    the same prompt TEMPLATE and the same sandbox, posture ADDED.
 *                          A1's and A2's prompts are not byte-identical: each names its
 *                          OWN target path and OWN nonce, for exactly the reason A0 needs
 *                          its own path — a file one arm left behind must never read back
 *                          as another arm's success. Those two lines are the arms' identity,
 *                          not a second experimental variable, and the posture flag remains
 *                          the only thing that differs about HOW the agent is invoked.
 *   A3 NEGATIVE CONTROL    a prompt that instructs the agent NOT to write. If a file
 *                          appears anyway, something other than the agent is writing at
 *                          that path and probe A can attribute nothing (E7-F020's class).
 *
 * ★★ A0 CANNOT USE A1's EXACT PATH, and pretending otherwise would poison the
 * measurement: a file A0 left behind would be read back as A1's success. Each arm gets
 * its own path of the SAME SHAPE in the SAME DIRECTORY, written and read through the
 * SAME transport calls, and every arm additionally asserts its own path is ABSENT
 * before it runs (`targetPreExisted`). That is what makes the arms independent.
 */
export function verdictProbeA(arms) {
  const { a0, a1, a2, a3 } = arms;
  const line = (state, reason, detail) => ({ probe: "A", state, reason, detail: detail ?? "" });

  if (!a0 || a0.state !== "wrote") {
    return line(
      "inconclusive",
      "harness-control-failed",
      `A0 (plain shell writes and we read it back) did not succeed: ${a0 ? `${a0.state}/${a0.cause}` : "missing"}. ` +
        "The write+read path is not proven, so A1's empty result attributes to nothing. Fix the probe, then re-run.",
    );
  }
  if (a3 && a3.state === "wrote") {
    return line(
      "inconclusive",
      "negative-control-violated",
      "A3 asked the agent NOT to write and a file carrying A3's nonce appeared anyway. Something other than the " +
        "agent is writing at the watched path; no arm of probe A may be attributed to the agent.",
    );
  }
  if (!a1) return line("inconclusive", "a1-missing", "the question arm produced no record at all");
  if (a1.state === "indeterminate") {
    return line(
      "inconclusive",
      `a1-${a1.cause}`,
      `A1 could not be read: ${a1.detail || a1.cause}. The production argv was not exercised.`,
    );
  }
  if (a1.state === "wrote") {
    const a2note =
      a2 && a2.state === "wrote"
        ? "A2 (posture added) also wrote, as expected."
        : `A2 (posture added) did NOT write (${a2 ? `${a2.state}/${a2.cause}` : "missing"}) — unexpected, and worth a look.`;
    return line(
      "yes",
      "a1-wrote-under-production-argv",
      `The EXACT production argv, with NO permission posture, produced the requested file. ${a2note}`,
    );
  }

  // A1 did not write. The question is now whether the missing posture is the cause.
  if (a2 && a2.state === "wrote") {
    return line(
      "no",
      "a1-did-not-write-and-the-posture-is-the-cause",
      `A1 (production argv) did not write (${a1.cause}); A2 (the same prompt template — differing only in the two ` +
        `lines naming its own target path and nonce, as arm separation requires — with the permission posture added) DID. ` +
        "The absent permission flag is the cause. That is a PRODUCT finding about " +
        "task-run-sandbox-invocation.ts's four script literals, not merely an input to a later ticket.",
    );
  }
  if (a2 && a2.state === "did-not-write") {
    // ★★★ THE EXONERATION BRANCH REQUIRES POSITIVE EVIDENCE THAT A2 REACHED A MODEL, AND IT
    // IS THE ONLY BRANCH THAT REQUIRES ANYTHING. This is the one verdict in the whole pack
    // that asserts a NEGATIVE about a cause — "the posture is not it" — from two arms that
    // each produced nothing. Two silences do not exonerate a variable; they are consistent
    // with an agent that never got near the question, in which case the posture was never
    // tested at all. E7-F028 measured exactly that outcome on a founder-authorised run and
    // the lane stayed green, because a fourth-state situation had been folded into `no`,
    // which is a RESULT.
    //
    // ★★ THE EVIDENCE IS A2's, AND IT IS "REACHED A MODEL", NOT "STARTED". Both halves of
    // that sentence are corrections of a predicate that shipped wrong:
    //
    //   * A2, NOT "some arm". Only A2 carries the posture. A1 running says nothing about
    //     whether a posture-only fix would have helped, so a gate A1 can satisfy is a gate
    //     on the wrong arm.
    //   * REACHED A MODEL, NOT STARTED. `ran` comes from the HEAD event alone, so two arms
    //     that start and then show no model-contact evidence still satisfy it — the exact
    //     shape codex A2 produced in run 34087197668 (`thread.started`, `turn.started`, then
    //     FOUR `Reconnecting… N/5` 401 lines, 2/5 through 5/5). ★ THAT IS A STATEMENT ABOUT
    //     THE RECORD: the run preserved EXACTLY 900 characters of A2's stdout and they end mid-token
    //     at `{"type":"i`, so "A2 reached nothing" is NOT established — only that no
    //     model-contact evidence was present in what was preserved. `reachedModel` requires
    //     model OUTPUT on A2's own stdout, and its absence yields `inconclusive`, not a
    //     finding about the agent.
    //
    // See MODEL_CONTACT_EVIDENCE for the full v1→v4 cascade and the per-CLI shapes, and
    // EXONERATION_RESIDUAL — emitted verbatim below — for what this still cannot see.
    //
    // ★★ FAIL-CLOSED ON MISSING EVIDENCE. An arm with no such event — including one
    // classified by an older caller that never passed stdout — counts as NOT SHOWN TO HAVE
    // REACHED A MODEL. Absence of evidence must never manufacture an exoneration; that is
    // the same error as reading a policy back from `getInfo()` and calling it enforced.
    //
    // ★ THE CONVICTION BRANCH ABOVE NEEDS NO SUCH GATE: A2 WROTE, which is stronger proof
    // than any stream event, and the differential is then a real one.
    if (a2.reachedModel !== true) {
      return line(
        "inconclusive",
        "posture-exoneration-unsupported-a2-did-not-reach-a-model",
        `Neither A1 (${a1.cause}) nor A2 (${a2.cause}) produced the file, and A2 — the ONLY arm carrying the ` +
          `permission posture — cannot be shown to have reached a model: ` +
          `${String(a2.modelEvidenceDetail ?? "no model-contact evidence recorded")}. ` +
          `(A2 startup evidence: ${String(a2.runEvidenceDetail ?? "none recorded")}. ` +
          `A1: ${String(a1.modelEvidenceDetail ?? "no model-contact evidence recorded")}.) ` +
          "An arm that started and then died before any model output leaves the posture UNTESTED, so it may not be " +
          "exonerated. Read both arms' stderr in the job log, then re-run with the blocker removed.",
      );
    }
    return line(
      "no",
      "a1-did-not-write-and-the-posture-is-not-the-cause",
      `Neither A1 (${a1.cause}) nor A2 (${a2.cause}) produced the file, and A2 — the arm carrying the permission ` +
        `posture — demonstrably REACHED A MODEL (${a2.modelEvidenceDetail}). Adding the permission posture does ` +
        "NOT make the agent able to write here; something else is in the way, and a posture-only fix would not " +
        `have helped. ${EXONERATION_RESIDUAL}`,
    );
  }
  return line(
    "no",
    "a1-did-not-write-cause-unattributed",
    `A1 did not write (${a1.cause}) and A2 could not be read (${a2 ? `${a2.state}/${a2.cause}` : "missing"}), so the ` +
      "permission posture is neither convicted nor exonerated. The NO is sound; the CAUSE is not established.",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. PROBE B — is the TEMPLATE already satisfying a location convention?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probe B: read the candidate output paths out of a freshly created sandbox BEFORE any
 * exec, and enumerate what is actually there.
 *
 * ★ WHY THIS IS A POSITIVE CONTROL NOBODY PROPOSED. Every location-based output
 * convention — "the run's output is whatever is at path P" — is satisfiable by ANY
 * writer of P, and the template is a writer no protocol surface can see. If the
 * template pre-fills a candidate path, then a convention anchored there is satisfied
 * with no agent, no worker and no output: exactly E7-F020's class, with an input that
 * is invisible from the wire.
 *
 * ★★ IT ENUMERATES, IT DOES NOT ASK. "Does file X exist" answers one path; a listing
 * answers the question that matters — WHAT is there — including the file nobody thought
 * to name. `entries` is the listing; `candidates` is the subset we care about.
 */
export function verdictProbeB(observation) {
  const { listingOk, entries, candidates } = observation ?? {};
  if (listingOk !== true) {
    return {
      probe: "B",
      state: "inconclusive",
      reason: "enumeration-failed",
      detail: `the candidate directories could not be enumerated: ${String(observation?.detail ?? "no detail")}`,
    };
  }
  const prefilled = (candidates ?? []).filter((c) => c.exists === true);
  if (prefilled.length > 0) {
    return {
      probe: "B",
      state: "yes",
      reason: "template-prefills-a-candidate-output-path",
      detail:
        `${prefilled.length} candidate output path(s) EXIST in a fresh sandbox before any exec: ` +
        `${prefilled.map((c) => `${c.path} (${c.bytes} bytes)`).join(", ")}. ` +
        "A location-based output convention anchored at these is satisfiable by the template alone.",
    };
  }
  // ★★★ A CANDIDATE WHOSE READ FAULTED IS NOT A CANDIDATE THAT IS ABSENT. Each candidate
  // is read with the same `readBack` probe A uses, so each carries the same
  // `errorKind` (READ_ERROR_KINDS). Counting a faulted read as `exists:false` would feed
  // the "template-prefills-nothing" NO with a path nobody actually looked at.
  //
  // ★★ THIS GATES THE NEGATIVE ONLY, AND DELIBERATELY SO. It sits AFTER the
  // `prefills-a-candidate` branch because that branch is an OBSERVED POSITIVE — a path
  // that was read and found to exist — and an unread NEIGHBOUR cannot unmake it.
  // `inconclusive` means "run me again"; a confirmed prefill is not made truer by a
  // second run. It is the NO, which asserts something about paths we did not see, that
  // an unread path invalidates.
  const faultedReads = (candidates ?? []).filter((c) => c.errorKind === "faulted");
  if (faultedReads.length > 0) {
    return {
      probe: "B",
      state: "inconclusive",
      reason: "candidate-read-faulted",
      detail:
        `${faultedReads.length} candidate output path(s) could not be READ (a fault, not a genuine "no such file"): ` +
        `${faultedReads.map((c) => `${c.path} (${String(c.detail ?? "no detail")})`).join(", ")}. ` +
        "Their absence is NOT established, so `template-prefills-nothing` may not be claimed. Re-run.",
    };
  }

  return {
    probe: "B",
    state: "no",
    reason: "template-prefills-nothing",
    detail:
      `none of the ${(candidates ?? []).length} candidate output paths exist in a fresh sandbox. ` +
      `Directory listing (${(entries ?? []).length} entries): ${(entries ?? []).join(" ") || "(empty)"}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. PROBE C — does the stream handler deliver from real E2B?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probe C: re-run the CLI-003/D1 streaming case against real E2B and record it either
 * way.
 *
 * ★ THE BRIEF'S PREMISE IS STALE AND THIS UNIT CORRECTS IT RATHER THAN INHERITING IT.
 * The brief says "the only real-E2B run of that case FAILED (stdout empty) and the
 * re-fire is queued". The re-fire HAPPENED — three times. `keyed-e2b-conformance.yml`
 * runs 32211821459 (2026-08-19), 32995765059 (2026-08-26) and 33788025048 (2026-09-03)
 * all completed `success`, and the last one's log names the case explicitly:
 * "CLI-003/D4 … success: a real command streams stdout/stderr chunks and exits 0 …
 * 495ms", inside "Tests 19 passed (19)". The stale line is
 * `CLI-realE2B-hardening-result.md`'s status field, which still reads "keyed re-fire
 * queued". Probe C is kept anyway — one authorised run should answer all three
 * questions, and a re-measurement that agrees is cheap — but it is a CONFIRMATION, not
 * an open question, and this pack says so.
 */
export function verdictProbeC(observation) {
  const { ran, exitCode, stdout, stderr, stdoutMarker, stderrMarker } = observation ?? {};
  if (ran !== true) {
    return {
      probe: "C",
      state: "inconclusive",
      reason: "case-did-not-run",
      detail: `the streaming command never produced a terminal: ${String(observation?.detail ?? "no detail")}`,
    };
  }
  const gotOut = typeof stdout === "string" && stdoutMarker ? stdout.includes(stdoutMarker) : false;
  const gotErr = typeof stderr === "string" && stderrMarker ? stderr.includes(stderrMarker) : false;
  if (gotOut && gotErr && exitCode === 0) {
    return {
      probe: "C",
      state: "yes",
      reason: "both-streams-delivered",
      detail: "onStdout and onStderr each received their marker from a real E2B sandbox, and the command exited 0.",
    };
  }
  return {
    probe: "C",
    state: "no",
    reason: "stream-delivery-incomplete",
    detail:
      `exitCode=${String(exitCode)} stdoutMarkerSeen=${String(gotOut)} stderrMarkerSeen=${String(gotErr)}. ` +
      "The command reached a terminal but the stream handlers did not deliver both markers.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE PACK'S OVERALL DISPOSITION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the LANE should terminate, given the probes' verdicts.
 *
 * ★★★ A `no` KEEPS THE LANE GREEN. This is the whole point of the unit: if the only way
 * for the pack to finish green were for the agent to write a file, then "the agent
 * cannot write" would arrive as a red build, indistinguishable from a broken key, a
 * template change or an outage — and the founder's one authorised run would have bought
 * an ambiguity. `inconclusive` is the ONLY state that reds, because it is the only one
 * that means "the apparatus did not answer; run me again".
 *
 * `skipped` is separate again: no key, no result, nothing claimed. The workflow's own
 * positive-control step is what stops a silent skip from reading as success.
 */
export function packDisposition(verdicts) {
  const list = (verdicts ?? []).filter(Boolean);
  if (list.length === 0) {
    return { exitCode: 1, disposition: "inconclusive", detail: "no probe produced a verdict at all" };
  }
  const bad = list.filter((v) => v.state === "inconclusive");
  if (bad.length > 0) {
    return {
      exitCode: 1,
      disposition: "inconclusive",
      detail: `inconclusive probes: ${bad.map((v) => `${v.probe} (${v.reason})`).join("; ")}`,
    };
  }
  return {
    exitCode: 0,
    disposition: "measured",
    detail: list.map((v) => `${v.probe}=${v.state}`).join(" "),
  };
}

/** Human-readable one-liner per verdict, for the log and the job summary. */
export function formatVerdict(v) {
  return `PROBE ${v.probe}: ${v.state.toUpperCase()} — ${v.reason}\n    ${v.detail}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. THE DURABLE RECORD — the run's answer must survive the job log
// ─────────────────────────────────────────────────────────────────────────────

/** The record's shape identifier, so a later reader can tell what it is holding. */
export const PROBE_RECORD_SCHEMA = "aoa.w7u1.output-probe-record/2";

/**
 * How much of an arm's stdout the CLASSIFIER reads, and — because it is the same constant —
 * how much the DURABLE RECORD preserves.
 *
 * ★★★ THIS CONSTANT EXISTS BECAUSE THE TWO NUMBERS DIVERGED AND A VERDICT BECAME
 * UNAUDITABLE. In run `34087197668` the keyed pack logged `safe(exec.stdout, 900)` to the
 * console and handed `safe(exec.stdout, 8000)` to the classifier, and the record carried NO
 * stdout at all. The consequence is measurable in that run's job log: it contains ZERO
 * instances of `assistant`, `output_tokens`, `agent_message` or `turn.completed` — none of
 * the four shapes the model-contact predicate looks for — INCLUDING for the claude arms that
 * demonstrably did reach a model. So no verdict from that run can be checked against its own
 * record, and six sentences in this repo went on to assert more about codex A2 than the 900 preserved characters could support.
 *
 * ★★ WHY EXACTLY WHAT THE CLASSIFIER CONSUMED, AND NOT MORE. The record's job is to let a
 * later reader re-derive the verdict. The classifier cannot see past this limit, so a record
 * carrying exactly this much is COMPLETE for that purpose: every byte the verdict could have
 * turned on is in it. Bytes beyond it would enlarge a public (redacted) artefact while
 * auditing nothing. Bytes below it — any value at all below it — reintroduce the defect.
 *
 * ★ THE CONSOLE LINE IS DELIBERATELY LEFT SHORTER. A 900-character console line is a
 * reasonable console line; the fix is not to make the log bigger but to stop treating the log
 * as the record. See the runbook: THE RECORD IS THE AUDITABLE ARTEFACT, THE CONSOLE IS NOT.
 */
export const CLASSIFIER_STDOUT_LIMIT = 8000;

/** Raised when a record would be written that cannot be interpreted later. */
export class ProbeRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProbeRecordError";
  }
}

/**
 * Build the structured record the keyed run leaves behind.
 *
 * ★★★ THE VERDICT MUST NOT LIVE ONLY IN A JOB LOG. E7-F025 measured this programme's own
 * instance of the failure: the sibling keyed lane ALREADY FIRED TWICE (re-fires #3 on
 * 2026-08-19 and #4 on 2026-08-26, per `.github/keyed-e2b-trigger`) and NO document in the
 * repo records either outcome, so the honest state of that measurement is "fired and
 * unrecorded" and the next session re-asks the question. A pack that prints its verdict and
 * nothing else loses the founder's ONE authorised run exactly the same way.
 *
 * ★★ A RECORD THAT OMITS WHICH TEMPLATE ANSWERED CANNOT BE INTERPRETED LATER. E7-F022
 * measured that the template is an operator input invisible to every protocol surface, and
 * that a keyed run against bare `base` "can be reported green while the CLIs were never
 * present". So the resolved template id — and HOW it was resolved — is a required field,
 * and this function REFUSES rather than writing a record without it.
 */
export function buildProbeRecord({
  verdicts,
  disposition,
  template,
  templateSource,
  templateNote,
  commitSha,
  runNonce,
  generatedAt,
  workflowRunUrl,
  armEvidence,
} = {}) {
  const resolvedTemplate = typeof template === "string" ? template.trim() : "";
  if (resolvedTemplate.length === 0) {
    throw new ProbeRecordError(
      "buildProbeRecord: the resolved template id is REQUIRED. A record that does not say which image " +
        "answered cannot be interpreted later (E7-F022) — refusing to write one.",
    );
  }
  const list = (verdicts ?? []).filter(Boolean);
  const d = disposition ?? packDisposition(list);
  return {
    schema: PROBE_RECORD_SCHEMA,
    generatedAt: typeof generatedAt === "string" && generatedAt.length > 0 ? generatedAt : "unknown",
    commitSha: typeof commitSha === "string" && commitSha.length > 0 ? commitSha : "unknown",
    workflowRunUrl: typeof workflowRunUrl === "string" && workflowRunUrl.length > 0 ? workflowRunUrl : "unknown",
    runNonce: typeof runNonce === "string" && runNonce.length > 0 ? runNonce : "unknown",
    template: {
      resolved: resolvedTemplate,
      source: typeof templateSource === "string" && templateSource.length > 0 ? templateSource : "unknown",
      note: typeof templateNote === "string" ? templateNote : "",
      carriesAgentClis: resolvedTemplate === CLI_BEARING_TEMPLATE_ALIAS,
    },
    disposition: { disposition: d.disposition, exitCode: d.exitCode, detail: d.detail },
    // Every probe's THREE-STATE verdict AND its reason. `state` alone is not readable a
    // month later; `reason` is the part that says what to do next.
    probes: list.map((v) => ({
      probe: String(v.probe),
      state: String(v.state),
      reason: String(v.reason),
      detail: String(v.detail ?? ""),
    })),
    // ★★★ THE STDOUT THE CLASSIFIER ACTUALLY READ, so a verdict can be re-derived from its
    // own record instead of from a job log that outlives nothing and preserved less. See
    // `CLASSIFIER_STDOUT_LIMIT` for the measured reason this field exists. `stdout` here is
    // the SAME STRING the classifier was handed — not a shorter one — and it is redacted on
    // the way out by the caller, exactly like every other string in this artefact.
    armEvidence: (armEvidence ?? []).filter(Boolean).map((a) => ({
      probe: String(a.probe ?? ""),
      label: String(a.label ?? ""),
      adapterType: String(a.adapterType ?? ""),
      posture: a.posture === true,
      channel: String(a.channel ?? ""),
      exitCode: a.exitCode === null || a.exitCode === undefined ? null : Number(a.exitCode),
      // ★ THE BOUND TRAVELS WITH THE BYTES. A reader must be able to tell "no model-contact
      // evidence in the whole of stdout" from "no model-contact evidence in the prefix the
      // classifier could see", and that difference is exactly `stdoutTruncated`.
      stdoutLimit: CLASSIFIER_STDOUT_LIMIT,
      stdoutTruncated: a.stdoutTruncated === true,
      stdout: String(a.stdout ?? ""),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. THE LANE'S OWN DURABILITY, ASSERTED AGAINST THE WORKFLOW YAML
// ─────────────────────────────────────────────────────────────────────────────
//
// ★★★ WITHOUT THIS, THE FIX ABOVE IS UNGUARDED. `buildProbeRecord` can be perfect and the
// record still never reach anyone, because whether it is uploaded — and whether it is
// uploaded on a RED run — is decided in YAML that no test reads. That is this programme's
// [[checks-that-nothing-runs]] class: the mechanism exists, nothing asserts it fires.
//
// The shape is lifted from `scripts/lib/ci-lanes.mjs`'s `uploadsEvidenceBundleOnFailure`,
// which already does exactly this for `d1-merge-train.yml`'s evidence bundle: bound the
// step block by indentation, require an `if:` naming `always()`/`failure()`, and require
// the step to reference the artefact SPECIFICALLY so a guarded upload of something else
// cannot satisfy the rule.

/** Extract the block of the step containing line `i`, bounded by indentation. */
function stepBlockAround(lines, i) {
  let start = i;
  while (start >= 0 && !/^\s*-\s/.test(lines[start])) start -= 1;
  if (start < 0) start = i;
  const stepIndent = (lines[start].match(/^(\s*)-/) || [, ""])[1].length;
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() !== "" && l.match(/^(\s*)/)[1].length <= stepIndent) break;
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

const GUARDED_IF = /(^|\n)\s*if:[^\n]*(failure\(\)|always\(\))/;

/**
 * Does the W7U1 lane leave a durable, retrievable record — on a RED run as well as a green
 * one — and does its fallback default agree with the pure core?
 *
 * @param {string} workflowText the raw YAML of `keyed-e2b-w7u1-output-probe.yml`
 * @param {{recordPathVar?: string, defaultTemplateVar?: string}} [opts]
 * @returns {{violations: {code: string, detail: string}[]}}
 */
export function evaluateDurableRecord(workflowText, opts = {}) {
  const recordPathVar = opts.recordPathVar ?? "W7U1_RECORD_PATH";
  const defaultTemplateVar = opts.defaultTemplateVar ?? "W7U1_DEFAULT_TEMPLATE";
  const text = String(workflowText ?? "");
  const lines = text.split(/\r?\n/);
  const violations = [];

  // 1 + 2. The upload step: it must exist, it must reference the record, and it must be
  // guarded so that the INCONCLUSIVE run — the one whose detail somebody will actually need
  // — is not the one whose artefact gets dropped.
  let uploadFound = false;
  let uploadGuarded = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/uses:\s*actions\/upload-artifact/.test(lines[i])) continue;
    const block = stepBlockAround(lines, i);
    const referencesRecord =
      new RegExp(`(^|\\n)\\s*path:[^\\n]*${recordPathVar}`).test(block) ||
      /(^|\n)\s*name:[^\n]*w7u1[^\n]*record/i.test(block);
    if (!referencesRecord) continue;
    uploadFound = true;
    if (GUARDED_IF.test(block)) uploadGuarded = true;
  }
  if (!uploadFound) {
    violations.push({
      code: "record-upload-missing",
      detail:
        "no `actions/upload-artifact` step uploads the W7U1 probe record. The verdict would exist only in the " +
        "job log — E7-F025's exact shape: a keyed lane that fired and left nothing behind.",
    });
  } else if (!uploadGuarded) {
    violations.push({
      code: "record-upload-unguarded",
      detail:
        "the record's `upload-artifact` step is not guarded by `if: always()` (or `failure()`), so it is SKIPPED " +
        "on a red run. An inconclusive run is precisely the run whose detail someone needs, and precisely the run " +
        "a success-gated upload throws away.",
    });
  }

  // 3. The fallback writer: if the pack never reaches its own reporting stage (a crash, a
  // failed install, a lost secret), something must still write a record saying so.
  let fallbackFound = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!new RegExp(`${recordPathVar}`).test(lines[i])) continue;
    const block = stepBlockAround(lines, i);
    if (!/(^|\n)\s*run:/.test(block)) continue;
    if (!GUARDED_IF.test(block)) continue;
    fallbackFound = true;
    break;
  }
  if (!fallbackFound) {
    violations.push({
      code: "record-fallback-missing",
      detail:
        `no \`always()\`-guarded \`run:\` step writes ${recordPathVar}. A pack that dies before its own reporting ` +
        "stage would then upload nothing at all, and the run would again be `fired and unrecorded`.",
    });
  }

  // 4. The fallback's template default is duplicated in shell (the pack itself resolves in
  // JS). Pin the two together so they cannot drift into disagreeing about which image ran.
  const declared = new RegExp(`${defaultTemplateVar}:\\s*"?([A-Za-z0-9._-]+)"?`).exec(text);
  if (!declared) {
    violations.push({
      code: "default-template-undeclared",
      detail: `the workflow declares no ${defaultTemplateVar}, so its fallback record cannot name the resolved template.`,
    });
  } else if (declared[1] !== CLI_BEARING_TEMPLATE_ALIAS) {
    violations.push({
      code: "default-template-mismatch",
      detail:
        `${defaultTemplateVar} is "${declared[1]}" but the pure core resolves an omitted input to ` +
        `"${CLI_BEARING_TEMPLATE_ALIAS}". The record and the run would name different images.`,
    });
  }

  // 5. The fallback's SCHEMA STRING is duplicated in shell too, and it drifts the same way
  // the template default would.
  //
  // ★★★ THIS CHECK IS ADDED BECAUSE THE DRIFT ALREADY HAPPENED, IN THE SAME COMMIT THAT
  // CREATED IT. Bumping `PROBE_RECORD_SCHEMA` to `/2` for `armEvidence` left this workflow's
  // heredoc emitting `/1`, so the two record producers for one lane would have disagreed
  // about the shape a reader should expect — and nothing would have said so. A schema
  // version is only useful if every writer of that schema agrees on it.
  const fallbackSchema = /"schema"\s*:\s*"([^"]+)"/.exec(text);
  if (!fallbackSchema) {
    violations.push({
      code: "fallback-schema-undeclared",
      detail:
        "the fallback record writer names no `schema`, so a reader cannot tell which record shape it produced.",
    });
  } else if (fallbackSchema[1] !== PROBE_RECORD_SCHEMA) {
    violations.push({
      code: "fallback-schema-mismatch",
      detail:
        `the fallback record declares schema "${fallbackSchema[1]}" but \`buildProbeRecord\` emits ` +
        `"${PROBE_RECORD_SCHEMA}". One lane must not ship two record shapes under two version numbers.`,
    });
  }

  return { violations };
}
