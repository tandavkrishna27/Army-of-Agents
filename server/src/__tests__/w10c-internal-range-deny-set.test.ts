import { describe, expect, it } from "vitest";

import {
  INTERNAL_RANGE_DENY_CIDRS,
  INTERNAL_RANGE_DENY_CIDRS_V4,
  INTERNAL_RANGE_DENY_CIDRS_V6,
  PRIVATE_RANGE_AGREEMENT_CORPUS,
  findPrivateRangeGaps,
  isCoveredByDenySet,
  isSupersetOfIsPrivateIp,
} from "../services/w10c-internal-range-deny-set.js";
import { isPrivateIP } from "../services/outbound-url-guard.js";

// W10C -- the pinned internal-range deny set.
//
// THE PIN IS THE POINT. `expect(...).toEqual([literal])` -- never `toContain` --
// so that ADDING a range and REMOVING a range each red this file. A pin that only
// catches removal is half a pin.
//
// The pin is backed by a RE-DERIVATION: the IPv4 half is recomputed from
// `isPrivateIP` itself on every run (a full 2^24 /24 sweep, ~8s) and asserted
// equal to the frozen array, so the set cannot silently drift from the predicate
// it renders. Corpus agreement alone could not do that -- see the "corpus
// agreement is not a pin" test, which sits with the pin in section 1 because it
// reads the frozen export.

// --- test-local CIDR arithmetic (BigInt; deliberately not imported from the
// --- module under test, so a bug there cannot hide itself) -------------------

function v4ToInt(ip: string): bigint {
  return ip.split(".").reduce((acc, o) => (acc << 8n) | BigInt(Number(o)), 0n);
}
function intToV4(v: bigint): string {
  return [(v >> 24n) & 255n, (v >> 16n) & 255n, (v >> 8n) & 255n, v & 255n].join(".");
}
function v6ToInt(ip: string): bigint {
  const halves = ip.split("::");
  const parse = (s: string): number[] =>
    s === "" ? [] : s.split(":").map((t) => Number.parseInt(t, 16));
  const left = parse(halves[0] ?? "");
  const right = halves.length > 1 ? parse(halves[1] ?? "") : [];
  const words =
    halves.length === 1
      ? left
      : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
  return words.reduce((acc, w) => (acc << 16n) | BigInt(w), 0n);
}
function intToV6(v: bigint): string {
  const words: string[] = [];
  for (let i = 7; i >= 0; i--) words.push((((v >> BigInt(i * 16)) & 0xffffn) as bigint).toString(16));
  return words.join(":");
}
function bounds(cidr: string): { lo: bigint; hi: bigint; bits: number; v6: boolean } {
  const [base, prefixStr] = cidr.split("/");
  const v6 = base!.includes(":");
  const bits = v6 ? 128 : 32;
  const prefix = Number(prefixStr);
  const lo = v6 ? v6ToInt(base!) : v4ToInt(base!);
  const size = 1n << BigInt(bits - prefix);
  return { lo, hi: lo + size - 1n, bits, v6 };
}
const render = (v: bigint, v6: boolean): string => (v6 ? intToV6(v) : intToV4(v));

// --- 1. THE EXACT-SET PIN ----------------------------------------------------

