// server/src/services/execution-secret-handle-envelope.ts
//
// DAT-008 slice 2 — shape stored `job_secret_handles` rows into the FROZEN wire ref
// (`secretHandleRefSchema`) the lease envelope carries.
//
// Deliberately NOT a validator. `jobEnvelopeV1Schema.safeParse` in `buildJobEnvelope`
// is the single authority on what is admissible, and it is strict: a non-uuid handle
// id, an `env` arm with no target, or an `env`/`fence_proxy` pairing all fail there.
// This function's only job is to make sure every row ARRIVES in a form that authority
// can judge.
//
// That is why a malformed row is passed through rather than filtered out. Dropping it
// would produce the one outcome nothing downstream can recover from: a lease whose
// sandbox has no credential, surfacing much later as an opaque CLI auth failure with
// no attribution back to the handle. Keeping it makes the ENVELOPE fail, so the job
// does not lease and the fault stays where it was introduced.

/** The stored shape, straight from `listActiveExecutionSecretHandles`. Nullable
 * because the DAT-004 columns are all nullable additive widens. */
export interface StoredExecutionSecretHandle {
  readonly handle: string;
  readonly materialization: string | null;
  readonly materializationTarget: string | null;
  readonly usePolicy: string | null;
}

/** A candidate wire ref. Typed loosely on purpose — it is UNVALIDATED until the
 * envelope schema judges it, and typing it as `SecretHandleRef` here would assert a
 * guarantee this function does not provide. */
export interface CandidateSecretHandleRef {
  readonly handleId: string;
  readonly materialization: Record<string, unknown>;
  readonly usePolicy: string | null;
}

/** `proxy` takes NO target (its frozen arm is `.strict()`); `env` and `file` both
 * carry one. An unknown kind is passed through verbatim so the schema rejects it by
 * name rather than being silently normalized into a valid-looking arm. */
function materializationOf(row: StoredExecutionSecretHandle): Record<string, unknown> {
  if (row.materialization === "proxy") {
    // A proxy row that somehow carries a target is MALFORMED, and dropping the target
    // here would launder it into a valid-looking ref. Pass it through so the strict
    // proxy arm rejects the row by name.
    return row.materializationTarget === null
      ? { kind: "proxy" }
      : { kind: "proxy", target: row.materializationTarget };
  }
  if (row.materialization === "env" || row.materialization === "file") {
    return { kind: row.materialization, target: row.materializationTarget };
  }
  return { kind: row.materialization };
}

export function toSecretHandleRefs(
  rows: readonly StoredExecutionSecretHandle[],
): CandidateSecretHandleRef[] {
  return rows.map((row) => ({
    handleId: row.handle,
    materialization: materializationOf(row),
    usePolicy: row.usePolicy,
  }));
}
