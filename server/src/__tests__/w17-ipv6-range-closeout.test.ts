import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isPrivateIP } from "../services/outbound-url-guard.js";
import {
  INTERNAL_RANGE_DENY_CIDRS_V4,
  INTERNAL_RANGE_DENY_CIDRS_V6,
} from "../services/w10c-internal-range-deny-set.js";
// The DIFFERENTIAL ORACLE. `scripts/check-egress-policy-vectors.mjs` carries its own
// from-scratch `isPrivateIp` and a CIDR list; it is the only independent answer to
// "is this address internal" in the tree. It is imported HERE, in a file that owns
// neither implementation, precisely so the oracle itself never has to import
// production — see the "why the oracle is not fixed by importing production" note.
import {
  IPV6_PRIVATE_CIDRS as ORACLE_IPV6_CIDRS,
  isPrivateIp as oracleIsPrivateIp,
} from "../../../scripts/check-egress-policy-vectors.mjs";

// W17 -- CLOSING THE TWO IPv6 RANGES THE IANA AUDIT FOUND, AND FIXING THE ORACLE
// THAT SHOULD HAVE FOUND THEM.
//
// WHAT THIS FILE PROVES, in the order in which it could go wrong:
//
//   1. THE REGISTRY IS COVERED. Every IANA special-purpose block whose
//      `Globally Reachable` column is FALSE is inside `isPrivateIP`'s rejection
//      set, with exactly TWO enumerated exceptions, each justified below. This is
//      the audit itself, as a check rather than as prose: before W17 it existed
//      only in a conversation, and `grep -rn IANA` over server/src, scripts and
//      docs/replatform returned one hit -- a timezone row in a QA template.
//
//   2. NOTHING MOVED DENIED -> ALLOWED. IPv4 by a full sweep of all 2^24 /24
//      blocks against the pre-W17 cover (the IPv4 arm was NOT touched, and this
//      MEASURES that rather than assuming it); IPv6 by exact interval arithmetic
//      over the whole 2^128 space against the pre-W17 cover.
//
//   3. THE ALLOWED -> DENIED SET IS EXACTLY THE TWO RANGES. 2^64 + 2^112
//      addresses, not one more. This is the anti-regression half: over-blocking is
//      not free, and a future edit that denied anything else reds here by name.
//
//   4. THE ORACLE'S DIVERGENCE FROM PRODUCTION IS EXACTLY FOUR INTERVALS. Not
//      "they agree" -- the set is stated. Any future NARROWING of production adds
//      an interval to the OTHER direction, which is pinned EMPTY, and reds naming
//      the range.
//
// ★★★ WHY THE ORACLE IS NOT "FIXED" BY IMPORTING PRODUCTION. Before W17 the oracle
// denied only ::/16, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 2001:db8::/32 and
// 2002::/16 -- a strict SUBSET of production -- and the vectors fixture exercised
// no divergent range, so the `policy` lane passed regardless. The tempting repair
// is to have the oracle call `isPrivateIP`. That would delete the only mechanism in
// this tree that has ever caught this class: the oracle's ::/16 clause covered
// `::169.254.169.254`, the exact spelling E8-F009 measured `isPrivateIP` returning
// FALSE for. The oracle was RIGHT where production was WRONG, and an oracle that
// calls the thing it checks cannot ever be. So it stays independent, it was widened
// from the IANA registry rather than from production's source, and the comparison
// lives here.

// --- test-local CIDR / interval arithmetic ------------------------------------
// Deliberately NOT imported from `egress-policy.ipInCidr` or the deny-set module:
// both are under test here, and a bug in either must not be able to hide itself.

const v4ToInt = (ip: string): number =>
  ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);

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
  for (let i = 7; i >= 0; i--) words.push(((v >> BigInt(i * 16)) & 0xffffn).toString(16));
  return words.join(":");
}

interface Iv {
  lo: bigint;
  hi: bigint;
}

const toIv6 = (cidr: string): Iv => {
  const [base, prefix] = cidr.split("/");
  const lo = v6ToInt(base!);
  return { lo, hi: lo + (1n << (128n - BigInt(prefix!))) - 1n };
};

function normalize(ivs: readonly Iv[]): Iv[] {
  const sorted = [...ivs].sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0));
  const out: Iv[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.lo <= last.hi + 1n) {
      if (iv.hi > last.hi) last.hi = iv.hi;
    } else out.push({ ...iv });
  }
  return out;
}

function subtract(a: readonly Iv[], b: readonly Iv[]): Iv[] {
  let cur = a.map((x) => ({ ...x }));
  for (const cut of b) {
    const next: Iv[] = [];
    for (const iv of cur) {
      if (cut.hi < iv.lo || cut.lo > iv.hi) {
        next.push(iv);
        continue;
      }
      if (cut.lo > iv.lo) next.push({ lo: iv.lo, hi: cut.lo - 1n });
      if (cut.hi < iv.hi) next.push({ lo: cut.hi + 1n, hi: iv.hi });
    }
    cur = next;
  }
  return cur;
}