describe("W10C internal-range deny set -- the exact-set pin", () => {
  it("IPv4 half is EXACTLY this list (adding or removing a range reds here)", () => {
    expect(INTERNAL_RANGE_DENY_CIDRS_V4).toEqual([
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.0.0.0/24",
      "192.0.2.0/24",
      "192.88.99.0/24",
      "192.168.0.0/16",
      "198.18.0.0/15",
      "198.51.100.0/24",
      "203.0.113.0/24",
      "224.0.0.0/3",
    ]);
  });

  it("IPv6 half is EXACTLY this list (adding or removing a range reds here)", () => {
    expect(INTERNAL_RANGE_DENY_CIDRS_V6).toEqual([
      "::/16",
      "64:ff9b::/47",
      // W17: "100::/64" before W17. The RFC9780 Dummy Prefix 100:0:0:1::/64 was
      // added to `isPrivateIP`, and it is ADJACENT and aligned to the RFC6666
      // discard block, so the EXACT MINIMAL cover of the pair is one /63. This
      // value was RE-DERIVED from the predicate (see the header note and
      // w17-ipv6-range-closeout.test.ts), not hand-written to match an assumption.
      "100::/63",
      "2001::/32",
      "2001:2::/32",
      "2001:10::/28",
      "2001:20::/28",
      "2001:db8::/32",
      "2002::/16",
      "3ff0::/12",
      "5f00::/16", // W17: SRv6 SIDs, RFC9602, registry Globally Reachable = FALSE
      "fc00::/7",
      "fe80::/9",
      "ff00::/8",
    ]);
  });

  it("the combined set is exactly v4 ++ v6, and every array is frozen", () => {
    expect(INTERNAL_RANGE_DENY_CIDRS).toEqual([
      ...INTERNAL_RANGE_DENY_CIDRS_V4,
      ...INTERNAL_RANGE_DENY_CIDRS_V6,
    ]);
    expect(INTERNAL_RANGE_DENY_CIDRS).toHaveLength(28);
    expect(Object.isFrozen(INTERNAL_RANGE_DENY_CIDRS_V4)).toBe(true);
    expect(Object.isFrozen(INTERNAL_RANGE_DENY_CIDRS_V6)).toBe(true);
    expect(Object.isFrozen(INTERNAL_RANGE_DENY_CIDRS)).toBe(true);
    expect(Object.isFrozen(PRIVATE_RANGE_AGREEMENT_CORPUS)).toBe(true);
  });

  it("the minimum ranges the unit spec names are all present and unmerged", () => {
    // Named explicitly so a future aggregation that swallowed one of these into a
    // wider block would still have to be a deliberate, reviewed edit.
    for (const required of [
      "169.254.0.0/16", // link-local / cloud metadata
      "127.0.0.0/8", // loopback
      "10.0.0.0/8", // RFC1918
      "172.16.0.0/12", // RFC1918
      "192.168.0.0/16", // RFC1918
      "100.64.0.0/10", // CGNAT
    ]) {
      expect(INTERNAL_RANGE_DENY_CIDRS_V4).toContain(required);
    }
  });

  // Lives HERE, not with the explicit-input cases below, because it READS the
  // frozen export: it is an argument for the pin above, so a mutation of the set
  // is supposed to red it.
  it("CORPUS AGREEMENT IS NOT A PIN -- this is why the exact-set test exists", () => {
    // Delete 192.88.99.0/24 from a copy of the set. Over a corpus with no
    // 192.88.99.x address, the agreement check still passes -- it cannot see the
    // hole. Only the exact-set assertion and the re-derivation sweep catch it.
    const holed = INTERNAL_RANGE_DENY_CIDRS.filter((c) => c !== "192.88.99.0/24");
    const blindCorpus = ["169.254.169.254", "10.1.1.1", "127.0.0.1", "8.8.8.8"];
    expect(isSupersetOfIsPrivateIp(holed, blindCorpus)).toBe(true); // blind
    expect(isSupersetOfIsPrivateIp(holed, ["192.88.99.1"])).toBe(false); // only if asked
  });
});

// --- 2. THE RE-DERIVATION: the set IS isPrivateIP, recomputed ----------------

