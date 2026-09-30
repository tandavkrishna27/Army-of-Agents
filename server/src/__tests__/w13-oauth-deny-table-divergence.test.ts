import { BlockList } from "node:net";
import { describe, expect, it } from "vitest";

import { isBlockedOAuthAddress } from "../services/mcp-connector-oauth.js";
import { isPrivateIP } from "../services/outbound-url-guard.js";
import {
  INTERNAL_RANGE_DENY_CIDRS,
  INTERNAL_RANGE_DENY_CIDRS_V4,
  INTERNAL_RANGE_DENY_CIDRS_V6,
} from "../services/w10c-internal-range-deny-set.js";

// W13 -- THE OAUTH SSRF DENY TABLE: SUPERSET PROOF AND EXACT BLAST RADIUS.
//
// E8-F009 measured, by a full 2^24 sweep reproduced twice, that
// `mcp-connector-oauth.ts`'s hand-typed `BlockList` tables diverged from
// `isPrivateIP` -- this repo's reference "is this address internal" predicate -- on
// one IPv4 /24 and eight IPv6 classes. W13 rebuilt those tables from
// `INTERNAL_RANGE_DENY_CIDRS`, the mechanically derived cover of that predicate.
//
// WHAT THIS FILE HAS TO PROVE, IN ORDER OF WHAT COULD GO WRONG:
//   1. NOTHING MOVED DENIED -> ALLOWED. A security change that silently un-blocks
//      something is worse than the gap it closes. Proven EXHAUSTIVELY: a 2^24 sweep
//      for IPv4, and exact interval arithmetic over the whole 2^128 space for IPv6.
//   2. THE ALLOWED -> DENIED SET IS EXACTLY THE ENUMERATED CLASSES AND NOTHING ELSE.
//      This is the anti-regression half: it is what reds if a future edit denies a
//      PUBLIC address. "Deny more" is not the goal; "deny exactly the right more" is.
//   3. The live table agrees with `isPrivateIP` in BOTH directions -- EXCEPT for ONE
//      enumerated class, `::ffff:<public v4>`, where the table denies and the predicate
//      allows. That exception is PRE-EXISTING (identical before and after W13), it is a
//      DENY-MORE divergence, and section 3 EXERCISES it rather than only describing it.
//      An unqualified "agrees in both directions" would be a FALSE claim that passes only
//      because no probe generates the falsifying case -- so it is not made here.
//
// WHAT IT DELIBERATELY DOES NOT DO: reimplement `isPrivateIP` or the table. Both are
// imported from the modules that ship them. A reimplementation is what produced the
// divergence being closed here.

// --- the table as it shipped BEFORE W13 --------------------------------------
// A historical fixture, not a policy: it exists only so "what moved" is a measured
// difference rather than an assertion. Transcribed from `mcp-connector-oauth.ts` at
// cfcd9e280.
const PRE_W13_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const PRE_W13_V6: ReadonlyArray<readonly [string, number]> = [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["100::", 64],
  ["2001::", 32], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
];
const preV4 = new BlockList();
for (const [n, p] of PRE_W13_V4) preV4.addSubnet(n, p, "ipv4");
const preV6 = new BlockList();
for (const [n, p] of PRE_W13_V6) preV6.addSubnet(n, p, "ipv6");
const blockedBefore = (ip: string): boolean =>
  ip.includes(":") ? preV6.check(ip, "ipv6") : preV4.check(ip, "ipv4");

// --- test-local CIDR arithmetic (BigInt), not imported from anything under test ---
const v4ToInt = (ip: string): bigint =>
  ip.split(".").reduce((a, o) => (a << 8n) | BigInt(Number(o)), 0n);
