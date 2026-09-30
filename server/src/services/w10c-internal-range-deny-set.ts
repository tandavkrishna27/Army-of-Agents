// server/src/services/w10c-internal-range-deny-set.ts
//
// W10C — THE PINNED INTERNAL-RANGE DENY SET, AS A PURE MODULE.
//
// This module is DATA + PURE FUNCTIONS. It enforces nothing itself.
//
// ★ W13 UPDATE (2026-09-07): IT NOW HAS ONE PRODUCTION CONSUMER.
// `mcp-connector-oauth.ts` builds its two `node:net` BlockList SSRF tables from
// `INTERNAL_RANGE_DENY_CIDRS` instead of the hand-typed range lists it carried
// before, closing the divergence E8-F009 measured (one IPv4 /24 and eight IPv6
// classes). That is exactly the fourth promotion condition named below --
// "fixing the measured mcp-connector-oauth.ts divergence against a derived source
// of truth" -- so `scripts/gate-clause-wiring.json` moves this clause from
// `unwired` to `wired`. Everything the header says about the module's ORIGINAL
// consumer is still true and is kept below, unedited, because it is a measurement.
//
// ★★★ ITS ORIGINAL INTENDED CONSUMER IS DEAD, AND WAS THE REASON THIS WAS ORPHANED.
//
// This set was built for one consumer: applying it to the E2B provider-layer
// `network.denyOut` body. On 2026-09-07 that consumer was measured out of
// existence -- workflow run 34085130892 (E8-F008): the tier ACCEPTS a deny set,
// VALIDATES it server-side, STORES it, returns it VERBATIM from getInfo(), and
// routes the denied traffic anyway. Both `Sandbox.create` and `updateNetwork`
// behave that way. So there is no unit coming to apply this, and the sentence
// that used to stand here -- 'a later unit applies it' -- was withdrawn rather
// than left to read as a plan.
//
// ★ DO NOT READ THIS FILE AS A LIVE CONTROL, A PLANNED ONE, OR EVIDENCE THAT
// EGRESS IS FILTERED ANYWHERE. Nothing in this tree filters sandbox egress at
// any layer: E8-F003 §8 carries the census, and every candidate in it is
// refuted. DE-08 (severity Critical) reads `not-delivered`.
//
// -- WHY IT IS KEPT RATHER THAN REVERTED, AND WHAT WOULD REVIVE IT ------------
// Kept because the DERIVATION, not the array, is the asset, and the derivation
// is checked against LIVE code on every CI run: `w10c-internal-range-deny-set.test.ts`
// re-derives the IPv4 cover from `isPrivateIP` (server/src/services/outbound-url-guard.ts)
// by a full 2^24 sweep and asserts equality, so a change to that live predicate
// reds this module. The header below USED TO record two MEASURED facts about
// shipped code -- the `mcp-connector-oauth.ts` BlockList's missing 192.88.99.0/24,
// and `isPrivateIP('::169.254.169.254') === false`. BOTH ARE CLOSED AS OF W13: the
// OAuth BlockList now DERIVES from this list rather than being transcribed beside
// it, and the parser defect behind the second is fixed. They are kept below as a
// record of what the divergence WAS, not as live gaps in shipped code.
//
// WHAT WOULD REVIVE IT, named so this is a real disposition and not 'it might be
// handy'. Any enforcement point that consumes a CIDR LIST rather than a boolean
// predicate:
//   * an in-guest packet filter (E8-F003 §3 point 2 / BRW-004 D3 option (c));
//   * a container/networked-lane egress policy (docker network, nftables);
//   * a provider tier MEASURED to honour a deny set -- `resolveE2bDomain` is
//     per-company configurable (sandbox-provider-runtime.ts:577-578, self-hosted
//     branch :545) and only one tier has ever been measured;
//   * fixing the measured `mcp-connector-oauth.ts` divergence against a derived
//     source of truth rather than by hand.
// WHAT IS DEAD, explicitly: adopting this into the managed-E2B `network` body at
// the measured tier. That is refuted, not pending.
//
// THAT DELETION QUESTION IS NOW ANSWERED: the fourth condition was taken in W13, so
// this module is live and deleting it would delete a shipped SSRF table's data source.
// `scripts/gate-clause-wiring.json` carries `E8-w10c-internal-range-deny-set` as
// `wired`, naming `mcp-connector-oauth.ts` as what consumes it.
//
// ★ WHAT THAT GUARD ACTUALLY DOES -- stated exactly, because an overstated guard
// claim is the same defect one level up from the one this module exists to stop.
// `check-gate-clause-wiring.mjs` reds a `wired` clause ONLY when its symbol's
// production reference count reaches ZERO. `INTERNAL_RANGE_DENY_CIDRS` measures 2
// (`node scripts/check-gate-clause-wiring.mjs --counts`): the module-scope loop in
// `mcp-connector-oauth.ts`, and the default parameter of `isCoveredByDenySet` below
// -- which is INTRA-MODULE and cannot disappear while this file exists. So deleting
// the OAuth consumer would take the count 2 -> 1 and the guard would STAY GREEN.
// It catches deleting the whole thing. It does NOT catch orphaning this module
// again, and it must not be cited as if it did.
//
// -- WHY THIS SET EXISTS AT ALL -----------------------------------------------
// The repo's authority on "is this address internal" is `isPrivateIP`
// (./outbound-url-guard.ts). It is a boolean PREDICATE over an IP string, not a
// CIDR list. Anything applied OUTSIDE our process -- a provider network body, a
// firewall rule -- needs a CIDR list. Transcribing a predicate into a list by hand
// is how divergent private-range tables get born; this tree already has three
// (see the DIVERGENCE LEDGER below).
//
// So this array is NOT hand-copied. It is MECHANICALLY DERIVED from `isPrivateIP`:
// on IPv4, the exact minimal CIDR cover of the predicate's rejection set (a full
// 2^24 sweep of the /24 space); on IPv6, the exact minimal cover of the predicate's
// LEADING-WORD rules (a recursive uniformity descent over the leading words), which
// is a STRICT SUPERSET of the predicate's actual IPv6 rejection set -- see the
// superset section below for the measured witness and why it is kept that way.
// `w10c-internal-range-deny-set.test.ts` RE-DERIVES the IPv4 cover from `isPrivateIP`
// on every CI run and asserts equality, and sweeps all 65536 leading words on the
// IPv6 side asserting that nothing the predicate rejects is MISSING here -- superset,
// not equality. So the two cannot drift apart silently: editing `isPrivateIP` reds
// this module's test.
// ★ W17: the IPv6 half is now RE-DERIVED too, not only swept. `w17-ipv6-range-closeout.test.ts`
// recomputes the exact minimal prefix cover of `isPrivateIP`'s IPv6 arm by a recursive
// uniformity descent over the leading four words and asserts it EQUALS
// `INTERNAL_RANGE_DENY_CIDRS_V6`. That is what produced `100::/63` here rather than the
// two /64s a hand edit would have written.
//
// -- DIVERGENCE LEDGER (measured 2026-09-07, not assumed) ---------------------
// Four representations of "internal range" already exist in the tree:
//
//   1. `isPrivateIP` (server/src/services/outbound-url-guard.ts) -- THE
//      reference predicate. Prefix-string + IPv6 word-mask checks.
//   2. `isPrivateIp` (scripts/check-egress-policy-vectors.mjs) -- a deliberately
//      INDEPENDENT CIDR reimplementation used as the differential oracle for the
//      egress-policy vectors gate. MEASURED: its IPv4 half agrees with `isPrivateIP`
//      on all 2^24 /24 blocks -- zero divergence. It is NOT reused here on purpose:
//      importing the oracle into the code it checks would destroy its independence.
//      ★ W17 UPDATE: its IPv6 half USED TO be a strict SUBSET of (1) -- it denied
//      only ::/16, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 2001:db8::/32 and
//      2002::/16, so it silently allowed every range in (1) below. The fixture's
//      IPv6 vectors exercised no divergent range, so the lane passed regardless.
//      W17 widened the oracle FROM THE IANA REGISTRY (not by importing (1)) and
//      added `w17-ipv6-range-closeout.test.ts`, which computes the EXACT symmetric
//      difference between the two by interval arithmetic over the whole 2^128 space
//      and pins it. NARROWING (1) now reds that test, naming the range.
//   3. `blockedIpv4`/`blockedIpv6` (server/src/services/mcp-connector-oauth.ts)
//      -- node `BlockList` tables for OAuth-metadata SSRF. NO LONGER A SEPARATE
//      REPRESENTATION: W13 rebuilt them FROM `INTERNAL_RANGE_DENY_CIDRS`, so they
//      are a rendering of (1) rather than a hand transcription of it. What they
//      used to diverge by, kept on the record: `192.88.99.0/24` on the IPv4 side
//      (deprecated 6to4 relay anycast) and eight IPv6 classes -- including
//      `2002::/16`, the ADDRESS end of the same 6to4 tunnel, and `64:ff9b::/96`,
//      the NAT64 well-known prefix (E8-F009 §3).
//   4. `METADATA_DENY_CIDRS` (server/src/services/egress-policy.ts:60) -- NOT a
//      private-range table. Three cloud-metadata host routes whose only job is to
//      make the REPORTED denial class more specific. Not a peer of this set.
//
// This module is therefore a fifth FILE but not a fifth POLICY: it is a derived
// rendering of representation (1), regenerated and pinned in CI.
//
// -- THIS SET IS A STRICT SUPERSET OF `isPrivateIP`, DELIBERATELY --------------
// It always has been, it still is, and it MUST STAY THAT WAY: a deny set that is
// WIDER than the predicate it renders fails CLOSED. W13 made the superset
// NARROWER by closing one of its two causes. It did NOT make it exact, and it was
// never exact. (An earlier revision of this header claimed W13 made this "an EXACT
// cover again". That was false twice over -- wrong about now, and wrong about
// "again" -- and it is corrected here rather than quietly dropped, because this
// array is what the live OAuth SSRF BlockList is built from, and a reader who
// believes it is exact will one day "fix" the superset. That moves addresses
// denied -> allowed, which is the one direction W13 promised never to move.)
//
// CAUSE (1), CLOSED IN W13 -- the parser defect. This USED TO READ:
// `isPrivateIP('::169.254.169.254') === false`, a PARSER defect rather than a
// range gap -- `isPrivateIP`'s local `parseIpv6Words` rejected the IPv4-compatible
// spelling `::a.b.c.d` (its per-token regex forbade dots), so the address never
// reached the range checks at all. This set covered it anyway via `::/16`. W13
// FIXED THE PARSER: both modules now share one grammar (`./ip-literal.ts`),
// lifted from `egress-policy.ts`'s `parseIp`, which already accepted an embedded
// dotted quad. `isPrivateIP('::169.254.169.254')` is now TRUE. No range in this
// set changed -- `::/16` had always covered that address; what changed is that the
// predicate agrees ON THAT ADDRESS.
//
// CAUSE (2), STILL OPEN, PRE-EXISTING, AND NOT W13's TO CLOSE -- IPv4-MAPPED
// PUBLIC ADDRESSES. `::/16` numerically contains every `::ffff:a.b.c.d`, so a
// consumer that matches these CIDRs as NUMBERS -- which is what a CIDR list is
// FOR: a `node:net` BlockList, a firewall rule, a provider network body -- denies
// mapped PUBLIC addresses that `isPrivateIP` allows (the predicate unwraps
// `::ffff:` and judges the embedded IPv4 on its merits). MEASURED at the live
// consumer, on this tip:
//     isPrivateIP('::ffff:8.8.8.8')            === false
//     isBlockedOAuthAddress('::ffff:8.8.8.8')  === true
// -- a witness, so "strict" is checked rather than asserted. The pre-W13 hand-typed
// OAuth table denied the same `/96` explicitly, so this predates W13, and narrowing
// it would move addresses denied -> allowed on a live SSRF filter for zero security
// gain (every address spellable `::ffff:a.b.c.d` is equally spellable `a.b.c.d`,
// which the table judges on its true merits). It is PINNED as an intentional
// exception by the two `IPv4-MAPPED:` tests in
// `w13-oauth-deny-table-divergence.test.ts`.
//
// ★ WHY THAT WITNESS DOES NOT REPRODUCE THROUGH `isCoveredByDenySet` BELOW -- said
// here so the next reader who checks does not conclude the superset claim is bogus.
// That helper resolves membership via `egress-policy.ipInCidr` -> `ip-literal.parseIp`,
// which unwraps `::ffff:` to IPv4 exactly as `isPrivateIP` does, so through THAT
// helper the two agree and `isCoveredByDenySet('::ffff:8.8.8.8')` is `false`. The
// strictness is a property of the CIDR LIST as handed to an outside matcher -- the
// only form in which this module's data is ever consumed. Both statements are true;
// do not use the second to refute the first.