describe("W10C internal-range deny set -- re-derived from isPrivateIP", () => {
  it("IPv4 half equals the exact minimal cover of isPrivateIP over the whole IPv4 space", () => {
    // `isPrivateIP`'s IPv4 decision reads at most the first three octets; the
    // constancy of the fourth is asserted separately below. Sweep all 2^24 /24s.
    const bits = new Uint8Array(1 << 24);
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        for (let c = 0; c < 256; c++) {
          if (isPrivateIP(`${a}.${b}.${c}.0`)) bits[(a << 16) | (b << 8) | c] = 1;
        }
      }
    }
    const cover: string[] = [];
    const walk = (idx: number, prefix: number): void => {
      const size = 1 << (24 - prefix);
      let all = true;
      let any = false;
      for (let i = idx; i < idx + size; i++) {
        if (bits[i]) any = true;
        else all = false;
        if (any && !all) break;
      }
      if (all) {
        cover.push(`${[(idx >>> 16) & 255, (idx >>> 8) & 255, idx & 255, 0].join(".")}/${prefix}`);
        return;
      }
      if (!any) return;
      walk(idx, prefix + 1);
      walk(idx + (size >> 1), prefix + 1);
    };
    walk(0, 0);
    expect(cover).toEqual([...INTERNAL_RANGE_DENY_CIDRS_V4]);
  }, 60_000);

  it("isPrivateIP's IPv4 verdict really is constant across the fourth octet", () => {
    const probes: Array<[number, number, number]> = [];
    for (const a of [0, 9, 10, 11, 99, 100, 101, 126, 127, 128, 168, 169, 170, 172, 173, 191, 192, 198, 203, 223, 224, 239, 240, 255]) {
      for (const b of [0, 15, 16, 31, 32, 63, 64, 88, 99, 127, 128, 167, 168, 169, 254, 255]) {
        for (const c of [0, 1, 2, 99, 100, 113, 169, 254, 255]) probes.push([a, b, c]);
      }
    }
    for (const [a, b, c] of probes) {
      const base = isPrivateIP(`${a}.${b}.${c}.0`);
      for (const d of [1, 2, 127, 128, 169, 254, 255]) {
        expect(isPrivateIP(`${a}.${b}.${c}.${d}`), `${a}.${b}.${c}.${d}`).toBe(base);
      }
    }
  });

  it("every frozen range is EXACTLY as wide as isPrivateIP: both edges in, both neighbours out", () => {
    const all = [...INTERNAL_RANGE_DENY_CIDRS];
    for (const cidr of all) {
      const { lo, hi, bits, v6 } = bounds(cidr);
      // Both edges must be inside the predicate's rejection set. NO exemptions --
      // an exemption here is a hole, and the `::a.b.c.d` parser defect does not
      // need one: `::/16`'s edges are spelled in hex, which isPrivateIP parses.
      expect(isPrivateIP(render(lo, v6)), `${cidr} low edge`).toBe(true);
      expect(isPrivateIP(render(hi, v6)), `${cidr} high edge`).toBe(true);
      // The addresses immediately outside must NOT be private -- unless some OTHER
      // frozen range covers them (adjacent blocks the minimal cover kept separate).
      const max = (1n << BigInt(bits)) - 1n;
      for (const neighbour of [lo - 1n, hi + 1n]) {
        if (neighbour < 0n || neighbour > max) continue;
        const ip = render(neighbour, v6);
        if (isCoveredByDenySet(ip)) continue; // covered by a sibling range
        expect(isPrivateIP(ip), `${cidr} neighbour ${ip} should be public`).toBe(false);
      }
    }
  });

  it("IPv6: no rejected range is MISSING, swept across all 65536 leading words", () => {
    // The IPv6 space cannot be swept exhaustively, but `isPrivateIP`'s IPv6 arm
    // reads only the first four words, and every arm of it keys off the FIRST.
    // So sweeping all 2^16 leading words with a probe set that exercises the
    // deeper arms (NAT64, discard, Teredo/ORCHID/doc) finds any absent range at
    // /16 granularity or coarser -- the failure mode a random sample would miss.
    const suffixes: Array<[number, number, number]> = [
      [0, 0, 0],
      [0, 0, 1],
      [0xff9b, 0, 0], // 64:ff9b:: NAT64
      [0xff9b, 1, 0], // 64:ff9b:1:: NAT64
      [0, 0, 0xffff],
      [0x0db8, 0, 1], // 2001:db8:: documentation
      [0x0002, 0, 0], // 2001:2:: benchmarking
      [0x0010, 0, 0], // 2001:10:: ORCHID
      [0x0020, 0, 0], // 2001:20:: ORCHIDv2
      [0xffff, 0xffff, 0xffff],
    ];
    for (let w0 = 0; w0 < 65536; w0++) {
      const head = w0.toString(16);
      for (const [w1, w2, w3] of suffixes) {
        const ip = `${head}:${w1.toString(16)}:${w2.toString(16)}:${w3.toString(16)}:0:0:0:1`;
        if (isPrivateIP(ip)) {
          expect(isCoveredByDenySet(ip), `deny set is missing a range for ${ip}`).toBe(true);
        }
      }
    }
  }, 60_000);

  it("the set covers every address isPrivateIP rejects, on a randomized IPv6 sweep", () => {
    // The IPv6 space cannot be swept exhaustively; this is a differential sample
    // biased towards the frozen ranges' own neighbourhoods plus uniform noise.
    const rnd = (): bigint => {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 16n) | BigInt(Math.floor(Math.random() * 65536));
      return v;
    };
    const samples: string[] = [];
    for (const cidr of INTERNAL_RANGE_DENY_CIDRS_V6) {
      const { lo, hi } = bounds(cidr);
      samples.push(intToV6(lo), intToV6(hi), intToV6(lo + 1n));
      if (lo > 0n) samples.push(intToV6(lo - 1n));
      samples.push(intToV6(hi + 1n));
    }
    for (let i = 0; i < 20_000; i++) samples.push(intToV6(rnd()));
    for (const ip of samples) {
      if (isPrivateIP(ip)) {
        expect(isCoveredByDenySet(ip), `deny set must cover ${ip}`).toBe(true);
      }
    }
  });
});