const intToV4 = (v: bigint): string =>
  [(v >> 24n) & 255n, (v >> 16n) & 255n, (v >> 8n) & 255n, v & 255n].join(".");
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
  return words.reduce((a, w) => (a << 16n) | BigInt(w), 0n);
}
function intToV6(v: bigint): string {
  const w: string[] = [];
  for (let i = 7; i >= 0; i--) w.push(((v >> BigInt(i * 16)) & 0xffffn).toString(16));
  return w.join(":");
}
interface Iv { lo: bigint; hi: bigint }
const toIv = (cidr: string, bits: bigint): Iv => {
  const [base, p] = cidr.split("/");
  const lo = bits === 128n ? v6ToInt(base!) : v4ToInt(base!);
  return { lo, hi: lo + (1n << (bits - BigInt(p!))) - 1n };
};
function normalize(ivs: Iv[]): Iv[] {
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
function subtract(a: Iv[], b: Iv[]): Iv[] {
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
const cidrsOf = (rows: ReadonlyArray<readonly [string, number]>): string[] =>
  rows.map(([n, p]) => `${n}/${p}`);

// --- 1. IPv4: THE EXHAUSTIVE SUPERSET PROOF ----------------------------------

describe("W13 OAuth deny table -- IPv4, swept exhaustively", () => {
  it("NOTHING moves denied -> allowed, and exactly ONE /24 moves allowed -> denied", () => {
    // Every rule on either table is stated at /24 granularity or coarser, so one
    // address per /24 block is exhaustive over the whole IPv4 space. (That the
    // verdict really is constant across the fourth octet is asserted independently
    // by w10c-internal-range-deny-set.test.ts.)
    const unblocked: string[] = [];
    const newlyBlocked = new Set<string>();
    const predicatePrivateTableAllows: string[] = [];
    const tableBlocksPredicateAllows: string[] = [];
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        for (let c = 0; c < 256; c++) {
          const ip = `${a}.${b}.${c}.7`;
          const before = blockedBefore(ip);
          const after = isBlockedOAuthAddress(ip);
          if (before && !after) unblocked.push(ip);
          if (!before && after) newlyBlocked.add(`${a}.${b}.${c}.0/24`);
          const priv = isPrivateIP(ip);
          if (priv && !after && predicatePrivateTableAllows.length < 8) {
            predicatePrivateTableAllows.push(ip);
          }
          if (!priv && after && tableBlocksPredicateAllows.length < 8) {
            tableBlocksPredicateAllows.push(ip);
          }
        }
      }
    }
    // (1) THE SAFETY ARGUMENT. If this is ever non-empty the change is a regression.
    expect(unblocked).toEqual([]);
    // (2) THE BLAST RADIUS, exactly. This is the anti-regression assertion: denying
    //     one extra /24 anywhere -- a public one included -- reds here, naming it.
    expect([...newlyBlocked].sort()).toEqual(["192.88.99.0/24"]);
    // (3) The table and the reference predicate now agree in BOTH directions.
    expect(predicatePrivateTableAllows).toEqual([]);
    expect(tableBlocksPredicateAllows).toEqual([]);
  }, 180_000);
});

// --- 2. IPv6: EXACT INTERVAL ARITHMETIC OVER THE WHOLE 2^128 SPACE -----------

