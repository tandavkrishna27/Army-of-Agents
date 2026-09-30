// BRW-002 — listening-socket measurement (unit-shaped; runs on every OS).
//
// This is the containment measurement for clause (a). Two corrections from plan review are
// baked into these tests:
//
//  1. `ss` is NOT installed in `node:22`/Debian bookworm (measured), so `/proc` parsing is the
//     PRIMARY path, not a fallback.
//  2. Design v1 named `/proc/net/tcp` singular. A socket bound to `::` appears ONLY in
//     `/proc/net/tcp6` — so the v1 measurement would have reported "clean" while a port was
//     bound. Both files are read.
//
// The guard built on this is a DELTA, not an absolute set: every E2B sandbox runs envd on TCP
// 49983 (`e2b/dist/index.js:885`), so "no listening sockets" is false at t=0 and a guard that
// cannot pass gets relaxed into the allowlist it was meant to avoid.
import { describe, expect, it } from "vitest";
import { listeningPortDelta, parseListeningPorts, readListeningPorts } from "../listening-ports.js";

// Real `/proc/net/tcp` shape. Columns: sl, local_address, rem_address, st, ...
// st 0A = LISTEN, 01 = ESTABLISHED.
const TCP4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   1: 00000000:C33F 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0
   2: 0100007F:8ACE 0100007F:1F90 01 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 100 0 0 10 0
`;

// `/proc/net/tcp6` — the local address is 32 hex chars. Row 0 is a `::` (all-zero) listener,
// which is exactly the case the IPv4-only v1 measurement would have missed.
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:2406 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22345 1 0000000000000000 100 0 0 10 0
   1: 0000000000000000FFFF00000100007F:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22346 1 0000000000000000 100 0 0 10 0
`;

describe("BRW-002 listening ports — parses LISTEN rows only", () => {
  it("reads listening ports and converts the hex port correctly", () => {
    // 0x1F90 = 8080, 0xC33F = 49983 (envd)
    expect(parseListeningPorts(TCP4).sort((a, b) => a - b)).toEqual([8080, 49983]);
  });

  it("excludes non-LISTEN sockets", () => {
    // Row 2 is ESTABLISHED (st 01) on 0x8ACE = 35534. It must not appear.
    expect(parseListeningPorts(TCP4)).not.toContain(35534);
  });

  it("ignores the header row and blank lines", () => {
    expect(parseListeningPorts(`\n${TCP4}\n\n`).sort((a, b) => a - b)).toEqual([8080, 49983]);
    expect(parseListeningPorts("")).toEqual([]);
    expect(parseListeningPorts("   \n\n")).toEqual([]);
  });

  it("ignores malformed rows rather than throwing", () => {
    const malformed = `  sl  local_address rem_address   st
   0: NOTHEX:ZZZZ 00000000:0000 0A
   1: 0100007F 00000000:0000 0A
   2: 0100007F:1F90 00000000:0000 0A 0 0 0 0 0 0 0 0 1
`;
    // Only the well-formed row survives; a parser that throws here would take the whole
    // guard down on an unexpected kernel row.
    expect(parseListeningPorts(malformed)).toEqual([8080]);
  });

  it("ignores a row whose ADDRESS is not hex even when the PORT is", () => {
    // Mutation testing found the address check was unkillable: every malformed row in the
    // fixture above ALSO had a malformed port, so the port check alone explained the
    // result. This row isolates the address check, which is the only thing that can reject
    // it.
    const badAddress = `  sl  local_address rem_address   st
   0: NOTHEXAD:1F90 00000000:0000 0A 0 0 0 0 0 0 0 0 1
`;
    expect(parseListeningPorts(badAddress)).toEqual([]);
  });
});

describe("BRW-002 listening ports — IPv6 is not optional", () => {
  // THE v1 DEFECT. A `::` listener lives only in tcp6.
  it("finds a listener bound to :: which does not appear in the IPv4 table", () => {
    // 0x2406 = 9222 — the canonical Chromium debugging port, bound to `::`.
    expect(parseListeningPorts(TCP6)).toContain(9222);
    expect(parseListeningPorts(TCP4)).not.toContain(9222);
  });

  it("parses a v4-mapped v6 address row", () => {
    // 0x1F91 = 8081
    expect(parseListeningPorts(TCP6)).toContain(8081);
  });
});

describe("BRW-002 listening ports — the guard is a DELTA", () => {
  // Absolute-set assertions are false at t=0 because envd holds 49983 in every sandbox.
  it("reports no delta when the same infrastructure ports are present before and after", () => {
    expect(listeningPortDelta([49983, 8080], [8080, 49983])).toEqual([]);
  });

  it("reports a port the browser opened", () => {
    expect(listeningPortDelta([49983], [49983, 9222])).toEqual([9222]);
  });

  it("reports an IPv6-only port the browser opened", () => {
    // Composed from both tables, this is the case v1 could not see at all.
    const before = parseListeningPorts(TCP4);
    const after = [...parseListeningPorts(TCP4), ...parseListeningPorts(TCP6)];
    expect(listeningPortDelta(before, after).sort((a, b) => a - b)).toEqual([8081, 9222]);
  });

  it("does NOT report a port that disappeared", () => {
    // The delta is one-directional on purpose: a closed infrastructure port is not a
    // containment failure, and reporting it would make the guard fire on unrelated churn.
    expect(listeningPortDelta([49983, 8080], [49983])).toEqual([]);
  });

  it("deduplicates a port present in both tables", () => {
    // A dual-stack listener appears in tcp AND tcp6; it is one port, not two.
    expect(listeningPortDelta([], [9222, 9222])).toEqual([9222]);
  });

  it("returns a sorted, deterministic result", () => {
    expect(listeningPortDelta([], [9222, 8080, 49983])).toEqual([8080, 9222, 49983]);
  });
});

describe("BRW-002 listening ports — reading both tables", () => {
  // `readListeningPorts` had NO test when it was written. A function with no test is the
  // thing this programme keeps finding in other people's code; found in my own here.
  const reader = (files: Record<string, string>) => async (path: string) => {
    const contents = files[path];
    if (contents === undefined) throw new Error(`ENOENT ${path}`);
    return contents;
  };

  it("merges both tables and deduplicates a dual-stack listener", async () => {
    const ports = await readListeningPorts(
      reader({ "/proc/net/tcp": TCP4, "/proc/net/tcp6": TCP6 }),
    );
    expect(ports).toEqual([8080, 8081, 9222, 49983]);
  });

  it("still measures when the IPv6 table is absent", async () => {
    // A kernel without IPv6 has no /proc/net/tcp6, and that is not a containment failure.
    const ports = await readListeningPorts(reader({ "/proc/net/tcp": TCP4 }));
    expect(ports).toEqual([8080, 49983]);
  });

  it("still measures when only the IPv6 table exists", async () => {
    const ports = await readListeningPorts(reader({ "/proc/net/tcp6": TCP6 }));
    expect(ports).toEqual([8081, 9222]);
  });

  it("THROWS when neither table can be read", async () => {
    // The load-bearing case: returning [] here would manufacture a passing containment
    // guard out of a measurement that never happened.
    await expect(readListeningPorts(reader({}))).rejects.toThrow(/did not run/);
  });
});