const showIvs = (ivs: readonly Iv[]): string[] =>
  ivs.map((iv) => `${intToV6(iv.lo)} .. ${intToV6(iv.hi)}`);

const containedIn = (needle: Iv, hay: readonly Iv[]): boolean =>
  hay.some((iv) => iv.lo <= needle.lo && iv.hi >= needle.hi);

// --- THE IPv6 COVER, RE-DERIVED FROM THE LIVE PREDICATE -----------------------
//
// A recursive uniformity descent over the leading four 16-bit words. At each node
// the next word is swept EXHAUSTIVELY (all 65536 values) against a FILL BASIS for
// the words below it; a child whose verdict is unanimous across the basis becomes a
// leaf, a child that disagrees is descended into. The result is the exact minimal
// prefix cover of the predicate's IPv6 arm.
//
// ★ THE METHOD'S TWO LIMITS, STATED RATHER THAN PAPERED OVER.
//   (a) GRANULARITY. The descent stops at four words, so it cannot see a rule finer
//       than /64. That is EXACT for `isPrivateIP`, whose IPv6 arm reads only
//       `words[0..3]` outside `::/64` -- and that is not assumed here, it is the
//       subject of the "reads only the first four words" test below, which fails if
//       a future clause reaches deeper. (Inside `::/64` the predicate DOES read
//       deeper, to unwrap `::ffff:a.b.c.d`; the whole /64 is denied either way,
//       except for the mapped-PUBLIC class that `w13-oauth-deny-table-divergence.test.ts`
//       owns, so the cover is unaffected.)
//   (b) THE FILL BASIS. A rule that fired only on a fill value not in the basis
//       would be missed. The randomized 128-bit differential sweep at the end of
//       this file is the backstop for that: it samples the space directly, with no
//       structural assumption at all.
const FILL_BASIS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [0, 0, 1],
  [1, 0, 0],
  [0xff9b, 0, 0],
  [0xff9b, 1, 0],
  [0, 0, 0xffff],
  [0x0db8, 0, 1],
  [0xffff, 0xffff, 0xffff],
  [0x0002, 0, 0],
  [0x0010, 0, 0],
  [0x1234, 0x5678, 0x9abc],
  [2, 3, 4],
];
const LOW_64 = "0:0:0:1";
const renderPrefix = (words: readonly number[]): string =>
  `${words.map((w) => w.toString(16)).join(":")}:${LOW_64}`;

function deriveIpv6Cover(pred: (ip: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (prefix: number[]): void => {
    const depth = prefix.length;
    if (depth === 4) {
      if (pred(renderPrefix(prefix))) {
        out.push(`${prefix.map((w) => w.toString(16)).join(":")}:0:0:0:0/64`);
      }
      return;
    }
    const verdict = new Int8Array(65536); // -1 mixed, 0 false, 1 true
    for (let w = 0; w < 65536; w++) {
      let seen: number | null = null;
      let mixed = false;
      for (const fill of FILL_BASIS) {
        const tail = fill.slice(fill.length - (3 - depth));
        const v = pred(renderPrefix([...prefix, w, ...tail])) ? 1 : 0;
        if (seen === null) seen = v;
        else if (seen !== v) {
          mixed = true;
          break;
        }
      }
      verdict[w] = mixed ? -1 : seen!;
    }
    let i = 0;
    while (i < 65536) {
      if (verdict[i] === -1) {
        walk([...prefix, i]);
        i++;
        continue;
      }
      if (verdict[i] === 0) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < 65536 && verdict[j + 1] === 1) j++;
      let lo = i;
      while (lo <= j) {
        let size = 1;
        while (lo % (size * 2) === 0 && lo + size * 2 - 1 <= j) size *= 2;
        const bits = depth * 16 + (16 - Math.log2(size));
        const words = [...prefix, lo, ...Array<number>(8 - depth - 1).fill(0)];
        out.push(`${words.map((w) => w.toString(16)).join(":")}/${bits}`);
        lo += size;
      }
      i = j + 1;
    }
  };
  walk([]);
  return out;
}

let cachedCover: string[] | null = null;
/** The live predicate's IPv6 cover, derived once and reused across cases. */
function liveIpv6Cover(): string[] {
  cachedCover ??= deriveIpv6Cover(isPrivateIP);
  return cachedCover;
}

/** The IPv4 /24 rejection bitmap of the live predicate, swept once (2^24). */
let cachedV4Bits: Uint8Array | null = null;
function liveIpv4Bits(): Uint8Array {
  if (cachedV4Bits) return cachedV4Bits;
  const bits = new Uint8Array(1 << 24);
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      for (let c = 0; c < 256; c++) {
        if (isPrivateIP(`${a}.${b}.${c}.7`)) bits[(a << 16) | (b << 8) | c] = 1;
      }
    }
  }
  cachedV4Bits = bits;
  return bits;
}