describe("W13 OAuth deny table -- IPv6, exact over 2^128", () => {
  // The v6 space cannot be swept, but BOTH tables are CIDR LISTS, so their
  // difference is exactly computable. This is stronger than any sample: it sees
  // every one of the 2^128 addresses. What it CANNOT see is a mismatch between the
  // CIDR list and the BlockList actually loaded from it -- section 3 checks that.
  const before = normalize(cidrsOf(PRE_W13_V6).map((c) => toIv(c, 128n)));
  const after = normalize([...INTERNAL_RANGE_DENY_CIDRS_V6].map((c) => toIv(c, 128n)));

  it("NOTHING moves denied -> allowed anywhere in the IPv6 space", () => {
    expect(subtract(before, after)).toEqual([]);
  });

  it("the allowed -> denied blast radius is EXACTLY the enumerated classes", () => {
    const added = subtract(after, before);
    const total = added.reduce((acc, iv) => acc + (iv.hi - iv.lo + 1n), 0n);
    // ::/16 minus (::/128 + ::1/128 + ::ffff:0:0/96), plus 64:ff9b::/47,
    // 2001:2::/32, 2001:10::/28, 2001:20::/28, 2002::/16, 3ff0::/12, fec0::/10,
    // and — W17 — 100:0:0:1::/64 (the RFC9780 Dummy Prefix: the derived entry
    // widened from 100::/64 to 100::/63, and the PRE-W13 table carried the /64)
    // plus 5f00::/16 (SRv6 SIDs, RFC9602).
    const size = (p: bigint): bigint => 1n << (128n - p);
    const expected =
      size(16n) - 1n - 1n - size(96n) +
      size(47n) + size(32n) + size(28n) + size(28n) + size(16n) + size(12n) + size(10n) +
      size(64n) + size(16n);
    expect(total).toBe(expected);
    // and every named class must actually be inside the difference
    const covered = (ip: string): boolean => {
      const v = v6ToInt(ip);
      return added.some((iv) => v >= iv.lo && v <= iv.hi);
    };
    for (const ip of [
      "0:0:0:0:0:0:a9fe:a9fe", // ::a9fe:a9fe -- ::169.254.169.254
      "64:ff9b:0:0:0:0:a9fe:a9fe", // NAT64 carrying the IPv4 metadata address
      "64:ff9b:1:0:0:0:0:1",
      "2001:2:0:0:0:0:0:1",
      "2001:10:0:0:0:0:0:1",
      "2001:2f:0:0:0:0:0:1",
      "2002:a9fe:a9fe:0:0:0:0:1", // 6to4 carrying the IPv4 metadata address
      "3ff0:0:0:0:0:0:0:1",
      "3fff:0:0:0:0:0:0:1",
      "fec0:0:0:0:0:0:0:1",
      "100:0:0:1:0:0:0:1", // W17 -- RFC9780 Dummy Prefix
      "5f00:0:0:0:0:0:0:1", // W17 -- RFC9602 SRv6 SIDs
    ]) expect(covered(ip), ip).toBe(true);
  });
});

// --- 3. THE LIVE TABLE really is the derived list, and agrees with the predicate ---