// --- 3. AGREEMENT WITH isPrivateIP over the standing corpus ------------------

describe("W10C internal-range deny set -- agreement with isPrivateIP", () => {
  it("has no gaps against isPrivateIP over the standing corpus", () => {
    expect(findPrivateRangeGaps(INTERNAL_RANGE_DENY_CIDRS, PRIVATE_RANGE_AGREEMENT_CORPUS)).toEqual(
      [],
    );
    expect(isSupersetOfIsPrivateIp(INTERNAL_RANGE_DENY_CIDRS, PRIVATE_RANGE_AGREEMENT_CORPUS)).toBe(
      true,
    );
  });

  it("covers the addresses that have already bitten, in every spelling", () => {
    for (const ip of [
      "169.254.169.254",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "::169.254.169.254",
      "169.254.170.2",
      "fd00:ec2::254",
    ]) {
      expect(isCoveredByDenySet(ip), ip).toBe(true);
    }
  });

  it("W13: the parser defect is CLOSED — isPrivateIP and the deny set now AGREE on '::169.254.169.254'", () => {
    // This assertion used to read `.toBe(false)`, with a comment saying that the day
    // the parser was fixed it should red so the fix was noticed rather than absorbed.
    // W13 fixed it (both modules now share ./ip-literal.ts), so this is that notice:
    // at THIS address the set and the predicate now agree, where before the set covered
    // an address the predicate misparsed.
    //
    // ★ IT DOES NOT MAKE THE SET AN EXACT COVER, and an earlier revision of this
    // comment said it did. The set is STILL a deliberate strict superset, for a
    // different and pre-existing reason: `::/16` numerically contains every
    // `::ffff:a.b.c.d`, so the `BlockList` built from this list denies mapped PUBLIC
    // addresses that `isPrivateIP` allows. That class is measured and pinned by the
    // two `IPv4-MAPPED:` tests in w13-oauth-deny-table-divergence.test.ts.
    expect(isPrivateIP("::169.254.169.254")).toBe(true);
    expect(isPrivateIP("::ffff:169.254.169.254")).toBe(true); // the mapped form always was
    expect(isCoveredByDenySet("::169.254.169.254")).toBe(true);
    // No RANGE moved to achieve that: `::/16` covered the address before the fix too.
    expect(INTERNAL_RANGE_DENY_CIDRS_V6[0]).toBe("::/16");
  });

  it("does NOT cover public addresses (the set is not a blanket deny)", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "172.32.0.1",
      "100.128.0.1",
      "192.88.100.1",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
    ]) {
      expect(isCoveredByDenySet(ip), ip).toBe(false);
      expect(isPrivateIP(ip), ip).toBe(false);
    }
  });
});