// --- THE PRE-W17 COVERS (historical fixtures, not policy) ---------------------
// Transcribed from `INTERNAL_RANGE_DENY_CIDRS_*` at 13caa3227, the commit this unit
// branched from. They exist so "what moved" is a MEASURED difference rather than an
// assertion. Both were themselves re-derivations of `isPrivateIP` on that commit.
const PRE_W17_V4: readonly string[] = [
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
];
const PRE_W17_V6: readonly string[] = [
  "::/16",
  "64:ff9b::/47",
  "100::/64",
  "2001::/32",
  "2001:2::/32",
  "2001:10::/28",
  "2001:20::/28",
  "2001:db8::/32",
  "2002::/16",
  "3ff0::/12",
  "fc00::/7",
  "fe80::/9",
  "ff00::/8",
];

// --- THE IANA SNAPSHOT --------------------------------------------------------
//
// Retrieved 2026-09-08. sha256 of the CSV as served:
//   IPv4 e3e39e76d00b1677335db8e9a805c7b9480ea2f4dc9e33f0b93cd3a905128d73
//        https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv
//   IPv6 775feea0621dec8735a44fbf30f762e721e8f0a1b3ab7eb341961a88cfce2139
//        https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv
//
// Only the rows whose `Globally Reachable` column is FALSE are listed: those are the
// blocks a destination cannot legitimately live in, and therefore the ones this
// predicate has to cover. Rows whose column reads TRUE, N/A or blank are OUT OF
// SCOPE for the coverage assertion -- some of them (6to4, NAT64, ORCHIDv2, the
// deprecated 6to4 relay) this predicate denies anyway as tunnel/identifier space,
// which is a deny-MORE choice and is pinned by the exact-cover test, not here.
export const IANA_V4_NOT_GLOBALLY_REACHABLE: ReadonlyArray<readonly [string, string]> = [
  ["0.0.0.0/8", 'RFC791 "This network"'],
  ["0.0.0.0/32", 'RFC1122 "This host on this network"'],
  ["10.0.0.0/8", "RFC1918 private-use"],
  ["100.64.0.0/10", "RFC6598 shared address space (CGNAT)"],
  ["127.0.0.0/8", "RFC1122 loopback"],
  ["169.254.0.0/16", "RFC3927 link-local (cloud IMDS lives here)"],
  ["172.16.0.0/12", "RFC1918 private-use"],
  ["192.0.0.0/24", "RFC6890 IETF protocol assignments"],
  ["192.0.0.0/29", "RFC7335 IPv4 service continuity"],
  ["192.0.0.8/32", "RFC7600 IPv4 dummy address"],
  ["192.0.0.170/32", "RFC8880 NAT64/DNS64 discovery"],
  ["192.0.0.171/32", "RFC8880 NAT64/DNS64 discovery"],
  ["192.0.2.0/24", "RFC5737 TEST-NET-1"],
  ["192.88.99.2/32", "RFC6751 6a44-relay anycast"],
  ["192.168.0.0/16", "RFC1918 private-use"],
  ["198.18.0.0/15", "RFC2544 benchmarking"],
  ["198.51.100.0/24", "RFC5737 TEST-NET-2"],
  ["203.0.113.0/24", "RFC5737 TEST-NET-3"],
  ["240.0.0.0/4", "RFC1112 reserved"],
  ["255.255.255.255/32", "RFC919 limited broadcast"],
];

export const IANA_V6_NOT_GLOBALLY_REACHABLE: ReadonlyArray<readonly [string, string]> = [
  ["::1/128", "RFC4291 loopback"],
  ["::/128", "RFC4291 unspecified"],
  ["::ffff:0:0/96", "RFC4291 IPv4-mapped"],
  ["64:ff9b:1::/48", "RFC8215 NAT64 local-use"],
  ["100::/64", "RFC6666 discard-only"],
  ["100:0:0:1::/64", "RFC9780 Dummy Prefix (allocated 2025-04)"],
  ["2001::/23", "RFC2928 IETF protocol assignments"],
  ["2001:2::/48", "RFC5180 benchmarking"],
  ["2001:db8::/32", "RFC3849 documentation"],
  ["3fff::/20", "RFC9637 documentation"],
  ["5f00::/16", "RFC9602 SRv6 SIDs (allocated 2024-04)"],
  ["fc00::/7", "RFC4193 unique-local"],
  ["fe80::/10", "RFC4291 link-local unicast"],
];

/**
 * The registry rows `isPrivateIP` deliberately does NOT cover. Each needs a reason
 * that survives a hostile read, because "we skipped a not-globally-reachable block"
 * is otherwise indistinguishable from the gap this unit exists to close.
 */
const DELIBERATE_COVERAGE_EXCEPTIONS: Readonly<Record<string, string>> = {
  "::ffff:0:0/96":
    "isPrivateIP UNWRAPS a mapped address and judges the embedded IPv4 on its merits, " +
    "so ::ffff:<public v4> is allowed. That is the intended semantic (the mapped and " +
    "bare spellings must get one answer) and it is pinned by the two IPv4-MAPPED cases " +
    "in w13-oauth-deny-table-divergence.test.ts. The CIDR list rendered from this " +
    "predicate DOES deny the whole /96, deliberately.",
  "2001::/23":
    "The superblock reads Globally Reachable = FALSE, but every ASSIGNED sub-block in " +
    "the part not already covered reads TRUE: 2001:1::1/128 PCP anycast (RFC7723), " +
    "2001:1::2/128 TURN anycast (RFC8155), 2001:1::3/128 DNS-SD SRP anycast (RFC9665), " +
    "2001:3::/32 AMT (RFC7450), 2001:4:112::/48 AS112-v6 (RFC7535), 2001:30::/28 DRIP " +
    "DETs (RFC9374). Covering the /23 would deny real routed destinations and close " +
    "nothing. Two independent audits examined it and both recommended against.",
};