describe("W13 OAuth deny table -- the LIVE BlockList is the derived set", () => {
  it("blocks both edges and the interior of every derived CIDR", () => {
    for (const cidr of INTERNAL_RANGE_DENY_CIDRS) {
      const v6 = cidr.includes(":");
      const { lo, hi } = toIv(cidr, v6 ? 128n : 32n);
      const render = (v: bigint): string => (v6 ? intToV6(v) : intToV4(v));
      for (const probe of [lo, hi, lo + 1n]) {
        expect(isBlockedOAuthAddress(render(probe)), `${cidr} ${render(probe)}`).toBe(true);
      }
    }
  });

  it("IPv6: agrees with isPrivateIP across all 65536 leading words, for words 4-7 = 0:0:0:1", () => {
    // isPrivateIP's IPv6 arm reads only the first four words and every arm keys off
    // the first, so sweeping all 2^16 leading words with suffixes that exercise the
    // deeper arms finds any disagreement at /16 granularity or coarser.
    // ★ METHOD LIMIT, STATED -- and THIS is the authoritative copy of it.
    // This sweep cannot see a divergence confined to a rule keyed on the FIFTH WORD
    // OR DEEPER (`words[4]`..`words[7]`): every probe below pins words 4-7 to `0:0:0:1`.
    //
    // ONE SUCH RULE EXISTS TODAY, so do not read this as "nothing reads that far".
    // `isPrivateIP`'s `mappedIpv4` (outbound-url-guard.ts) keys on `words[4]`..`words[7]`
    // to unwrap `::ffff:a.b.c.d`, and its `^::ffff:<dotted quad>$` fast path does the same,
    // so `isPrivateIP('::ffff:8.8.8.8')` is FALSE while the table denies that address.
    //
    // ★★★ DESCRIBING THAT LIMIT DOES NOT MAKE THIS TEST'S CLAIM TRUE, SO THE LIMIT IS
    // NOT LEFT AS PROSE. `expect(disagreements).toEqual([])` below is scoped, by
    // construction, to `words[4..7] === 0:0:0:1` -- and the assertion's NAME now says so.
    // The falsifying class is generated and asserted in the NEXT TWO TESTS instead, which
    // is the only thing that turns a stated limit into evidence.
    //
    // The exception is HARMLESS, for a reason CHECKED rather than assumed and pinned in
    // those tests: the rule's ENTIRE domain, `::ffff:0:0/96`, sits inside a coarser entry
    // that BOTH tables deny outright -- `::/16` after W13, an explicit `::ffff:0:0/96`
    // before it. The deeper words therefore cannot change either table's verdict there, so
    // it is a PRE-EXISTING DENY-MORE divergence, identical before and after W13, and
    // nothing moved denied -> allowed. A future deeper rule NOT subsumed by a coarser entry
    // would be a real blind spot; section 2's exact interval arithmetic is the backstop.
    const suffixes: Array<[number, number, number]> = [
      [0, 0, 0], [0, 0, 1], [0xff9b, 0, 0], [0xff9b, 1, 0], [0, 0, 0xffff],
      [0x0db8, 0, 1], [0x0002, 0, 0], [0x0010, 0, 0], [0x0020, 0, 0],
      [0xffff, 0xffff, 0xffff],
    ];
    const disagreements: string[] = [];
    for (let w0 = 0; w0 < 65536; w0++) {
      for (const [w1, w2, w3] of suffixes) {
        const ip = `${w0.toString(16)}:${w1.toString(16)}:${w2.toString(16)}:${w3.toString(16)}:0:0:0:1`;
        if (isPrivateIP(ip) !== isBlockedOAuthAddress(ip) && disagreements.length < 10) {
          disagreements.push(ip);
        }
      }
    }
    expect(disagreements).toEqual([]);
  }, 120_000);

  // --- THE FIFTH-WORD RULE, EXERCISED -------------------------------------------
  // Codex review of 86f2a8644: "the claimed bidirectional agreement is not actually
  // tested for IPv4-mapped IPv6 addresses ... every generated probe fixes those later
  // words to 0:0:0:1, so the suite passes despite this existing divergence". TRUE, and it
  // is this programme's signature defect -- a VACUOUS ASSERTION -- shipped inside the very
  // file whose job is to prove agreement. These two tests generate the falsifying case,
  // characterise the exception EXACTLY, and pin it as pre-existing.
  //
  // ★ THE DISPOSITION, DECIDED RATHER THAN INHERITED: this is an INTENTIONAL SUPERSET
  // EXCEPTION, not a bug to be fixed in the table. Every address spellable as
  // `::ffff:a.b.c.d` is equally spellable as `a.b.c.d`, which the table judges on its true
  // merits -- so an attacker gains no reachability from the mapped spelling, and a
  // legitimate caller loses none they cannot recover by using the v4 spelling. Narrowing
  // the table to match `isPrivateIP` here would move `::ffff:<public v4>` from denied to
  // ALLOWED on BOTH the pre-W13 and the post-W13 table -- the one direction this change
  // promised never to move, on a shipped SSRF filter, for zero security gain.
  // `::ffff:0:0/96` in an SSRF deny list is the standard posture precisely so a mapped
  // literal cannot smuggle a v4 target past a v6 rule set. It is PINNED here, not repaired.

  it("IPv4-MAPPED: the table denies the WHOLE ::ffff:0:0/96, and its ONLY divergence from isPrivateIP is the mapped-PUBLIC half", () => {
    // Sweeps all 65536 (a,b) pairs of `::ffff:a.b.0.7` -- every /16 of the embedded IPv4
    // space. `isPrivateIP`'s finer (/24) v4 rules are swept exhaustively in section 1; what
    // is being characterised here is the MAPPING, not the v4 ranges.
    const tableAllowedSomeMapped: string[] = [];
    const unwrapMismatch: string[] = [];
    let divergent = 0; // table denies, isPrivateIP allows -- the exception class
    let agreeing = 0; // both deny -- mapped-PRIVATE
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        const v4 = `${a}.${b}.0.7`;
        const ip = `::ffff:${v4}`;
        if (!isBlockedOAuthAddress(ip) && tableAllowedSomeMapped.length < 8) {
          tableAllowedSomeMapped.push(ip);
        }
        // The unwrap must be FAITHFUL: the mapped form and the bare form must get the same
        // verdict from the predicate. If this ever reds, the exception is no longer
        // characterised by "the embedded v4 is public" and has to be re-derived.
        if (isPrivateIP(ip) !== isPrivateIP(v4) && unwrapMismatch.length < 8) {
          unwrapMismatch.push(ip);
        }
        if (isPrivateIP(ip)) agreeing++;
        else divergent++;
      }
    }
    // (1) The table denies EVERY mapped address. No hole, public or private.
    expect(tableAllowedSomeMapped).toEqual([]);
    // (2) `isPrivateIP` unwraps faithfully, so the divergence class is exactly "the
    //     embedded IPv4 is public" -- nothing else lurks in the /96.
    expect(unwrapMismatch).toEqual([]);
    // (3) BOTH halves are non-empty -- THE ANTI-VACUITY GUARD, which is the whole point of
    //     this test. Without it a future edit that stopped generating either half would
    //     leave (1) and (2) passing while proving nothing, which is the exact failure this
    //     test was added to remove.
    expect(divergent, "mapped-PUBLIC probes generated").toBeGreaterThan(0);
    expect(agreeing, "mapped-PRIVATE probes generated").toBeGreaterThan(0);
  });

  it("IPv4-MAPPED: the exception is PRE-EXISTING -- denied before AND after -- and its domain is subsumed by a coarser entry in BOTH tables", () => {
    // The whole weight of "pre-existing" rests here: W13 must not be what introduced it.
    for (const [ip, v4] of [
      ["::ffff:8.8.8.8", "8.8.8.8"],
      ["::ffff:1.1.1.1", "1.1.1.1"],
      ["::ffff:104.18.0.1", "104.18.0.1"],
      ["::ffff:140.82.121.4", "140.82.121.4"],
      ["::ffff:808:808", "8.8.8.8"], // the hextet spelling of the same address
    ] as const) {
      expect(isPrivateIP(ip), `isPrivateIP ${ip}`).toBe(false);
      expect(isPrivateIP(v4), `isPrivateIP ${v4}`).toBe(false);
      expect(blockedBefore(ip), `PRE-W13 table ${ip}`).toBe(true);
      expect(isBlockedOAuthAddress(ip), `post-W13 table ${ip}`).toBe(true);
    }
    // The mapped-PRIVATE control: here table and predicate AGREE, which is what makes the
    // exception specific to the public half rather than to the mapped form as such.
    for (const ip of ["::ffff:169.254.169.254", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isPrivateIP(ip), `isPrivateIP ${ip}`).toBe(true);
      expect(blockedBefore(ip), `PRE-W13 table ${ip}`).toBe(true);
      expect(isBlockedOAuthAddress(ip), `post-W13 table ${ip}`).toBe(true);
    }
    // ★ THE LOAD-BEARING STRUCTURAL CLAIM, checked rather than asserted in prose: the
    // rule's entire domain sits inside a CIDR that BOTH lists carry, which is why the
    // deeper words cannot change either verdict and why nothing moved denied -> allowed.
    const mappedDomain = toIv("::ffff:0:0/96", 128n);
    const inside = (cidrs: string[]): boolean =>
      normalize(cidrs.map((c) => toIv(c, 128n))).some(
        (iv) => iv.lo <= mappedDomain.lo && iv.hi >= mappedDomain.hi,
      );
    expect(inside(cidrsOf(PRE_W13_V6)), "::ffff:0:0/96 inside the PRE-W13 list").toBe(true);
    expect(
      inside([...INTERNAL_RANGE_DENY_CIDRS_V6]),
      "::ffff:0:0/96 inside the derived list",
    ).toBe(true);
  });

  it("catches the metadata address in EVERY spelling that reaches this filter", () => {
    for (const ip of [
      "169.254.169.254",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "::169.254.169.254", // the E8-F009 section 4 spelling -- BOTH layers used to miss it
      "64:ff9b::169.254.169.254", // via NAT64
      "64:ff9b::a9fe:a9fe",
      "2002:a9fe:a9fe::1", // via 6to4
      "169.254.170.2",
      "fd00:ec2::254",
    ]) expect(isBlockedOAuthAddress(ip), ip).toBe(true);
  });

  it("pins that the derived set is what the table loads", () => {
    // Cheap structural pin so a mutation of the derived list is attributable here as
    // well as in the sweeps above.
    expect(INTERNAL_RANGE_DENY_CIDRS_V4).toContain("192.88.99.0/24");
    expect(INTERNAL_RANGE_DENY_CIDRS_V6).toContain("2002::/16");
    expect(INTERNAL_RANGE_DENY_CIDRS_V6).toContain("64:ff9b::/47");
  });
});

