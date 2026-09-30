// -----------------------------------------------------------------------------
// Append-only invocation ledger + deterministic fake clock.
//
// Every driver call appends one immutable entry
// `{ providerId, op, argsDigest, checkpoint, faultInjected, seq, ts }`. `seq` is
// a per-provider monotonic counter; `ts` is a globally monotonic deterministic
// fake-clock value (start + tick*step) so two replays of one fixture produce
// byte-identical ledgers. `reset` restores zero invocations (and the caller
// restores zero live resources), the E6F-02 reset-isolation invariant.
// -----------------------------------------------------------------------------

export interface InvocationLedgerEntry {
  readonly providerId: string;
  readonly op: string;
  readonly argsDigest: string;
  readonly checkpoint: string;
  readonly faultInjected: boolean;
  readonly seq: number;
  readonly ts: number;
}

export interface FakeClockOptions {
  readonly startMs?: number;
  readonly stepMs?: number;
}

const DEFAULT_CLOCK_START_MS = 1_760_000_000_000; // fixed deterministic epoch
const DEFAULT_CLOCK_STEP_MS = 1_000;

export class InvocationLedger {
  private readonly startMs: number;
  private readonly stepMs: number;
  private entries: InvocationLedgerEntry[] = [];
  private perProviderSeq = new Map<string, number>();
  private tick = 0;

  constructor(options: FakeClockOptions = {}) {
    this.startMs = options.startMs ?? DEFAULT_CLOCK_START_MS;
    this.stepMs = options.stepMs ?? DEFAULT_CLOCK_STEP_MS;
  }

  /** Append one immutable invocation entry and return it. */
  append(input: {
    providerId: string;
    op: string;
    argsDigest: string;
    checkpoint: string;
    faultInjected: boolean;
  }): InvocationLedgerEntry {
    const seq = (this.perProviderSeq.get(input.providerId) ?? 0) + 1;
    this.perProviderSeq.set(input.providerId, seq);
    const ts = this.startMs + this.tick * this.stepMs;
    this.tick += 1;
    const entry: InvocationLedgerEntry = {
      providerId: input.providerId,
      op: input.op,
      argsDigest: input.argsDigest,
      checkpoint: input.checkpoint,
      faultInjected: input.faultInjected,
      seq,
      ts,
    };
    this.entries.push(entry);
    return entry;
  }

  /** A copy of the full ledger, or the entries for one provider. */
  list(providerId?: string): InvocationLedgerEntry[] {
    const all = this.entries.map((e) => ({ ...e }));
    return providerId === undefined ? all : all.filter((e) => e.providerId === providerId);
  }

  /** Restore zero invocations and reset the deterministic clock. */
  reset(): void {
    this.entries = [];
    this.perProviderSeq = new Map();
    this.tick = 0;
  }
}