// --- 1. THE AUDIT, AS A CHECK -------------------------------------------------

describe("W17 -- IANA special-purpose coverage", () => {
  it("IPv4: every Globally-Reachable-FALSE block is covered, with ZERO exceptions", () => {
    const bits = liveIpv4Bits();
    const uncovered: string[] = [];
    for (const [cidr, why] of IANA_V4_NOT_GLOBALLY_REACHABLE) {
      const [base, prefixStr] = cidr.split("/");
      const prefix = Number(prefixStr);
      const lo = v4ToInt(base!);
      const hi = lo + 2 ** (32 - prefix) - 1;
      if (prefix <= 24) {
        for (let block = lo >>> 8; block <= hi >>> 8; block++) {
          if (!bits[block]) {
            uncovered.push(`${cidr} (${why}) -- /24 block ${block} not rejected`);
            break;
          }
        }
      } else {
        for (let v = lo; v <= hi; v++) {
          const ip = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
          if (!isPrivateIP(ip)) {
            uncovered.push(`${cidr} (${why}) -- ${ip} not rejected`);
            break;
          }
        }
      }
    }
    expect(uncovered).toEqual([]);
    // ANTI-VACUITY: the loop above must actually have had rows to check.
    expect(IANA_V4_NOT_GLOBALLY_REACHABLE.length).toBe(20);
  }, 120_000);

  it("IPv6: every Globally-Reachable-FALSE block is covered, except the TWO justified rows", () => {
    // ★ TWO VIEWS, BOTH CHECKED, BECAUSE THEY DIFFER AND THE DIFFERENCE IS THE
    // WHOLE `::ffff:` EXCEPTION. The predicate UNWRAPS a mapped address and judges
    // the embedded IPv4; the CIDR list rendered from it cannot, because a CIDR list
    // is handed to an outside matcher that only compares numbers. Checking only one
    // view would silently excuse a real gap in the other.
    //
    // VIEW A -- the CIDR list an outside matcher (node:net BlockList, a firewall
    // rule, a provider network body) receives. `::/16` numerically contains the
    // whole mapped /96, so the only registry row this view misses is 2001::/23.
    const cover = normalize(liveIpv6Cover().map(toIv6));
    const uncoveredByList = IANA_V6_NOT_GLOBALLY_REACHABLE.filter(
      ([cidr]) => !containedIn(toIv6(cidr), cover),
    ).map(([cidr]) => cidr);
    expect(uncoveredByList).toEqual(["2001::/23"]);

    // VIEW B -- the predicate itself, probed at the edges and the interior of every
    // row. This is what an SSRF actually calls.
    const uncoveredByPredicate: string[] = [];
    for (const [cidr] of IANA_V6_NOT_GLOBALLY_REACHABLE) {
      const { lo, hi } = toIv6(cidr);
      // Edges, midpoint AND quarter points. The quarter points are load-bearing:
      // with only lo/hi/mid, the `::ffff:0:0/96` row passes -- 0.0.0.0, 0.0.0.1,
      // 255.255.255.255 and the midpoint 127.255.255.255 are ALL private, so a
      // sample that never lands on a mapped-PUBLIC address reports full coverage of
      // a row this predicate deliberately leaves half open. Measured, not guessed.
      const span = hi - lo;
      const probes = [lo, hi, lo + 1n, lo + (span >> 1n), lo + (span >> 2n), hi - (span >> 2n)];
      if (probes.some((v) => !isPrivateIP(intToV6(v)))) uncoveredByPredicate.push(cidr);
    }
    expect(uncoveredByPredicate).toEqual(["::ffff:0:0/96", "2001::/23"]);

    // The exception list is not a free pass: it must be EXACTLY the union of the two
    // uncovered sets. A range that stops being covered shows up here as an
    // unexplained row; a range that starts being covered leaves a stale exception,
    // which also reds.
    expect([...new Set([...uncoveredByList, ...uncoveredByPredicate])].sort()).toEqual(
      Object.keys(DELIBERATE_COVERAGE_EXCEPTIONS).sort(),
    );
    for (const key of Object.keys(DELIBERATE_COVERAGE_EXCEPTIONS)) {
      expect(DELIBERATE_COVERAGE_EXCEPTIONS[key]!.length).toBeGreaterThan(120);
    }

    // And the `::ffff:` exception is EXACTLY "the embedded IPv4 is public", not a
    // hole in the mapped form as such -- generated, not described.
    expect(isPrivateIP("::ffff:8.8.8.8")).toBe(false); // mapped PUBLIC -> allowed
    expect(isPrivateIP("8.8.8.8")).toBe(false); // ...same answer as the bare form
    expect(isPrivateIP("::ffff:169.254.169.254")).toBe(true); // mapped PRIVATE -> denied
    expect(containedIn(toIv6("::ffff:0:0/96"), cover)).toBe(true); // the LIST denies it all
  }, 120_000);

  it("the two ranges W17 added are the two the audit named, and they are LIVE", () => {
    // Predicate-level, not list-level: this is the thing an SSRF actually calls.
    expect(isPrivateIP("5f00::1")).toBe(true); // RFC9602 SRv6 SIDs
    expect(isPrivateIP("5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
    expect(isPrivateIP("100:0:0:1::1")).toBe(true); // RFC9780 Dummy Prefix
    expect(isPrivateIP("100:0:0:1:ffff:ffff:ffff:ffff")).toBe(true);
    // ...and the addresses immediately outside them are still PUBLIC, so the fix is
    // a range and not a blanket.
    expect(isPrivateIP("5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(false);
    expect(isPrivateIP("5f01::1")).toBe(false);
    expect(isPrivateIP("100:0:0:2::1")).toBe(false);
  });

  it("★ the NAT64 network-specific prefix is a STRUCTURAL limit, not a gap", () => {
    // RFC6052 lets an operator translate through a prefix taken from their OWN
    // global unicast allocation (/32../96). It is not in any registry, it is not
    // syntactically marked, and no prefix list can ever close it. This case exists
    // so the next reader who notices "NAT64 can reach IMDS" does not file it as a
    // missing range and add a speculative block.
    //
    // 2001:4860:4860::/48 is a real Google allocation; an operator NAT64 inside it
    // translating 169.254.169.254 spells as ...:a9fe:a9fe. Both implementations
    // ALLOW it, correctly: it is an ordinary global unicast address.
    const operatorNat64 = "2001:4860:4860:0:0:0:a9fe:a9fe";
    expect(isPrivateIP(operatorNat64)).toBe(false);
    expect(oracleIsPrivateIp(operatorNat64)).toBe(false);
    // The WELL-KNOWN prefixes are fixed and therefore ARE closable -- and are closed.
    expect(isPrivateIP("64:ff9b::169.254.169.254")).toBe(true);
    expect(isPrivateIP("64:ff9b:1::169.254.169.254")).toBe(true);
    // The mechanism that CAN close the operator-chosen case is the positive
    // allowlist in classifyEgressDestination, not this blocklist.
  });
});

// --- 2. THE BLAST RADIUS ------------------------------------------------------

describe("W17 -- blast radius: what moved, exactly", () => {
  it("IPv4: the arm is UNTOUCHED -- zero of the 2^32 addresses changed class", () => {
    // Swept at /24 granularity, which is exhaustive over 2^32 given the separate
    // fourth-octet-constancy assertion in w10c-internal-range-deny-set.test.ts.
    const preRanges = PRE_W17_V4.map((cidr) => {
      const [base, prefix] = cidr.split("/");
      const lo = v4ToInt(base!);
      return { lo, hi: lo + 2 ** (32 - Number(prefix)) - 1 };
    });
    const bits = liveIpv4Bits();
    const nowAllowedWasDenied: string[] = [];
    const nowDeniedWasAllowed: string[] = [];
    for (let block = 0; block < 1 << 24; block++) {
      const addr = block * 256 + 7;
      const before = preRanges.some((r) => addr >= r.lo && addr <= r.hi);
      const after = bits[block] === 1;
      if (before && !after && nowAllowedWasDenied.length < 8) {
        nowAllowedWasDenied.push(`${(block >>> 16) & 255}.${(block >>> 8) & 255}.${block & 255}.0/24`);
      }
      if (!before && after && nowDeniedWasAllowed.length < 8) {
        nowDeniedWasAllowed.push(`${(block >>> 16) & 255}.${(block >>> 8) & 255}.${block & 255}.0/24`);
      }
    }
    expect(nowAllowedWasDenied).toEqual([]);
    expect(nowDeniedWasAllowed).toEqual([]);
    // And the rendered IPv4 cover is byte-identical to the pre-W17 one.
    expect([...INTERNAL_RANGE_DENY_CIDRS_V4]).toEqual([...PRE_W17_V4]);
  }, 120_000);

  it("IPv6: NOTHING moved denied -> allowed, anywhere in the 2^128 space", () => {
    const before = normalize(PRE_W17_V6.map(toIv6));
    const after = normalize(liveIpv6Cover().map(toIv6));
    expect(showIvs(subtract(before, after))).toEqual([]);
  }, 120_000);

  it("IPv6: the allowed -> denied set is EXACTLY the two ranges, 2^64 + 2^112 addresses", () => {
    const before = normalize(PRE_W17_V6.map(toIv6));
    const after = normalize(liveIpv6Cover().map(toIv6));
    const added = subtract(after, before);
    expect(showIvs(added)).toEqual([
      "100:0:0:1:0:0:0:0 .. 100:0:0:1:ffff:ffff:ffff:ffff", // RFC9780 Dummy Prefix
      "5f00:0:0:0:0:0:0:0 .. 5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff", // RFC9602 SRv6 SIDs
    ]);
    const total = added.reduce((acc, iv) => acc + (iv.hi - iv.lo + 1n), 0n);
    expect(total).toBe((1n << 64n) + (1n << 112n));
  }, 120_000);

  it("the derived deny set IS the live predicate's cover -- re-derived, not transcribed", () => {
    // ★ THE PIN THE BRIEF NAMES. `INTERNAL_RANGE_DENY_CIDRS_V6` is what the live
    // OAuth SSRF BlockList is built from. It is asserted here against a cover
    // RECOMPUTED from `isPrivateIP` on every run, so it cannot be hand-edited to
    // match an assumption. It is also what produced `100::/63`: the RFC9780 Dummy
    // Prefix is adjacent and aligned to the RFC6666 discard block, so the exact
    // minimal cover of the two is ONE /63, not the two /64s a hand edit writes.
    expect(liveIpv6Cover()).toEqual([
      "0:0:0:0:0:0:0:0/16",
      "64:ff9b:0:0:0:0:0:0/47",
      "100:0:0:0:0:0:0:0/63",
      "2001:0:0:0:0:0:0:0/32",
      "2001:2:0:0:0:0:0:0/32",
      "2001:10:0:0:0:0:0:0/28",
      "2001:20:0:0:0:0:0:0/28",
      "2001:db8:0:0:0:0:0:0/32",
      "2002:0:0:0:0:0:0:0/16",
      "3ff0:0:0:0:0:0:0:0/12",
      "5f00:0:0:0:0:0:0:0/16",
      "fc00:0:0:0:0:0:0:0/7",
      "fe80:0:0:0:0:0:0:0/9",
      "ff00:0:0:0:0:0:0:0/8",
    ]);
    // Same set, in the deny-set module's own compressed spelling.
    const derived = normalize(liveIpv6Cover().map(toIv6));
    const shipped = normalize([...INTERNAL_RANGE_DENY_CIDRS_V6].map(toIv6));
    expect(showIvs(subtract(derived, shipped))).toEqual([]);
    expect(showIvs(subtract(shipped, derived))).toEqual([]);
  }, 120_000);

  it("isPrivateIP's IPv6 arm reads only the first four words (outside ::/64)", () => {
    // The premise the /64-granular derivation rests on. If a future clause keys on
    // words[4..7] outside ::/64, the cover silently loses resolution -- so the
    // premise is CHECKED, not documented.
    const prefixes: Array<[number, number, number, number]> = [];
    for (const w0 of [0x0064, 0x0100, 0x2001, 0x2002, 0x3ff0, 0x3fff, 0x5f00, 0xfc00, 0xfe80, 0xfec0, 0xff02, 0x2606, 0x0001, 0x5eff, 0x5f01]) {
      for (const w1 of [0, 1, 2, 0x0010, 0x0020, 0x0db8, 0xff9b, 0xffff]) {
        for (const w2 of [0, 1, 0xffff]) {
          for (const w3 of [0, 1, 2, 0xffff]) prefixes.push([w0, w1, w2, w3]);
        }
      }
    }
    const lows = ["0:0:0:0", "0:0:0:1", "1:2:3:4", "ffff:ffff:ffff:ffff", "0:ffff:8:8", "dead:beef:0:1"];
    const violations: string[] = [];
    for (const p of prefixes) {
      const head = p.map((w) => w.toString(16)).join(":");
      const base = isPrivateIP(`${head}:${lows[0]}`);
      for (const low of lows.slice(1)) {
        const ip = `${head}:${low}`;
        if (isPrivateIP(ip) !== base && violations.length < 10) violations.push(ip);
      }
    }
    expect(violations).toEqual([]);
    expect(prefixes.length).toBeGreaterThan(1000); // anti-vacuity
  });
});

// --- 3. THE DIFFERENTIAL ORACLE: THE EXACT DIVERGENCE SET ---------------------

describe("W17 -- production vs the independent oracle, exact over 2^128", () => {
  const oracleIvs = () => normalize(ORACLE_IPV6_CIDRS.map(toIv6));
  const prodIvs = () => normalize(liveIpv6Cover().map(toIv6));

  it("★ ORACLE-ONLY IS EMPTY: production denies everything the oracle denies", () => {
    // THIS is the assertion that reds on a NARROWING of production. Delete any
    // clause from isPrivateIP's IPv6 arm and the range appears here, named, because
    // the oracle still denies it. It is empty today, and it is empty as a COMPUTED
    // result over the whole address space -- not as agreement over a corpus.
    expect(showIvs(subtract(oracleIvs(), prodIvs()))).toEqual([]);
  }, 120_000);

  it("★ PRODUCTION-ONLY IS EXACTLY FOUR INTERVALS -- the set, stated", () => {
    // Production deliberately denies WIDER blocks than the registry rows in three
    // bands. Stating the set rather than asserting agreement is the point: each of
    // these is a decision someone made, and a fifth interval appearing here means
    // production started over-blocking something new.
    expect(showIvs(subtract(prodIvs(), oracleIvs()))).toEqual([
      // 64:ff9b::/47 vs RFC6052's 64:ff9b::/96 + RFC8215's 64:ff9b:1::/48.
      // Production denies the whole /48 pair; the well-known prefix is only a /96.
      "64:ff9b:0:0:0:1:0:0 .. 64:ff9b:0:ffff:ffff:ffff:ffff:ffff",
      // 2001:2::/32 vs RFC5180's 2001:2::/48 benchmarking assignment.
      "2001:2:1:0:0:0:0:0 .. 2001:2:ffff:ffff:ffff:ffff:ffff:ffff",
      // 3ff0::/12 vs RFC9637's 3fff::/20 documentation assignment. The band
      // includes 3ffe::/16, the returned 6bone allocation.
      "3ff0:0:0:0:0:0:0:0 .. 3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "3fff:1000:0:0:0:0:0:0 .. 3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ]);
  }, 120_000);

  // ★ THE THREE SHAPES A PRODUCTION IMPORT CAN TAKE, each with a fixture it is KNOWN
  // to match. W17-BACKSPACE: two of these patterns shipped carrying a RAW 0x08
  // BACKSPACE byte where the `\b` word-boundary escape was intended. A backspace
  // renders invisibly in every editor, every terminal and every diff view, so three
  // agents and a reviewer read these lines and only one caught it -- and the old
  // anti-vacuity clause (`specifiers.length > 0`) was satisfied by the STATIC matches
  // ALONE, so two dead patterns cost nothing and the guard would have passed GREEN on
  // an oracle that loaded production dynamically. An anti-vacuity check that its own
  // siblings satisfy is not an anti-vacuity check. Each pattern is now proven alive
  // against its own fixture, in its OWN NAMED TEST, so a dead one reds by name.
  const PRODUCTION_SPECIFIER = "../server/src/services/outbound-url-guard.js";
  const SPECIFIER_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; fixture: string }> = [
    {
      name: "static `import ... from`",
      re: /^\s*(?:import|export)[^;]*?\sfrom\s+["']([^"']+)["']/gm,
      fixture: `import { isPrivateIP } from "${PRODUCTION_SPECIFIER}";`,
    },
    {
      name: "dynamic `import(...)`",
      re: /\bimport\(\s*["']([^"']+)["']\s*\)/g,
      fixture: `const { isPrivateIP } = await import("${PRODUCTION_SPECIFIER}");`,
    },
    {
      name: "`require(...)`",
      re: /\brequire\(\s*["']([^"']+)["']\s*\)/g,
      fixture: `const { isPrivateIP } = require("${PRODUCTION_SPECIFIER}");`,
    },
  ];
  // ONE scanner, shared by the real-file check and by the rejection proof below, so the
  // proof cannot succeed against a copy of the logic that the real check does not run.
  const specifiersIn = (text: string): string[] =>
    SPECIFIER_PATTERNS.flatMap((p) => [...text.matchAll(p.re)].map((m) => m[1]!));
  const readOracleSource = (): string =>
    readFileSync(join(__dirname, "../../../scripts/check-egress-policy-vectors.mjs"), "utf8");

  it.each(
    SPECIFIER_PATTERNS.map(
      (p) => [p.name, p] as [string, (typeof SPECIFIER_PATTERNS)[number]],
    ),
  )("PER-PATTERN ANTI-VACUITY: the %s matcher can still match", (name, pattern) => {
    expect(
      [...pattern.fixture.matchAll(pattern.re)].map((m) => m[1]!),
      `specifier pattern ${name} matched NOTHING in a string it is known to match -- ` +
        `it is DEAD, and the independence scan below is silently blind to that shape`,
    ).toEqual([PRODUCTION_SPECIFIER]);
  });

  it("the oracle is still INDEPENDENT: it imports nothing from server/src", () => {
    // The guard on the guard. If someone "fixes" the oracle by importing the
    // predicate, the divergence sets above become vacuously empty and the only
    // mechanism that has ever caught this class here is gone. That is a source-text
    // property, so it is checked as one.
    const source = readOracleSource();
    // IMPORT STATEMENTS ONLY -- the file NAMES production modules in its comments on
    // purpose (that is where it explains what it diverges from), so a raw substring
    // scan would red on the documentation and teach the next author to delete it.
    const specifiers = specifiersIn(source);
    // Aggregate floor. This is NOT the anti-vacuity clause any more -- the per-pattern
    // cases above are; this only says the oracle still has imports to inspect at all.
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec.startsWith("node:"), `oracle imports non-node module ${spec}`).toBe(true);
    }
    // ...and it must still be a real implementation, not a stub.
    expect(ORACLE_IPV6_CIDRS.length).toBeGreaterThanOrEqual(17);
  });

  it("★ THE GUARD IS OBSERVED REFUSING: every import shape, injected into a COPY, is caught", () => {
    // Until now this guard had only ever been run against a file that PASSES, which
    // proves nothing about what it would do with a violation -- the exact class this
    // programme exists to catch. Here it is shown rejecting one. The injection happens
    // in a fixture STRING; the file on disk is never written.
    const source = readOracleSource();
    const offenders = (text: string): string[] =>
      specifiersIn(text).filter((s) => !s.startsWith("node:"));
    // POSITIVE CONTROL: the real oracle, unmodified, is clean.
    expect(offenders(source), "the real oracle already imports a non-node module").toEqual([]);
    // ...and each shape a future author might reach for is refused, BY SPECIFIER.
    for (const pattern of SPECIFIER_PATTERNS) {
      expect(
        offenders(`${source}\n${pattern.fixture}\n`),
        `a production import written as ${pattern.name} was NOT caught by the independence scan`,
      ).toEqual([PRODUCTION_SPECIFIER]);
    }
  });

  it("RANDOMIZED BACKSTOP: every sampled disagreement lands inside the pinned set", () => {
    // The derivation above is structural (it assumes the four-word premise proven
    // earlier and a fill basis). This samples the raw 2^128 space with no structural
    // assumption at all, so a clause the descent could not see still shows up.
    const divergence = subtract(prodIvs(), oracleIvs());
    const reverse = subtract(oracleIvs(), prodIvs());
    const rnd = (): bigint => {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 16n) | BigInt(Math.floor(Math.random() * 65536));
      return v;
    };
    const samples: string[] = [];
    for (const cidr of [...ORACLE_IPV6_CIDRS, ...INTERNAL_RANGE_DENY_CIDRS_V6]) {
      const { lo, hi } = toIv6(cidr);
      samples.push(intToV6(lo), intToV6(hi), intToV6(lo + 1n), intToV6(hi + 1n));
      if (lo > 0n) samples.push(intToV6(lo - 1n));
    }
    for (let i = 0; i < 40_000; i++) samples.push(intToV6(rnd()));
    let disagreements = 0;
    const unexplained: string[] = [];
    for (const ip of samples) {
      const p = isPrivateIP(ip);
      const o = oracleIsPrivateIp(ip) as boolean;
      if (p === o) continue;
      disagreements++;
      const v = v6ToInt(ip);
      const inSet = (p ? divergence : reverse).some((iv) => v >= iv.lo && v <= iv.hi);
      if (!inSet && unexplained.length < 10) unexplained.push(`${ip} prod=${p} oracle=${o}`);
    }
    expect(unexplained).toEqual([]);
    // ANTI-VACUITY. The pinned divergence is non-empty, so the boundary probes MUST
    // generate real disagreements. If this ever reads 0 the case above proves nothing.
    expect(disagreements).toBeGreaterThan(0);
  }, 120_000);
});