import { ipInCidr } from "./egress-policy.js";
import { isPrivateIP } from "./outbound-url-guard.js";

/**
 * The exact minimal CIDR cover of `isPrivateIP`'s IPv4 rejection set.
 * Derived by sweeping all 2^24 /24 blocks; re-derived and pinned in CI.
 */
export const INTERNAL_RANGE_DENY_CIDRS_V4: readonly string[] = Object.freeze([
  // "This network" / unspecified. Denying this WOULD block `0.0.0.0` and `0.x.y.z`,
  // which some stacks route to the local host -- a loopback reach in disguise.
  "0.0.0.0/8",
  // RFC1918 private-use. Covers the operator's own VPC/LAN: databases, control
  // plane, other tenants' workers. Denying it WOULD put those out of reach of a
  // sandbox; nothing in this unit denies anything.
  "10.0.0.0/8",
  // RFC6598 carrier-grade NAT. Covers provider-internal fabric: managed runtimes
  // commonly address host services and sibling sandboxes out of 100.64/10, so a
  // future enforcer that OMITTED it would leave a lateral path that looks "public"
  // to a naive filter.
  "100.64.0.0/10",
  // Loopback. Covers services bound to 127.0.0.1 inside a sandbox -- the agent
  // CLI's own auth broker, any debug port, any sidecar assumed unreachable.
  // Denying it WOULD make those unreachable from sandbox-originated traffic.
  "127.0.0.0/8",
  // RFC3927 link-local. THE range that carries cloud instance metadata
  // (169.254.169.254 IMDS, 169.254.170.2 ECS task metadata). Credential-theft
  // range; the single most important entry in this table.
  "169.254.0.0/16",
  // RFC1918 private-use (172.16-172.31). Same rationale as 10/8; the /12 boundary
  // is the classic off-by-one (172.32.x is PUBLIC and would have to stay allowed).
  "172.16.0.0/12",
  // RFC6890 IETF protocol assignments. Contains 192.0.0.170/171 (NAT64 discovery)
  // and other host-local protocol addresses; not globally routable, so denying
  // WOULD cost nothing and WOULD close a special-use surface.
  "192.0.0.0/24",
  // TEST-NET-1 (RFC5737). Documentation-only; a real connection attempt here is a
  // misconfiguration or a probe, never legitimate agent traffic.
  "192.0.2.0/24",
  // Deprecated 6to4 relay anycast (RFC7526). Denying this WOULD block a v6-over-v4
  // tunnel that would otherwise carry traffic past a v4-only egress filter.
  // NOTE: this USED TO be the one range `mcp-connector-oauth.ts`'s hand-typed table
  // was missing (E8-F009). W13 closed that -- the OAuth table DERIVES from this list,
  // so it carries this range precisely because this line is here.
  "192.88.99.0/24",
  // RFC1918 private-use. Home/office LAN range -- relevant for self-hosted and
  // desktop deployments where the sandbox host sits on a real LAN.
  "192.168.0.0/16",
  // RFC2544 benchmarking. Reserved for device testing; used by some appliances as
  // an internal transit range.
  "198.18.0.0/15",
  // TEST-NET-2 (RFC5737). Documentation-only, same rationale as TEST-NET-1.
  "198.51.100.0/24",
  // TEST-NET-3 (RFC5737). Documentation-only, same rationale as TEST-NET-1.
  "203.0.113.0/24",
  // Multicast (224/4) + reserved-for-future-use (240/4), aggregated. Covers
  // local-network multicast discovery (mDNS 224.0.0.251, SSDP 239.255.255.250);
  // denying it WOULD stop that being used to enumerate the host's neighbours.
  "224.0.0.0/3",
]);

