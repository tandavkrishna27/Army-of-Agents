// packages/browser-runtime/src/listening-ports.ts
//
// BRW-002 — the containment MEASUREMENT for clause (a).
//
// The guard for "the browser opened no reachable endpoint" is a measurement of the machine,
// not an inspection of the arguments we happened to pass. An argument allowlist proves that
// one spelling of one flag is absent; it cannot detect a future Playwright or Chromium build
// that opens a port for its own reasons. This can.
//
// TWO CORRECTIONS FROM PLAN REVIEW, both load-bearing:
//
//  1. `/proc` parsing is the PRIMARY path, not a fallback. `ss` (iproute2) is NOT installed in
//     `node:22`/Debian bookworm, which is the base of the sandbox template — measured, not
//     assumed.
//  2. BOTH `/proc/net/tcp` AND `/proc/net/tcp6` must be read. A socket bound to `::` appears
//     ONLY in the v6 table, so reading the v4 table alone reports "clean" while a port is
//     bound. That was a real defect in the previous design.
//
// AND THE GUARD IS A DELTA. Every E2B sandbox runs envd on TCP 49983
// (`e2b/dist/index.js:885`, `_ConnectionConfig.envdPort = 49983`) — it is how commands and
// files reach the guest. So "no listening sockets" is FALSE at t=0. A guard that cannot pass
// gets relaxed into an allowlist, and an allowlist is what we were trying not to depend on.
// Measuring the delta across the launch is robust to any pre-existing listener without
// naming one.

/** `st` column value for LISTEN in /proc/net/tcp{,6}. */
const TCP_STATE_LISTEN = "0A";

/**
 * Extract the listening ports from the contents of `/proc/net/tcp` or `/proc/net/tcp6`.
 *
 * Row shape (whitespace-separated): `sl local_address rem_address st ...`, where
 * `local_address` is `HEXADDR:HEXPORT` — 8 hex chars for IPv4, 32 for IPv6 — and the port is
 * big-endian hex regardless of family.
 *
 * Malformed rows are SKIPPED rather than thrown on: an unexpected kernel row must not take
 * the whole containment guard down, because a guard that crashes gets removed.
 */
export function parseListeningPorts(contents: string): number[] {
  const ports: number[] = [];
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    const columns = line.split(/\s+/);
    // sl, local_address, rem_address, st — anything shorter is not a socket row.
    if (columns.length < 4) continue;

    const localAddress = columns[1];
    const state = columns[3];
    if (localAddress === undefined || state === undefined) continue;
    if (state.toUpperCase() !== TCP_STATE_LISTEN) continue;

    const separator = localAddress.lastIndexOf(":");
    if (separator < 0) continue;

    const addressPart = localAddress.slice(0, separator);
    const portHex = localAddress.slice(separator + 1);
    // Both halves must be pure hex; the header row and any malformed row fail here.
    if (!/^[0-9a-fA-F]+$/.test(addressPart)) continue;
    if (!/^[0-9a-fA-F]+$/.test(portHex)) continue;

    const port = Number.parseInt(portHex, 16);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    ports.push(port);
  }
  return ports;
}

/**
 * Ports present AFTER an operation that were not present BEFORE it.
 *
 * Deliberately ONE-DIRECTIONAL. A port that disappeared is not a containment failure, and
 * reporting it would make the guard fire on unrelated infrastructure churn — noise is how a
 * guard earns itself an exemption. Deduplicated because a dual-stack listener legitimately
 * appears in both tables, and sorted so a failure message is deterministic.
 */
export function listeningPortDelta(before: readonly number[], after: readonly number[]): number[] {
  const known = new Set(before);
  const opened = new Set<number>();
  for (const port of after) {
    if (!known.has(port)) opened.add(port);
  }
  return [...opened].sort((a, b) => a - b);
}

/** Injected reader so the composition is testable without a Linux /proc. */
export type ReadProcFile = (path: string) => Promise<string>;

/**
 * Read both socket tables and return every listening port.
 *
 * A missing or unreadable table contributes nothing rather than failing the whole
 * measurement: a kernel without IPv6 has no `/proc/net/tcp6`, and that is not a containment
 * failure. If BOTH are unreadable the caller cannot have measured anything, so that case
 * throws — silently returning `[]` there would manufacture a passing guard out of an absent
 * measurement, which is the failure mode this whole ticket is about.
 */
export async function readListeningPorts(readFile: ReadProcFile): Promise<number[]> {
  const paths = ["/proc/net/tcp", "/proc/net/tcp6"];
  const ports: number[] = [];
  let read = 0;
  for (const path of paths) {
    try {
      ports.push(...parseListeningPorts(await readFile(path)));
      read += 1;
    } catch {
      // Absent table: contributes nothing.
    }
  }
  if (read === 0) {
    throw new Error("could not read /proc/net/tcp or /proc/net/tcp6; the socket measurement did not run");
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}