// --- 4. POSITIVE CONTROLS -----------------------------------------------------

describe("W17 -- legitimate destinations stay reachable", () => {
  // A predicate that denied everything would pass every test above. These are the
  // address families AoA's real destinations live in: model APIs, package
  // registries, OAuth issuers, git hosts, webhook targets, the marketplace CDN.
  it.each([
    ["2606:4700:4700::1111", "Cloudflare DNS / Cloudflare edge (many SaaS OAuth issuers)"],
    ["2001:4860:4860::8888", "Google DNS"],
    ["2600:1f18::1", "AWS"],
    ["2a00:1450:4001::1", "Google"],
    ["2620:119:35::35", "OpenDNS"],
    ["2606:50c0:8000::153", "GitHub Pages (the marketplace CDN's origin family)"],
    ["2a04:4e42::396", "Fastly (registry.npmjs.org's CDN family)"],
    ["2001:1::1", "RFC7723 PCP anycast -- inside 2001::/23, Globally Reachable = TRUE"],
    ["2001:3::1", "RFC7450 AMT -- inside 2001::/23, Globally Reachable = TRUE"],
    ["2001:30::1", "RFC9374 DRIP DETs -- inside 2001::/23, Globally Reachable = TRUE"],
    ["5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "immediately below 5f00::/16"],
    ["5f01::1", "immediately above 5f00::/16"],
    ["100:0:0:2::1", "immediately above the RFC9780 Dummy Prefix"],
    ["4000::1", "ordinary global unicast above the 3ff0 band"],
  ])("allows %s (%s), in BOTH implementations", (ip) => {
    expect(isPrivateIP(ip), `isPrivateIP ${ip}`).toBe(false);
    expect(oracleIsPrivateIp(ip) as boolean, `oracle ${ip}`).toBe(false);
  });

  it("IPv4 destinations are untouched by this unit", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "104.18.0.1", // Cloudflare edge (api.anthropic.com and many OAuth issuers)
      "140.82.121.4", // GitHub
      "185.199.108.153", // GitHub Pages
      "104.16.0.1", // registry.npmjs.org
      "172.32.0.1", // just outside RFC1918 172.16/12
      "100.128.0.1", // just outside CGNAT 100.64/10
      "192.88.100.1", // just outside the 6to4 relay /24
    ]) {
      expect(isPrivateIP(ip), ip).toBe(false);
      expect(oracleIsPrivateIp(ip) as boolean, ip).toBe(false);
    }
  });
});