/**
 * A deliberate STRICT SUPERSET of `isPrivateIP`'s IPv6 rejection set: the exact
 * minimal cover of the predicate's LEADING-WORD rules, derived by a recursive
 * uniformity descent over the leading 16-bit words.
 *
 * It is NOT an exact cover, and never was. `::/16` numerically contains every
 * IPv4-mapped address `::ffff:a.b.c.d`, including the mapped PUBLIC ones that
 * `isPrivateIP` allows -- measured, `isPrivateIP('::ffff:8.8.8.8')` is `false` while
 * the `BlockList` built from this list denies that address. Wider than the predicate
 * is the safe direction: it fails CLOSED. See the module header for why it stays.
 */
export const INTERNAL_RANGE_DENY_CIDRS_V6: readonly string[] = Object.freeze([
  // Everything with a zero leading word: `::` unspecified, `::1` loopback, and the
  // IPv4-compatible form `::a.b.c.d`. THIS is the entry that covers
  // `::169.254.169.254` -- the address `isPrivateIP` failed to parse until W13 fixed
  // the shared parser. The predicate now agrees with this entry ON THAT ADDRESS --
  // but NOT everywhere: this entry also contains every IPv4-MAPPED address
  // `::ffff:a.b.c.d`, and `isPrivateIP` ALLOWS the mapped-public ones. That is the
  // deliberate strict-superset exception described in the module header. It is
  // pre-existing, it fails closed, and it is pinned by test rather than by prose.
  "::/16",
  // RFC6052 NAT64 well-known prefixes (64:ff9b::/96 and 64:ff9b:1::/48,
  // aggregated). A NAT64 translator turns these into arbitrary IPv4 destinations,
  // so an enforcer that left them open WOULD re-open every IPv4 range listed above.
  "64:ff9b::/47",
  // RFC6666 discard-only prefix (100::/64) PLUS the RFC9780 Dummy IPv6 Prefix
  // (100:0:0:1::/64, allocated 2025-04, registry Globally Reachable = FALSE),
  // which W17 added to `isPrivateIP`. They are ADJACENT and aligned, so the exact
  // minimal cover of the two is ONE /63 -- this entry was "100::/64" before W17
  // and the re-derivation in `w17-ipv6-range-closeout.test.ts` produced the /63.
  // Do not "restore" the /64 and add a second entry: that is a different -- still
  // set-equal and still correct, but NON-MINIMAL -- list.
  // ★ WHICH CHECK CATCHES THAT, measured by writing exactly that spelling and
  // running the suite rather than by assuming. What REDS is the EXACT-SET PIN in
  // `w10c-internal-range-deny-set.test.ts`: "IPv6 half is EXACTLY this list"
  // (15 entries against the pinned 14) and, beside it, "the combined set is exactly
  // v4 ++ v6" on `toHaveLength(28)` (29 against 28). The DERIVATION test in
  // `w17-ipv6-range-closeout.test.ts` PASSES on that spelling and structurally
  // cannot catch it: its exact-array assertion is on the cover RECOMPUTED from
  // `isPrivateIP`, which no edit to THIS array can move, and its shipped-vs-derived
  // comparison is INTERVAL SUBTRACTION in both directions -- set equality over
  // addresses, blind to how the same addresses are spelled. So the two checks are
  // not redundant: the derivation test says the ADDRESSES are right, the exact-set
  // pin says the SPELLING is the minimal cover. Naming the wrong one here would
  // send a future reader to a test that would have shrugged.
  "100::/63",
  // 2001::/32 Teredo. IPv6-over-UDP tunnelling -- another v4 tunnel bypass.
  "2001::/32",
  // 2001:2::/32 BMWG benchmarking.
  "2001:2::/32",
  // 2001:10::/28 ORCHID (deprecated) -- non-routable identifier space.
  "2001:10::/28",
  // 2001:20::/28 ORCHIDv2 -- non-routable identifier space.
  "2001:20::/28",
  // 2001:db8::/32 documentation. Documentation-only, same rationale as TEST-NET.
  "2001:db8::/32",
  // 2002::/16 6to4. The v6 side of the 192.88.99.0/24 tunnel; denying only one end
  // of a tunnel WOULD be denying neither.
  "2002::/16",
  // 3fff::/20 additional documentation space (RFC9637); `isPrivateIP` rejects the
  // wider 3ff0-3fff span, so the exact cover of the predicate is /12.
  "3ff0::/12",
  // 5f00::/16 Segment Routing (SRv6) SIDs (RFC9602, allocated 2024-04, registry
  // Globally Reachable = FALSE). Added by W17: an SRv6 SID is a router-internal
  // forwarding label inside the operator's own SR domain, so nothing AoA talks to
  // can live here, and a filter that left it open would leave a reserved,
  // non-globally-reachable band addressable from a sandbox.
  "5f00::/16",
  // fc00::/7 unique local addresses. The IPv6 equivalent of RFC1918 -- covers the
  // operator's own fabric.
  "fc00::/7",
  // fe80::/10 link-local + fec0::/10 deprecated site-local, aggregated. Link-local
  // is the v6 on-link neighbour range; site-local is the deprecated internal range.
  "fe80::/9",
  // ff00::/8 multicast. Same neighbour-enumeration rationale as 224/4.
  "ff00::/8",
]);