// --- 4. THE SUPERSET PREDICATE'S OWN BEHAVIOUR -------------------------------
// POSITIVE CONTROL, and the property is checkable: all six cases below pass
// EXPLICIT CIDR lists and none of them names any frozen export, so a mutation of
// the frozen SET reds the pin in section 1 while these stay green -- the failure
// is localized to the data, not to the harness.
//
// SCOPE, stated exactly: this is a control for mutations of the frozen SET only.
// These cases DO call `isPrivateIP`, so a mutation of the REFERENCE PREDICATE
// reds them too -- and should. MEASURED: deleting `isPrivateIP`'s `169.254.` arm
// reds exactly one of the six ("reports a gap ...", expected [] to deeply equal
// [ '169.254.169.254' ]). That is not a broken control; it is the control working
// on a different mutation target.
//
// The "corpus agreement is not a pin" case used to sit in this describe and did
// NOT have the property this header claims -- it reads `INTERNAL_RANGE_DENY_CIDRS`,
// so removing "10.0.0.0/8" from the frozen set red it here. It now lives in
// section 1 beside the pin it argues for, where a set mutation SHOULD red it.

describe("W10C superset predicate -- behaviour on explicit inputs", () => {
  it("reports a gap when the given set misses a range isPrivateIP rejects", () => {
    const incomplete = ["10.0.0.0/8"]; // no link-local
    expect(findPrivateRangeGaps(incomplete, ["10.1.1.1", "169.254.169.254", "8.8.8.8"])).toEqual([
      "169.254.169.254",
    ]);
    expect(isSupersetOfIsPrivateIp(incomplete, ["169.254.169.254"])).toBe(false);
  });

  it("reports no gap when the given set is wider than isPrivateIP", () => {
    const wide = ["0.0.0.0/0"];
    expect(findPrivateRangeGaps(wide, ["169.254.169.254", "10.1.1.1", "8.8.8.8"])).toEqual([]);
    expect(isSupersetOfIsPrivateIp(wide, ["169.254.169.254", "8.8.8.8"])).toBe(true);
  });

  it("ignores public addresses entirely -- a gap is only ever a MISSED private address", () => {
    expect(findPrivateRangeGaps([], ["8.8.8.8", "1.1.1.1"])).toEqual([]);
    expect(findPrivateRangeGaps([], ["10.0.0.1"])).toEqual(["10.0.0.1"]);
  });

  it("an empty CIDR set covers nothing; an empty corpus proves nothing", () => {
    expect(isCoveredByDenySet("10.0.0.1", [])).toBe(false);
    expect(isSupersetOfIsPrivateIp([], [])).toBe(true); // vacuous -- documented, not relied on
  });

  it("skips empty CIDR entries rather than treating them as a wildcard", () => {
    expect(isCoveredByDenySet("8.8.8.8", ["", "10.0.0.0/8"])).toBe(false);
  });

  it("is family-aware: an IPv4 address is not matched by an IPv6 range or vice versa", () => {
    expect(isCoveredByDenySet("10.0.0.1", ["fc00::/7"])).toBe(false);
    expect(isCoveredByDenySet("fc00::1", ["10.0.0.0/8"])).toBe(false);
  });
});
