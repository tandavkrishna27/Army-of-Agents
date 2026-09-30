// server/src/services/execution-kill-switches.ts
//
// REL-004 Lane C — provider and template kill switches (clause 3a: stop new leases).
//
// A KILL SWITCH IS A DENY-LIST OVER A PLACEMENT DIMENSION, not an identity revocation.
// Three questions, deliberately not merged:
//
//   "may this device work"                -> JOB-007 `revokeExecutionTarget`, generation-fenced
//   "may work be PLACED on this provider" -> here
//   "may work RUN FROM this template"     -> here
//
// Merging them would mean killing one bad E2B template required revoking every target that
// used it — destroying enrollment state to express a policy opinion. This is the same
// separation DSK-004 drew between its version deny-list and JOB-007, for the same reason.
//
// THE ABSENT-DOCUMENT RULE DIFFERS FROM DSK-004's, AND THE DIFFERENCE IS DELIBERATE.
// DSK-004 refuses an absent deny-list, because there "absent" means a service that should
// have served the policy did not, and reading that as "nothing denied" installs a withdrawn
// build. Here the document lives in `instance_settings` — the same store as the leasing
// decision itself. If it cannot be read, the lease transaction has already failed; there is
// no separate service whose outage could quietly turn "absent" into "permitted". A read that
// FAILS is a different fact and must not arrive here as `undefined` — the caller routes it in as
// a non-plain-object sentinel so it lands on the unreadable path below. And an
// absent document is the normal steady state of every install that has never thrown a
// switch, so fail-closed would stop all work on a fresh instance.
//
// What IS fail-closed is a document that EXISTS and cannot be understood: a malformed
// entry, an unknown dimension, a missing reason. "No policy" and "unreadable policy" are
// different facts, and only the second is a reason to stop. In particular a malformed entry
// never causes the rest to be honoured and the bad one skipped — that is how a typo
// silently disables a switch an operator believes they have thrown.
//
// Pure. The caller reads `instance_settings.kill_switches` and supplies it (Lane C/D3 — a
// dedicated column, because `instanceSettingsService.updateGeneral` rewrites the `general` bag
// from a fixed field list and would erase an unknown key on the next Settings PATCH).

/**
 * The placement dimensions a switch can name. `target` is absent on purpose: it belongs to
 * JOB-007, whose revocation is generation-fenced identity surgery.
 */
export const KILL_SWITCH_DIMENSIONS = ["provider", "template"] as const;
export type KillSwitchDimension = (typeof KILL_SWITCH_DIMENSIONS)[number];

export const DOCUMENT_SCHEMA = 1;

export type KillSwitchVerdict =
  | { readonly killed: false }
  | {
      readonly killed: true;
      readonly dimension: KillSwitchDimension | null;
      readonly value: string | null;
      readonly reason: string;
    };