/** Both families, in a single frozen list. */
export const INTERNAL_RANGE_DENY_CIDRS: readonly string[] = Object.freeze([
  ...INTERNAL_RANGE_DENY_CIDRS_V4,
  ...INTERNAL_RANGE_DENY_CIDRS_V6,
]);

/** True iff `ip` falls inside ANY of `cidrs`. Pure; family-aware via `ipInCidr`. */
export function isCoveredByDenySet(
  ip: string,
  cidrs: readonly string[] = INTERNAL_RANGE_DENY_CIDRS,
): boolean {
  for (const cidr of cidrs) {
    if (cidr && ipInCidr(ip, cidr)) return true;
  }
  return false;
}

/**
 * The addresses in `addresses` that `isPrivateIP` REJECTS but `cidrs` does NOT
 * cover -- i.e. the holes in `cidrs` relative to the reference predicate, over the
 * given corpus. Empty => `cidrs` is a superset of `isPrivateIP` on that corpus.
 *
 * WHAT THIS CAN AND CANNOT PROVE: agreement over a CORPUS is not a pin. A range
 * can be deleted from the deny set and this still returns empty, if the corpus
 * happens to contain no address in that range. That is precisely why the
 * exact-set assertion and the re-derivation sweep in the test file exist, and why
 * neither is replaceable by this function.
 */
