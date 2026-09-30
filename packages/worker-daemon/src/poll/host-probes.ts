// WRK-008 slice 2b — the production capacity probes.
//
// `poll/capacity.ts` declares the `CapacityProbes` port and its own header says "real
// impl reads node:os / node:fs". No such implementation existed; `PollLoopDeps.measure`
// could not be built from what shipped. This file is that implementation.
//
// ★ EVERY PROBE FAILS TO ZERO. A throwing reader is a host quirk — an unusual
// filesystem, a container image whose Node build lacks `statfsSync` — not a reason to
// kill a daemon mid-poll. Zero is fail-CLOSED: the worker advertises no capacity and is
// offered nothing. Inventing a number (the `catch → 1` mutant) is the dangerous
// direction, and a negative reading (clamped here) would fail the frozen capacity schema.

import { cpus, freemem } from "node:os";
import { statfsSync } from "node:fs";

import type { CapacityProbes } from "./capacity.js";

/** Millicores advertised per logical CPU. One core = 1000 millis. */
export const MILLIS_PER_CORE = 1000;

const BYTES_PER_MIB = 1024 * 1024;

/**
 * Raw host readers, injected so the probes are provable without touching the real host.
 * `defaultHostProbeReaders` binds them to `node:os` / `node:fs`.
 */
export interface HostProbeReaders {
  /** Logical CPU count (`os.cpus().length`). */
  readonly cpuCount: () => number;
  /** Free physical memory in bytes (`os.freemem()`). */
  readonly freeMemoryBytes: () => number;
  /** Free bytes available on the work volume (`statfs` bavail × bsize). */
  readonly diskFree: () => number;
}

/**
 * Wrap a reader so it NEVER throws and NEVER reports a negative number. A host quirk
 * yields ZERO advertised capacity (fail-closed), never a crash and never an invented
 * value. The `<= 0 → 0` clamp keeps a garbage negative reading out of the frozen schema.
 */
function zeroOnThrow(read: () => number): () => number {
  return () => {
    try {
      const value = read();
      return value <= 0 ? 0 : Math.floor(value);
    } catch {
      return 0;
    }
  };
}

export function createHostCapacityProbes(readers: HostProbeReaders): CapacityProbes {
  return {
    freeCpuMillis: zeroOnThrow(() => readers.cpuCount() * MILLIS_PER_CORE),
    freeMemoryMiB: zeroOnThrow(() => readers.freeMemoryBytes() / BYTES_PER_MIB),
    freeDiskMiB: zeroOnThrow(() => readers.diskFree() / BYTES_PER_MIB),
  };
}

/** The production readers, wired to `node:os` / `node:fs`. `statfsSync` is read against
 * the work directory; a Node build without it throws and the probe fails to zero. */
export function defaultHostProbeReaders(workDir: string): HostProbeReaders {
  return {
    cpuCount: () => cpus().length,
    freeMemoryBytes: () => freemem(),
    diskFree: () => {
      const st = statfsSync(workDir);
      return Number(st.bavail) * Number(st.bsize);
    },
  };
}