export interface KillSwitchInput {
  /** `instance_settings.kill_switches`, or undefined when none has ever been set. */
  readonly document: unknown;
  /** The execution target's `kind` — the provider this work would be placed on. */
  readonly provider: unknown;
  /**
   * The pinned sandbox template alias.
   *
   * `null` means DEFINITELY NONE — the worker has no pinned template, so a template switch
   * cannot apply to it. `undefined` means UNKNOWN, and is fail-closed: a caller that could
   * not determine the template must not be able to express that as "no template" and slip
   * past a switch. The distinction is the contract; do not collapse them.
   *
   * REL-004 Lane C (D2): UNKNOWN refuses only against a switch that actually NAMES the
   * template dimension. The distributed poll can never determine the template — the E2B alias
   * is pinned worker-side and no frozen protocol shape carries it — so it passes `undefined`
   * on every call. Refusing every document on that basis would mean killing one provider
   * drained the whole fleet, and a template it cannot read cannot change the verdict of a
   * provider switch anyway.
   */
  readonly template: unknown;
  /**
   * The closed placement-provider vocabulary — `execution_targets.kind`, supplied by the caller
   * so this module stays dependency-free (see `EXECUTION_TARGET_KINDS`).
   *
   * REL-004 Lane C (D6): a `provider` switch naming a value outside it is REFUSED, never read
   * as "matches nothing". `E2B` for `e2b` is the same shape of operator typo as `providers` for
   * `provider`, and it deserves the same answer. The OBSERVED provider is deliberately not
   * required to be a member: an unrecognized kind is an enrollment fault that placement
   * normalization already fails closed on, and checking it here would widen a policy decision
   * into placement validation.
   */
  readonly knownProviders: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unreadable(): KillSwitchVerdict {
  return { killed: true, dimension: null, value: null, reason: "policy_unreadable" };
}

/**
 * A switch that is perfectly well-formed but that THIS caller structurally cannot evaluate.
 *
 * Kept distinct from `unreadable()` because the operator's next move differs: `policy_unreadable`
 * sends them to the document, `placement_unknown` tells them the dimension they used cannot be
 * enforced at this seam at all. Both fail closed; only the diagnostic differs, and the drain
 * reason is the only diagnostic a worker ever sees.
 */
function unevaluatable(): KillSwitchVerdict {
  return { killed: true, dimension: null, value: null, reason: "placement_unknown" };
}

/**
 * The longest reason a switch may carry.
 *
 * Bound to the FROZEN poll response's own limit (`pollResponseV1Schema`'s drain member declares
 * `reason: z.string().max(1000).nullable()`), because the reason is the only part of a switch
 * that travels to the worker. Unbounded here, a 1001-character operator reason makes the poll's
 * `pollResponseV1Schema.parse` THROW: the route maps that to `internal_unavailable`, the daemon
 * classifies 503 as transient and merely backs off, and the kill switch silently degrades from a
 * drain into a 503 storm that never says why. Refusing the entry keeps it fail-closed AND keeps
 * it a drain.
 *
 * `execution-kill-switches.test.ts` asserts this constant against the frozen schema in both
 * directions, so the two cannot drift.
 */
export const KILL_SWITCH_MAX_REASON_LENGTH = 1000;

function isStatedReason(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= KILL_SWITCH_MAX_REASON_LENGTH;
}

/**
 * A switch entry that has passed every structural check.
 *
 * REL-004 Lane D: `reclaim` is the opt-in that separates "stop placing work here" from "destroy
 * what is already here". A plain switch is a placement deny-list and must not delete a warm
 * snapshot a human is mid-conversation with; `reclaim: true` is an operator explicitly asking for
 * the destructive act. Absent means false; anything that is not a boolean is a typo
 * (`"reclaim": "true"`) and refuses the document rather than being coerced.
 */
export interface ValidatedKillSwitch {
  readonly dimension: KillSwitchDimension;
  readonly value: string;
  readonly reason: string;
  readonly reclaim: boolean;
}

/**
 * The SINGLE parse of the kill-switch document. Both readers consume it.
 *
 * There is deliberately no second, simpler accessor. A vocabulary-free reader handed
 * `{dimension:"provider", value:"gvisor"}` — a real legacy lease-provider value that is not in
 * `EXECUTION_TARGET_KINDS` — would return a non-empty DESTROY set while leasing refuses the very
 * same document as unreadable. Two readings of one document must never disagree about whether
 * that document can be read at all; they may only differ in what they do about it.
 */
export function parseKillSwitchDocument(
  document: unknown,
  knownProviders: unknown,
): "absent" | "unreadable" | readonly ValidatedKillSwitch[] {
  // Absent is the steady state, not a failure. See the header for why this differs from
  // DSK-004's rule rather than contradicting it.
  if (document === undefined || document === null) return "absent";

  if (!isPlainObject(document)) return "unreadable";
  if (document.schema !== DOCUMENT_SCHEMA) return "unreadable";
  if (!Array.isArray(document.switches)) return "unreadable";
  // The vocabulary is required whenever a document exists: without it a mistyped provider value
  // cannot be told apart from a real one, which is the whole point of D6.
  if (!Array.isArray(knownProviders) || knownProviders.length === 0
      || knownProviders.some((kind) => typeof kind !== "string" || kind.length === 0)) {
    return "unreadable";
  }
  const providerVocabulary = knownProviders as readonly string[];

  const parsed: ValidatedKillSwitch[] = [];
  for (const entry of document.switches) {
    if (!isPlainObject(entry)) return "unreadable";
    const { dimension, value, reason, reclaim } = entry;
    // An unknown dimension is refused rather than ignored: `providers` for `provider` is
    // exactly the shape of an operator typo, and ignoring it means the switch they just
    // threw does nothing at all.
    if (typeof dimension !== "string"
        || !(KILL_SWITCH_DIMENSIONS as readonly string[]).includes(dimension)) {
      return "unreadable";
    }
    if (typeof value !== "string" || value.length === 0) return "unreadable";
    // A kill switch stops other people's work; why it was thrown is not decoration.
    if (!isStatedReason(reason)) return "unreadable";
    if (reclaim !== undefined && typeof reclaim !== "boolean") return "unreadable";
    // D6 — a provider value outside the closed vocabulary is a typo, not a miss.
    if (dimension === "provider" && !providerVocabulary.includes(value)) return "unreadable";
    parsed.push({
      dimension: dimension as KillSwitchDimension,
      value,
      reason,
      reclaim: reclaim === true,
    });
  }
  return parsed;
}

/**
 * An operator's requested switch, before validation. The writer hands these to
 * {@link buildKillSwitchDocument}, which validates them against the reader's contract.
 */
export interface KillSwitchWriteEntry {
  readonly dimension: string;
  readonly value: string;
  readonly reason: string;
  readonly reclaim?: boolean;
}

/** A kill-switch document {@link parseKillSwitchDocument} accepts (readable, never `unreadable`). */
export interface KillSwitchDocument {
  readonly schema: typeof DOCUMENT_SCHEMA;
  readonly switches: readonly ValidatedKillSwitch[];
}

/**
 * Build a kill-switch document the readers will accept, or THROW.
 *
 * ★ FAIL-CLOSED SAFETY. A persisted document `parseKillSwitchDocument` cannot read drains EVERY
 * fleet (`policy_unreadable` -> drain). So the writer must never persist a document the reader
 * would reject. This builder validates the operator's input by round-tripping it through the
 * SAME parser the poll path uses, and throws with an attributable reason rather than returning
 * an unreadable document. `knownProviders` is a parameter (this module stays dependency-free —
 * the writer passes `EXECUTION_TARGET_KINDS`), so a `provider` value outside the vocabulary is
 * refused here exactly as the reader refuses it.
 *
 * An empty `switches` array yields `{schema, switches: []}` — a READABLE "no active switches"
 * document, NOT the dangerous bare `{}` (which is `unreadable`). Clearing the policy is a
 * SEPARATE act that writes SQL NULL; this builder never produces null.
 */
export function buildKillSwitchDocument(
  switches: readonly KillSwitchWriteEntry[],
  knownProviders: readonly string[],
): KillSwitchDocument {
  const candidate = {
    schema: DOCUMENT_SCHEMA,
    switches: switches.map((entry) => ({
      dimension: entry.dimension,
      value: entry.value,
      reason: entry.reason,
      ...(entry.reclaim === undefined ? {} : { reclaim: entry.reclaim }),
    })),
  };
  // Round-trip through the SAME reader the poll path uses. An unreadable stored document
  // drains every fleet, so refuse it here rather than persist it.
  const parsed = parseKillSwitchDocument(candidate, knownProviders);
  if (parsed === "unreadable") {
    throw new Error(
      "Refusing to persist an unreadable kill-switch document — a stored document the poll path cannot read drains every fleet. Each switch needs a dimension of provider|template, a non-empty value (a provider value must be a known execution target), and a stated reason (1-1000 chars).",
    );
  }
  if (parsed === "absent") {
    // Unreachable: `candidate` is a non-null object, so the parser never returns "absent".
    throw new Error("kill-switch document candidate unexpectedly parsed as absent");
  }
  return { schema: DOCUMENT_SCHEMA, switches: parsed };
}

/**
 * The providers an operator has explicitly asked to RECLAIM (REL-004 Lane D).
 *
 * Fail-OPEN, inverted from `evaluateKillSwitches` and deliberately so: this set drives a
 * force-kill of virtual machines, and destroying them because a database read blipped is the
 * worst outcome available. An absent, malformed or unreadable document reclaims NOTHING.
 *
 * Never returns a template value — reclaim is a provider-dimension act. The control plane cannot
 * evaluate the template axis at all (see `template` on {@link KillSwitchInput}).
 */
export function killedProviders(
  document: unknown,
  knownProviders: unknown,
): ReadonlySet<string> {
  const parsed = parseKillSwitchDocument(document, knownProviders);
  if (parsed === "absent" || parsed === "unreadable") return new Set();
  return new Set(
    parsed.filter((entry) => entry.dimension === "provider" && entry.reclaim).map((e) => e.value),
  );
}

/**
 * Decide whether placement is killed.
 *
 * Never throws: a leasing path must get a verdict, not an exception, and the fail-closed
 * verdict is more useful to the caller than a stack trace.
 */
export function evaluateKillSwitches(input: KillSwitchInput): KillSwitchVerdict {
  if (!isPlainObject(input)) return unreadable();
  const { document, provider, template, knownProviders } = input;

  const parsed = parseKillSwitchDocument(document, knownProviders);
  if (parsed === "absent") return { killed: false };
  if (parsed === "unreadable") return unreadable();

  // If we do not know where this work would be placed, we cannot know whether it is killed.
  if (typeof provider !== "string" || provider.length === 0) return unreadable();

  for (const entry of parsed) {
    // Exact match throughout. These are identifiers: a prefix match would make killing
    // `aoa-base` also kill `aoa-base-2`, and a case-insensitive one would depend on how an
    // operator typed it.
    if (entry.dimension === "provider") {
      if (provider === entry.value) {
        return { killed: true, dimension: "provider", value: entry.value, reason: entry.reason };
      }
      // Keep scanning: a later entry may still match.
      continue;
    }

    // D2 — the template checks live HERE, not in the parse, because they depend on CALLER state:
    // an unknown template refuses only a document that actually names the template dimension.
    if (template === undefined) return unevaluatable();
    if (template !== null && typeof template !== "string") return unreadable();
    // `template !== null` is redundant TODAY and deliberately kept: `value` is already
    // guaranteed a non-empty string, so `null === value` can never hold. Mutation testing
    // confirms removing it is an equivalent mutant. It stays because it states the
    // DEFINITELY-NONE contract at the point of use, and becomes load-bearing the moment the
    // value check above changes.
    if (template !== null && template === entry.value) {
      return { killed: true, dimension: "template", value: entry.value, reason: entry.reason };
    }
  }

  return { killed: false };
}