export function findPrivateRangeGaps(
  cidrs: readonly string[],
  addresses: readonly string[],
): readonly string[] {
  return addresses.filter((ip) => isPrivateIP(ip) && !isCoveredByDenySet(ip, cidrs));
}

/** True iff `cidrs` covers every address in `addresses` that `isPrivateIP` rejects. */
export function isSupersetOfIsPrivateIp(
  cidrs: readonly string[],
  addresses: readonly string[],
): boolean {
  return findPrivateRangeGaps(cidrs, addresses).length === 0;
}

/**
 * The standing agreement corpus. Includes every address that has already bitten
 * this programme, in every spelling that reached a real call site.
 */
export const PRIVATE_RANGE_AGREEMENT_CORPUS: readonly string[] = Object.freeze([
  // -- the ones that have already bitten --
  "169.254.169.254", // AWS/GCP/Azure/OpenStack IMDS
  "::ffff:169.254.169.254", // v4-mapped dotted spelling
  "::ffff:a9fe:a9fe", // v4-mapped HEX spelling (URL parsers canonicalize to this)
  "::169.254.169.254", // v4-COMPATIBLE spelling -- isPrivateIP missed this until W13
  "169.254.170.2", // AWS ECS task metadata
  "fd00:ec2::254", // AWS IMDS over IPv6 (inside fc00::/7)
  // -- one interior address per IPv4 range --
  "0.0.0.1",
  "10.1.2.3",
  "100.64.0.1",
  "100.127.255.254",
  "127.0.0.1",
  "169.254.1.1",
  "172.16.0.1",
  "172.31.255.254",
  "192.0.0.170",
  "192.0.2.1",
  "192.88.99.1",
  "192.168.1.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.251", // mDNS
  "239.255.255.250", // SSDP
  "255.255.255.255",
  // -- one interior address per IPv6 range --
  "::",
  "::1",
  "64:ff9b::1.2.3.4",
  "64:ff9b:1::1",
  "100::1",
  "2001:0:1::1",
  "2001:2:0:1::1",
  "2001:10::1",
  "2001:20::1",
  "2001:db8::1",
  "2002::1",
  "3fff::1",
  "fc00::1",
  "fd12:3456::1",
  "fe80::1",
  "fec0::1",
  "ff02::1",
  // -- PUBLIC controls: must be rejected by NEITHER --
  "8.8.8.8",
  "1.1.1.1",
  "172.32.0.1", // just outside 172.16/12
  "100.128.0.1", // just outside 100.64/10
  "192.88.100.1", // just outside the 6to4 relay /24
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
]);