// --- 4. POSITIVE CONTROL -----------------------------------------------------

describe("W13 OAuth deny table -- real destinations stay reachable", () => {
  // THE CONTROL THAT MATTERS. A filter that denies everything passes every test
  // above. These are addresses in the ranges AoA's real destinations live in --
  // model provider APIs, package registries, OAuth issuers, git hosts, the
  // marketplace CDN -- and they must be allowed BEFORE and AFTER.
  it.each([
    ["8.8.8.8", "Google public DNS"],
    ["1.1.1.1", "Cloudflare public DNS"],
    ["104.18.0.1", "Cloudflare edge (api.anthropic.com and many SaaS OAuth issuers)"],
    ["140.82.121.4", "GitHub (git host + OAuth issuer)"],
    ["185.199.108.153", "GitHub Pages (the marketplace CDN's origin family)"],
    ["104.16.0.1", "Cloudflare edge (registry.npmjs.org)"],
    ["52.94.236.248", "AWS public range"],
    ["20.1.1.1", "Azure public range"],
    ["34.117.0.1", "Google Cloud public range"],
    ["172.32.0.1", "just outside RFC1918 172.16/12"],
    ["100.128.0.1", "just outside CGNAT 100.64/10"],
    ["192.88.100.1", "just outside the 6to4 relay /24"],
    ["2606:4700:4700::1111", "Cloudflare DNS IPv6"],
    ["2001:4860:4860::8888", "Google DNS IPv6"],
    ["2600:1f18::1", "AWS IPv6"],
    ["2a00:1450:4001::1", "Google IPv6"],
  ])("allows %s (%s), before and after", (ip) => {
    expect(isBlockedOAuthAddress(ip), `after: ${ip}`).toBe(false);
    expect(blockedBefore(ip), `before: ${ip}`).toBe(false);
    expect(isPrivateIP(ip), `isPrivateIP: ${ip}`).toBe(false);
  });

  it("a non-IP hostname is not treated as a blocked address by the table itself", () => {
    // `assertSafeOAuthUrl` passes hostnames through; the DNS result is what gets
    // checked. This pins that the shared helper does not accidentally fail-closed on
    // every domain name, which would break every connector.
    for (const host of ["api.anthropic.com", "github.com", "example.org"]) {
      expect(isBlockedOAuthAddress(host), host).toBe(false);
    }
  });
});
