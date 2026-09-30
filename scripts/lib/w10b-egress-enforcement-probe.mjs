// scripts/lib/w10b-egress-enforcement-probe.mjs
//
// W10B — THE PURE CORE OF THE DE-08 EGRESS-ENFORCEMENT PROBE PACK.
//
// The pack answers FIVE empirical questions with one keyed E2B run, so that a decision
// about DE-08 ("Sandbox <-> network egress", severity Critical, enforcement measured
// absent at every layer) can be taken from a measurement instead of from a premise.
//
//   (a) HONOURED?   Does the operator's E2B tier honour a `denyOut` policy declared at
//                   `Sandbox.create` — is a target inside the deny set actually
//                   unreachable from the guest?
//   (b) VERIFIABLE? Does `getInfo()` MATERIALIZE the network policy back, so a run can
//                   verify what was applied rather than assume it? Without this the whole
//                   approach is unshippable, however well (a) turns out.
//   (c) ABANDON?    Is the guest's DNS RESOLVER inside the deny set? If the resolver's
//                   address falls in a denied range, denying that range breaks all name
//                   resolution and there is NO REPAIR IN THIS API: `denyOut` has no
//                   exclude, and adding any `allowOut` entry flips the whole policy to
//                   default-deny. A `yes` here ABANDONS the provider-network option —
//                   and that is a complete, valuable result, not a failure.
//   (d) RE-ASSERT?  Does `updateNetwork` work on a WARM RESUME, so a reused sandbox
//                   (AoA's `reuseLease` path) can be re-policed rather than trusted?
//   (e) WHERE?      Does enforcement live in the PACKET PATH or in an L7 proxy? A raw TCP
//                   connect to an internal address on a NON-HTTP port, and hand-written
//                   HTTP request bytes over a raw socket, are both open to an L7-only
//                   filter and both closed by a packet filter.
//
// It BUILDS NO ENFORCEMENT. It applies no policy to any production code path. It creates
// short-TTL sandboxes, runs read-only reachability probes inside them, and tears them down.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE STALE PREMISE THIS UNIT EXISTS TO RETIRE — MEASURED, NOT ARGUED
// ─────────────────────────────────────────────────────────────────────────────
// Three records in this repository book the provider layer as unavailable on the strength
// of one sentence: "managed-E2B egress is not fully lockable" — REFUTED as a capability
// claim by finding E8-F007, which owns that premise.
//
//   * `server/src/services/sandbox-provider-runtime.ts` (the `acquireLease` metadata
//     comment), which is the line a future engineer actually reads;
//   * the 2026-08-05 cloud-execution-isolation spec, §12;
//   * finding E8-F003's own "option (b) is unavailable".
//
// AGAINST THE INSTALLED, LOCKFILE-PINNED SDK (`e2b@2.30.5`, `pnpm-lock.yaml`) THAT
// SENTENCE IS FALSE AS A STATEMENT ABOUT THE SEAM. The SDK exposes, and AoA has never
// called, a real network configuration:
//
//   * `SandboxOpts.network?: SandboxNetworkOpts` with `allowOut` / `denyOut`
//     (`dist/index.d.ts`, the `SandboxOpts` interface);
//   * `buildNetworkBody` → the `POST /sandboxes` request body (`dist/index.js`,
//     `createSandbox`), i.e. it reaches the wire;
//   * `Sandbox.updateNetwork` → `PUT /sandboxes/{sandboxID}/network`;
//   * `getInfo()` mapping the server's answer back to `SandboxInfo.network`.
//
// What was STILL UNMEASURED — and is exactly what this pack measures — is whether the
// OPERATOR'S TIER ENFORCES what the seam declares. The correction to the record is
// therefore "the seam exists and was never called", not "the boundary works". This file
// is written so that "it does not enforce" comes back as cleanly as "it does".
//
// ★★★ AND IT CAME BACK "IT DOES NOT ENFORCE" — FOR ONE SHAPE: run 34085130892, 2026-09-07,
// at ab23eabdc, template aoa-base — a=no b=yes c=no d=no e=no regression=no, DECISION abandon
// (denyout-is-inert-at-this-tier). The tier ACCEPTS the deny set, VALIDATES it server-side,
// STORES it and ECHOES it back verbatim, and routes the denied traffic anyway. Finding
// E8-F008. NOTE FOR ANYONE EDITING THE PARAGRAPH BELOW: (b) is real and it is NOT a
// safeguard — it passed on the unpoliced sandbox.
//
// ★★★ THE SCOPE OF THAT RESULT, STATED BECAUSE SEVERAL RECORDS OVERSTATED IT. What was
// measured is DENY-SPECIFIC: a `denyOut` list of CIDRs with NO `allowOut`. E2B documents a
// DIFFERENT construction as the fine-grained control — default-deny (`denyOut:
// ({allTraffic}) => [allTraffic]`) PLUS an `allowOut` allowlist — and that shape is
// UNMEASURED. Section 16 builds the arm for it. "Unmeasured" is not "probably works": DE-08
// stays not-delivered, no production path passes a `network` body, and nothing here proposes
// that one should.
//
// ★★★ THAT ARM WAS DISPATCHED TWICE ON 2026-09-09 AND THE SHAPE IS STILL UNMEASURED. Runs
// 34328502574 and 34328780645, three minutes apart, on replatform/w10b-allowlist-arm at
// 899aceeec, template aoa-base: BOTH returned `UNRUN — arm-was-never-created`, because
// `Sandbox.create` answered `500: Failed to place sandbox: sandbox creation failed on 3
// node(s), please retry; if the problem persists, contact us`. In the SAME runs, SECONDS
// apart, on the SAME template, the policy and anti-vacuity arms CREATED successfully
// (i531or2zgvmdlt18e2u2s / i13yih10trv4512eugjmz, then im9ge2ldwohsitqrtx5rc /
// i0xsmm4fzyhr3ep736ge9) — which is what makes this evidence rather than noise. STATE IT AT
// THIS STRENGTH AND NO HIGHER: the documented shape REPRODUCIBLY FAILS TO PLACE at this tier,
// cause unknown and E2B's to explain. It is NOT a refusal — a 500 with a please-retry hint is
// not a validation rejection, and the contrast is in the same run, where the IPv6 deny arm was
// refused `400: invalid denied CIDR ::ffff:0:0/96`. It is NOT transient — it reproduced, with
// successful siblings each time. Two attempts is the evidence; do not quote a rate.
// ★ AND UNRUN IS NOT INERT: the sandbox never existed, so nothing in this file may be read as
// the allowlist construction having been tested and found not to enforce. E8-F008 §8;
// W10B-egress-enforcement-result.md §14; runbook §13.7.
//
// ★★★ AND A READ-BACK IS MANDATORY, NOT HYGIENE. `buildNetworkEgress` is a pure
// passthrough — the SDK validates NOTHING client-side, and the only error path is the HTTP
// status. The API target is per-company configurable (`resolveE2bDomain` =
// `config.domain ?? env.E2B_DOMAIN`, with a self-hosted branch). A tolerant or self-hosted
// server that ignores an unknown field returns 200 and yields an UNPOLICED sandbox with
// identical code and identical logs. That is why (b) is a first-class question and not a
// footnote to (a).
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE STATES, ALWAYS — AND WHY "inconclusive" IS THE ONLY RED
// ─────────────────────────────────────────────────────────────────────────────
// A probe that can only pass is worthless, and a probe whose error is indistinguishable
// from a negative result is worse than worthless: it converts an apparatus failure into a
// finding. So every verdict is one of:
//
//   "yes"          — the thing happened, and the evidence names it
//   "no"           — the thing did NOT happen, and the run was sound enough to say so
//   "inconclusive" — the apparatus did not establish either; the reason is CARRIED
//
// `no` is a RESULT and the lane stays GREEN for it. So is a `yes` on (c) — the ABANDON
// answer — which is a decisive measurement that saves the programme a build.
// `inconclusive` is the only state that reds, because it is the only one that means
// "run me again".
//
// Zero imports on purpose: this module is loaded both by `node --test` (the required
// `policy` job) and by a vitest test inside `@armyofagents/sandbox-e2b-provider`, whose
// runtime-source import boundary allows exactly five packages. Nothing here reaches the
// network, the filesystem, or `process`.

/** The three states every probe and every verdict reports. */
export const PROBE_STATES = Object.freeze(["yes", "no", "inconclusive"]);

// ─────────────────────────────────────────────────────────────────────────────
// 0. WHICH IMAGE ANSWERED — the template is resolved EXPLICITLY, never by omission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The template this pack measures against.
 *
 * ★ CHOSEN FOR TWO REASONS, both measured. First, it is the image AoA production actually
 * runs (`e2b/README.md` threads it end to end as `E2B_TEMPLATE=aoa-base`), so a
 * reachability result about it is a result about the product. Second, this pack needs
 * `curl` AND a raw-socket tool for question (e), and `e2b/e2b.Dockerfile` builds this
 * alias `FROM node:22` with `curl` and `python3` explicitly installed. The bare `base`
 * template is recorded as "coreutils only" (`.github/keyed-e2b-trigger` entry #4), which
 * would make (e) inconclusive for want of a tool rather than for want of an answer.
 */
export const PROBE_TEMPLATE_ALIAS = "aoa-base";

/** The E2B default. Named here so it can be REFUSED on omission — see `resolveTemplate`. */
export const BARE_BASE_TEMPLATE_ALIAS = "base";

/**
 * Resolve the template the pack will actually run against.
 *
 * ★ AN OMITTED INPUT RESOLVES TO `aoa-base`, NOT TO BARE `base`. E7-F022 measured that
 * every keyed lane pipes `inputs.e2b_template` straight into `E2B_TEMPLATE`, so an omitted
 * input silently selects an image this pack cannot fully measure in. Requiring the input
 * was rejected for the same reason W7U1 rejected it: the documented bootstrap route is a
 * `push` to a trigger file, and a `push` event carries NO inputs at all, so a hard
 * requirement would make the only guaranteed route the only impossible one.
 *
 * An explicitly supplied alias is honoured VERBATIM, including `base`. Explicit is
 * explicit; only omission is corrected, and the correction is REPORTED.
 */
export function resolveTemplate(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length > 0) {
    return {
      templateId: trimmed,
      source: "explicit",
      note:
        trimmed === BARE_BASE_TEMPLATE_ALIAS
          ? `EXPLICITLY set to the bare "${BARE_BASE_TEMPLATE_ALIAS}" template. It is recorded as "coreutils only", so ` +
            "question (e) will likely report `no-raw-socket-tool` and the lane will red as inconclusive."
          : "explicitly supplied by the dispatch input",
    };
  }
  return {
    templateId: PROBE_TEMPLATE_ALIAS,
    source: "default-product-image",
    note:
      `no template was supplied, so the pack resolved to "${PROBE_TEMPLATE_ALIAS}" — the image AoA production runs, ` +
      `built FROM node:22 with curl and python3 installed. It does NOT fall back to "${BARE_BASE_TEMPLATE_ALIAS}": ` +
      "that image has no raw-socket tool, so question (e) would be inconclusive for want of a tool rather than an answer.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE DENY SET — what the policy arm declares, and what it deliberately does NOT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The SDK's only all-traffic sentinel, pinned here and asserted against the real export
 * in the keyed file's no-key block.
 *
 * ★★★ IT IS IPv4-ONLY, AND THAT IS A FINDING SHAPE, NOT A DETAIL. `ALL_TRAFFIC` is
 * `"0.0.0.0/0"`. There is no `::/0` sentinel and the SDK's own documentation for
 * `allowOut`/`denyOut` gives no IPv6 example. A deny set expressed only in IPv4 CIDRs may
 * therefore leave every IPv6 spelling of the same destination open — which is why the
 * question targets include `::ffff:` mapped forms and an IPv6 metadata address, and why
 * there is a separate arm whose deny set ALSO declares IPv6 ranges (the API may simply
 * reject them, which is itself an answer).
 */
export const ALL_TRAFFIC_SENTINEL = "0.0.0.0/0";

/**
 * The IPv4 ranges the POLICY arm denies.
 *
 * ★★ LOOPBACK AND CGNAT ARE DELIBERATELY ABSENT, and the omission is load-bearing rather
 * than an oversight. `127.0.0.0/8` carries the guest's own control channel on some
 * resolver configurations (a `systemd-resolved` stub listens on `127.0.0.53`), and
 * `100.64.0.0/10` is used by cloud fabrics for infrastructure the sandbox may need to keep
 * running. Denying either could brick the command channel and report the bricking as the
 * agent's answer — spending the operator's authorised run on an apparatus failure. The
 * deny set is therefore the ranges a real DE-08 control must cover, minus the two that
 * could take the apparatus down with them; that scoping is stated in the runbook and in
 * the durable record so no later reader mistakes it for the whole control.
 */
export const DENY_SET_V4 = Object.freeze([
  Object.freeze({
    cidr: "169.254.0.0/16",
    why: "link-local, including the cloud instance-metadata address 169.254.169.254 that E8-F003 measured answering HTTP 401 from inside a real guest",
  }),
  Object.freeze({ cidr: "10.0.0.0/8", why: "RFC 1918 private space — the control-plane range DE-08 names" }),
  Object.freeze({ cidr: "172.16.0.0/12", why: "RFC 1918 private space" }),
  Object.freeze({ cidr: "192.168.0.0/16", why: "RFC 1918 private space" }),
]);

/**
 * The IPv6 ranges the IPv6 arm ADDITIONALLY declares.
 *
 * ★ THIS ARM MAY FAIL TO CREATE AT ALL, and that is one of its two admissible answers.
 * `buildNetworkEgress` is a pure passthrough with no client-side validation, so an IPv6
 * CIDR reaches the server unexamined; a server that refuses the family answers with an
 * HTTP status and `Sandbox.create` throws. "The API refuses IPv6 deny entries" and "the
 * API accepts them and they work" are both results. Only "the arm never ran and we do not
 * know why" is not, which is why the arm is created inside its own guard.
 */
export const DENY_SET_V6 = Object.freeze([
  Object.freeze({ cidr: "fe80::/10", why: "IPv6 link-local" }),
  Object.freeze({ cidr: "fd00::/8", why: "IPv6 unique-local, including the fd00:ec2::254 metadata address" }),
  Object.freeze({ cidr: "::ffff:0:0/96", why: "IPv4-mapped IPv6 — the spelling that reaches an IPv4 destination over an IPv6 socket" }),
]);

/**
 * The ANTI-VACUITY arm's deny set.
 *
 * ★★★ WITHOUT THIS ARM A DENY RESULT IS UNATTRIBUTABLE. If the policy arm cannot reach
 * 169.254.169.254, that is only evidence of enforcement if a sandbox WITH A NETWORK CONFIG
 * THAT DOES NOT NAME IT still can. RFC 5737 reserves 198.51.100.0/24 (TEST-NET-2) for
 * documentation: nothing routes there, it contains none of this pack's targets, and it is
 * a syntactically valid CIDR the API cannot object to. So the arm differs from the policy
 * arm in exactly one thing — WHICH addresses are denied — and not in whether a network
 * config exists at all.
 */
export const NON_MATCHING_DENY_SET = Object.freeze([
  Object.freeze({ cidr: "198.51.100.0/24", why: "RFC 5737 TEST-NET-2. Routes nowhere and contains none of the targets." }),
]);

/** Just the CIDR strings, in declaration order — the shape `denyOut` takes. */
export function denyCidrs(entries) {
  return (entries ?? []).map((e) => e.cidr);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CIDR CONTAINMENT — the engine of the ABANDON question
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a dotted-quad IPv4 literal to a 32-bit number, or null.
 *
 * ★ A LEADING ZERO IS REFUSED rather than accepted. `010.0.0.1` is octal to some resolvers
 * and decimal to others; a probe that silently picks one is measuring its own guess. `null`
 * flows to `unparsed`, which cannot answer the abandon question and therefore cannot
 * accidentally answer it wrongly.
 */
export function parseIpv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text ?? "").trim());
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i += 1) {
    const raw = m[i];
    if (raw.length > 1 && raw.startsWith("0")) return null;
    const octet = Number(raw);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

/** Parse `a.b.c.d` or `a.b.c.d/bits` into `{base, bits}`, or null. A bare address is /32. */
export function parseIpv4Cidr(text) {
  const s = String(text ?? "").trim();
  const at = s.indexOf("/");
  if (at < 0) {
    const ip = parseIpv4(s);
    return ip === null ? null : { base: ip, bits: 32 };
  }
  const ip = parseIpv4(s.slice(0, at));
  const bitsText = s.slice(at + 1);
  if (ip === null || !/^\d{1,2}$/.test(bitsText)) return null;
  const bits = Number(bitsText);
  if (bits < 0 || bits > 32) return null;
  return { base: ip, bits };
}

/**
 * Is `ipText` inside `cidrText`?
 *
 * ★ `/0` IS SPECIAL-CASED ON PURPOSE. JavaScript's shift operators take the count mod 32,
 * so `0xffffffff << 32` is `0xffffffff << 0` — an all-ones mask — and a `/0` deny entry
 * (`ALL_TRAFFIC`) would compare equal to nothing instead of to everything. That inversion
 * would make the single most important deny entry read as matching NO address, and every
 * resolver would come back "outside the deny set" on a run that had denied all traffic.
 */
export function ipv4InCidr(ipText, cidrText) {
  const ip = parseIpv4(ipText);
  const cidr = parseIpv4Cidr(cidrText);
  if (ip === null || cidr === null) return false;
  if (cidr.bits === 0) return true;
  const mask = (0xffffffff << (32 - cidr.bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((cidr.base & mask) >>> 0);
}

/** A crude but sufficient IPv6-literal test: a colon can appear in no IPv4 literal. */
export function looksLikeIpv6(text) {
  return String(text ?? "").includes(":");
}

/**
 * Parse the nameserver addresses out of a `/etc/resolv.conf`.
 *
 * Comment lines (`#` / `;`) are dropped, because a commented-out nameserver is not the
 * guest's resolver and treating one as such would answer the abandon question about a line
 * nothing reads.
 */
export function parseResolvConf(text) {
  const out = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^nameserver\s+(\S+)/i.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Classify each resolver against the declared deny set. THE ABANDON QUESTION'S ENGINE.
 *
 * ★★★ "COULD NOT DECIDE" IS ITS OWN BUCKET, and folding it into `outside` would be this
 * programme's [[checks-that-nothing-runs]] class in miniature: an unparseable resolver
 * would silently report "the approach survives". Three buckets, and the caller must
 * consume all three:
 *
 *   inside   — a nameserver falls in a denied range. THE APPROACH IS DOOMED: `denyOut` has
 *              no exclude, and adding an `allowOut` entry to carve one out flips the whole
 *              policy to default-deny.
 *   outside  — decided, and safe. An IPv6 nameserver against an IPv4-ONLY deny set is
 *              decided too (`outside-by-family`) — no IPv4 CIDR can contain it.
 *   undecided— we cannot say: an unparseable address, or an IPv6 nameserver against a deny
 *              set that also declares IPv6 ranges (this core does no IPv6 containment).
 */
export function classifyResolvers(resolvers, denySetCidrs) {
  const cidrs = (denySetCidrs ?? []).map(String);
  const denySetHasV6 = cidrs.some((c) => looksLikeIpv6(c));
  const inside = [];
  const outside = [];
  const undecided = [];
  for (const resolver of resolvers ?? []) {
    const address = String(resolver ?? "").trim();
    if (address.length === 0) continue;
    if (looksLikeIpv6(address)) {
      if (denySetHasV6) {
        undecided.push({ address, why: "an IPv6 nameserver against a deny set that also declares IPv6 ranges; this core does no IPv6 containment" });
      } else {
        outside.push({ address, cidr: null, why: "outside-by-family: an IPv6 nameserver cannot be contained by an IPv4-only deny set" });
      }
      continue;
    }
    if (parseIpv4(address) === null) {
      undecided.push({ address, why: "not a parseable IPv4 literal" });
      continue;
    }
    const hit = cidrs.find((c) => !looksLikeIpv6(c) && ipv4InCidr(address, c));
    if (hit !== undefined) inside.push({ address, cidr: hit, why: "the resolver's address falls inside a DENIED range" });
    else outside.push({ address, cidr: null, why: "no declared IPv4 deny entry contains it" });
  }
  return { inside, outside, undecided };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE TARGET SET — every row carries the ROLE that makes it evidence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What each row is FOR. A number with no role is not evidence.
 *
 *   positive_control    — must be REACHED in the policy arm, or nothing else may be read
 *   apparatus_control   — must FAIL everywhere, or the probe is not reading the network
 *   question            — the measurement: does the deny set change its outcome?
 *   product_regression  — must be REACHED under the deny set, or the control would break
 *                         the product it is meant to protect
 *   observation         — reported, never load-bearing
 */
export const TARGET_ROLES = Object.freeze([
  "positive_control",
  "apparatus_control",
  "question",
  "product_regression",
  "observation",
]);

/** The IPv4 metadata address, in the spelling every cloud runbook uses. */
export const METADATA_V4 = "169.254.169.254";

/**
 * The HTTP target set. `family` records which stack the spelling forces, so an IPv4-only
 * deny set that leaves every IPv6 spelling open is visible as a PATTERN across rows rather
 * than as one anomalous line.
 */
export const HTTP_TARGETS = Object.freeze([
  Object.freeze({
    id: "allowed_public",
    role: "positive_control",
    family: "v4",
    url: "https://example.com/",
    why: "A boring public host, in NO deny set. Must be REACHED in the policy arm — a run where everything fails cannot tell an enforced deny set from a sandbox with no egress.",
  }),
  Object.freeze({
    id: "unresolvable",
    role: "apparatus_control",
    family: "n/a",
    url: "https://aoa-w10b-must-not-resolve.invalid/",
    why: "RFC 2606 reserves `.invalid`; it can never resolve. Must FAIL in every arm, or the probe is reading something other than the network and NO verdict may be taken.",
  }),
  Object.freeze({
    id: "metadata_v4",
    role: "question",
    family: "v4",
    url: `http://${METADATA_V4}/latest/meta-data/`,
    why: "THE MEASUREMENT. Inside 169.254.0.0/16. E8-F003 measured this answering HTTP 401 from inside a real guest — reachable, with only IMDSv2's token requirement in the way.",
  }),
  Object.freeze({
    id: "metadata_v4_mapped",
    role: "question",
    family: "v6-mapped",
    url: `http://[::ffff:${METADATA_V4}]/latest/meta-data/`,
    why: "The SAME destination over an IPv4-mapped IPv6 socket. An IPv4-only deny set may not see it — the SDK's only sentinel is ALL_TRAFFIC = 0.0.0.0/0, with no ::/0.",
  }),
  Object.freeze({
    id: "metadata_v4_mapped_hex",
    role: "question",
    family: "v6-mapped",
    url: "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
    why: "The same address again, in the hexadecimal ::ffff: spelling. A filter that string-matches rather than range-matches sees a different address here.",
  }),
  Object.freeze({
    id: "metadata_v6",
    role: "question",
    family: "v6",
    url: "http://[fd00:ec2::254]/latest/meta-data/",
    why: "The IPv6 instance-metadata address. Reachable here with an IPv4-only deny set applied would mean the control has an open IPv6 flank.",
  }),
  Object.freeze({
    id: "rfc1918_10",
    role: "question",
    family: "v4",
    url: "http://10.0.0.1/",
    why: "Inside 10.0.0.0/8. Whether it is reachable at all is unknown, which is exactly why the ANTI-VACUITY arm exists: only a difference between the arms is evidence.",
  }),
  Object.freeze({
    id: "dns_dependent",
    role: "product_regression",
    family: "v4",
    url: "https://registry.npmjs.org/",
    why: "The package registry every sandboxed install needs, AND a name that must resolve. A failure here under the deny set means the control breaks the product.",
  }),
  Object.freeze({
    id: "model_api",
    role: "product_regression",
    family: "v4",
    url: "https://api.anthropic.com/",
    why: "The model API every agent run needs. Any HTTP answer (401 included) is REACHED; only a transport failure is a regression.",
  }),
]);

/** The AoA control-plane row, whose URL is an operator input. See `resolveAoaApiTarget`. */
export const AOA_API_TARGET_ID = "aoa_api_url";

/**
 * The default AoA control-plane URL for the product-regression row.
 *
 * ★ IT IS A ROW, NOT AN ASSUMPTION. The guest must be able to reach the AoA API or the run
 * cannot report at all, so a deny set that blocks it would break the product more
 * completely than the SSRF it prevents. The default names the operator's deployed testing
 * instance and is a single `-o /dev/null` GET of its root; an operator with a different
 * control plane overrides it, and an operator who sets it EMPTY gets a row that reports
 * `not-supplied` and a regression verdict that SAYS which rows it covered — never a silent
 * pass on a control nobody exercised.
 */
export const DEFAULT_AOA_API_URL = "https://testing.armyofagents.org/";

export function resolveAoaApiTarget(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) {
    return { supplied: false, target: null, note: "no AOA control-plane URL was supplied; that product-regression row was NOT exercised" };
  }
  return {
    supplied: true,
    target: Object.freeze({
      id: AOA_API_TARGET_ID,
      role: "product_regression",
      family: "v4",
      url: trimmed,
      why: "The AoA control plane the guest must reach to report at all. A deny set that blocks it breaks the product more completely than the SSRF it prevents.",
    }),
    note: `AOA control-plane row exercised against ${trimmed}`,
  };
}

/** The raw-socket targets for question (e). Both are IPv4-literal, so no DNS is involved. */
export const RAW_TARGETS = Object.freeze([
  Object.freeze({
    id: "raw_tcp_nonhttp",
    mode: "connect",
    host: METADATA_V4,
    port: 22,
    why: "A raw TCP connect to an internal address on a NON-HTTP port. An L7 filter that only inspects HTTP leaves this open; a packet filter closes it.",
  }),
  Object.freeze({
    id: "raw_http_bytes",
    mode: "request",
    host: METADATA_V4,
    port: 80,
    why: "Hand-written HTTP request bytes over a raw socket, bypassing every HTTP client and every proxy environment variable. An L7 proxy that intercepts curl does not see these.",
  }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE IN-GUEST COMMAND, AND HOW ITS LINE IS READ
// ─────────────────────────────────────────────────────────────────────────────
//
// ★★★ THIS SHAPE COST THE SIBLING PROBE THREE RUNS AND IS COPIED DELIBERATELY, NOT
// REINVENTED. `.github/keyed-e2b-egress-constraint-trigger` records all three:
//
//   run #1 — all four targets chained into ONE `sh -c`; the FOURTH (the apparatus control)
//            produced no line at all in both arms and the loss was invisible. Fixed by ONE
//            COMMAND PER TARGET, each ending `exit 0`.
//   run #3 — `curl -w` writes to stdout and its error to stderr; `2>&1` interleaves them,
//            so the failing case came back as TWO lines on Linux and ONE on Windows. A
//            local dry-run on a different platform is not a control for the real one. Fixed
//            in BOTH producer (flatten to one line) and consumer (match across newlines).
//   and `$?` is read from the ASSIGNMENT, never through a pipe — `err=$(curl … | tr …)`
//   would make `$?` the status of `tr` and every target would report success.

/** Marker/sentinel pair. A truncated line is REJECTED rather than half-read. */
export const PROBE_MARKER = "W10B";

/** Raised when a command would be emitted that cannot survive its own `sh -c` wrapper. */
export class ProbeCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProbeCommandError";
  }
}

/**
 * Build the in-guest command for ONE HTTP target.
 *
 * `--max-time` bounds a hang, so a silently-dropped SYN — the shape a packet filter usually
 * takes — is recorded as curl exit 28 rather than stalling the run to the job cap.
 */
export function buildHttpTargetCommand(target) {
  const id = String(target?.id ?? "");
  const url = String(target?.url ?? "");
  if (id.length === 0 || url.length === 0) throw new ProbeCommandError("buildHttpTargetCommand: target needs an id and a url");
  const body = [
    `err=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 12 "${url}" 2>&1)`,
    "code=$?",
    'msg=$(printf "%s" "$err" | tr "\\n\\t" "  ")',
    `printf "${PROBE_MARKER} %s %s %s END\\n" "${id}" "$code" "$msg"`,
    "exit 0",
  ].join("; ");
  // Fail loudly here rather than shipping a mangled command to a real sandbox: the whole
  // body rides `sh -c '…'`, and one single quote would terminate the wrapper and turn this
  // into something that still exits 0 — a silently empty row.
  if (body.includes("'")) {
    throw new ProbeCommandError(`the command for target "${id}" contains a single quote; it would break the sh -c wrapper`);
  }
  return `sh -c '${body}'`;
}

/**
 * Parse one row out of a command's whole stdout.
 *
 * Matched across newlines with `[\s\S]`. The shell already flattens the diagnostic, so this
 * is the SECOND, INDEPENDENT defence against the same defect: if anything ever reintroduces
 * an embedded newline between the marker and the sentinel, the record is still assembled
 * instead of silently disappearing. Returns null when no complete line is present — which
 * the caller records as a MISSING row, never as a success.
 */
export function parseProbeLine(stdout, id) {
  const re = new RegExp(`${PROBE_MARKER}\\s+${String(id)}\\s+(\\d+)\\s+([\\s\\S]*?)\\s*END`);
  const m = re.exec(String(stdout ?? ""));
  if (!m) return null;
  const exitCode = Number.parseInt(m[1], 10);
  if (!Number.isFinite(exitCode)) return null;
  return { id: String(id), exitCode, detail: m[2].replace(/\s+/g, " ").trim().slice(0, 200) };
}

/**
 * The curl exit codes this pack reasons about, and what each one means for question (e).
 *
 * ★ 28 vs 7 IS THE PACKET-PATH SIGNAL, and it is the reason exit codes are kept rather than
 * flattened to a boolean. A dropped SYN times out (28); a stack that answers with an RST
 * refuses immediately (7). A destination that was reachable in the anti-vacuity arm and
 * TIMES OUT in the policy arm was dropped in the packet path.
 */
/**
 * ★★★ EACH MEANING CARRIES ITS PHASE, AND EVERY REFUSED/REACHED SPLIT IS DERIVED FROM IT.
 *
 * This map used to hold prose only, and the code that decided which exits counted as a
 * refusal was a separate hand-written rule elsewhere. The two drifted, exactly as two copies
 * of one fact do: the rule said "every nonzero exit is a refusal" while this map said, in
 * writing, that 35 and 56 mean the connection was MADE. A denied destination that was reached
 * and then broke at TLS was therefore counted as refused, and the allowlist arm could declare
 * enforcement on it. There is now ONE place the phase is written down — here — and every
 * consumer reads it through `curlExitPhase`, so the drift cannot recur.
 *
 *   "completed"       the transfer finished: the destination answered.
 *   "name-resolution" the name never became an address. Says NOTHING about reachability, and
 *                     this map has always said so; it must not be read as a refusal.
 *   "pre-connect"     the failure happened at or before the TCP connect. The ONLY phase that
 *                     may count as "the destination was not reached".
 *   "post-connect"    the connect succeeded and the failure came after. The destination WAS
 *                     reached, whatever happened next.
 */
export const CURL_EXIT_PHASES = Object.freeze(["completed", "name-resolution", "pre-connect", "post-connect"]);

export const CURL_EXIT_MEANINGS = Object.freeze({
  0: Object.freeze({ phase: "completed", meaning: "the transfer completed; the detail field holds the HTTP status" }),
  6: Object.freeze({ phase: "name-resolution", meaning: "could not resolve host — a DNS failure, not a reachability failure" }),
  7: Object.freeze({ phase: "pre-connect", meaning: "could not connect — the peer or the path answered immediately (refused / no route)" }),
  28: Object.freeze({ phase: "pre-connect", meaning: "operation timed out — the shape a silently-dropped packet takes" }),
  35: Object.freeze({ phase: "post-connect", meaning: "TLS handshake failure — the connection was MADE and then broke" }),
  56: Object.freeze({ phase: "post-connect", meaning: "failure receiving data — the connection was MADE and then broke" }),
});

/** The phase of one exit code, or `unmodelled` for a code nobody has reasoned about yet. */
export function curlExitPhase(exitCode) {
  const entry = CURL_EXIT_MEANINGS[exitCode];
  return entry ? entry.phase : "unmodelled";
}

/**
 * Reachability, kept SEPARATE from the cause.
 *
 *   "reached"    — curl completed the transfer
 *   "blocked"    — a terminal that means the transfer did not complete
 *   "no-result"  — no line was parsed. NOTHING may be concluded from this row.
 *
 * ★ THIS IS A TRANSFER-COMPLETION READING AND IT IS NOT THE ONE AN ENFORCEMENT CLAIM MAY USE.
 * "The transfer did not complete" is true of a refused SYN and of a TLS handshake that broke
 * after the connection was established, and only the first is evidence of a filter. Every
 * verdict that would assert "this destination was NOT reached" reads `classifyReachEvidence`
 * instead; this function survives for the control gates, where "did it complete" is the
 * question actually being asked.
 */
export function classifyHttpRow(row) {
  if (!row || typeof row.exitCode !== "number") return "no-result";
  return row.exitCode === 0 ? "reached" : "blocked";
}

/**
 * WHERE the row failed — the only reading an enforcement claim may rest on.
 *
 *   "reached"                the transfer completed.
 *   "reached-then-broke"     the connect succeeded; the failure came after. The destination
 *                            WAS reached, so this REFUTES enforcement for that target.
 *   "refused-before-connect" the failure happened at or before the TCP connect. The only
 *                            evidence that supports "this destination was refused".
 *   "indeterminate"          a name-resolution failure, or an exit code this pack does not
 *                            model. It is NOT a refusal: nothing may be concluded about
 *                            reachability, and a caller must treat it as BROKEN rather than
 *                            default it to either answer.
 *   "no-result"              no line was parsed.
 */
export const REACH_EVIDENCE = Object.freeze(["reached", "reached-then-broke", "refused-before-connect", "indeterminate", "no-result"]);

export function classifyReachEvidence(row) {
  if (!row || typeof row.exitCode !== "number") return "no-result";
  switch (curlExitPhase(row.exitCode)) {
    case "completed":
      return "reached";
    case "post-connect":
      return "reached-then-broke";
    case "pre-connect":
      return "refused-before-connect";
    default:
      return "indeterminate";
  }
}

/** The evidence with its exit code and this file's own words for it, for a report line. */
export function reachEvidenceNote(row) {
  if (!row || typeof row.exitCode !== "number") return "no row at all";
  const entry = CURL_EXIT_MEANINGS[row.exitCode];
  return `exit ${row.exitCode} (${entry ? entry.meaning : "an exit code this pack does not model, so it proves nothing either way"})`;
}

/** How a `blocked` row was blocked — the input to (e)'s packet-path reasoning. */
export function blockShape(row) {
  if (!row || typeof row.exitCode !== "number") return "unknown";
  if (row.exitCode === 0) return "reached";
  if (row.exitCode === 28) return "timed-out";
  if (row.exitCode === 7) return "refused-or-unrouted";
  if (row.exitCode === 6) return "dns-failure";
  return `curl-${row.exitCode}`;
}

/**
 * Classify a raw-socket row.
 *
 * The staged helper prints one of these words verbatim; anything else is `unknown`, which
 * is not a measurement. Never inferred from prose.
 */
export const RAW_OUTCOMES = Object.freeze(["connected", "refused", "timed-out", "unreachable", "unknown"]);

export function classifyRawRow(row) {
  const detail = String(row?.detail ?? "");
  if (!row || typeof row.exitCode !== "number") return "unknown";
  for (const outcome of ["connected", "refused", "timed-out", "unreachable"]) {
    if (detail.startsWith(outcome)) return outcome;
  }
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SECRET REDACTION — nothing the pack prints may carry a credential
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace every occurrence of every supplied secret VALUE with a fixed marker.
 *
 * The pack prints raw stdout and stderr, because "timed out" and "curl is missing" are
 * different answers and the operator must be able to tell them apart. An error that quotes
 * the environment would otherwise put the E2B key in a public Actions log. Short values are
 * ignored: a 3-character "secret" would redact ordinary prose and lose the evidence a
 * different way.
 */
export const REDACTION_MARKER = "«redacted»";
export const MIN_REDACTABLE_SECRET_LENGTH = 8;

export function redactSecrets(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets ?? []) {
    if (typeof secret !== "string") continue;
    if (secret.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    out = out.split(secret).join(REDACTION_MARKER);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE CONTROL GATE — every verdict passes through it FIRST
// ─────────────────────────────────────────────────────────────────────────────

const verdict = (probe, state, reason, detail) => ({ probe, state, reason, detail: detail ?? "" });

/**
 * Are the mandatory control rows satisfied? Returns `{ok, problems}`.
 *
 * ★★★ ALL FOUR ARE MANDATORY AND NONE SUBSTITUTES FOR ANOTHER:
 *
 *   POSITIVE      an allowed public host is REACHED in the policy arm. Proves the apparatus
 *                 can reach ANYTHING; without it a total outage reads as "enforced".
 *   APPARATUS     an RFC-2606 `.invalid` host FAILS. Proves the apparatus can OBSERVE a
 *                 failure; without it "everything reached" could be a probe that measures
 *                 nothing.
 *   ANTI-VACUITY  the question target is REACHED in the arm whose deny set does not name
 *                 it. Proves a deny result is caused by the POLICY and not by E2B blocking
 *                 that destination anyway.
 *   COMPLETENESS  no row is missing. A dropped row is what cost the sibling probe two runs.
 *
 * The product-regression rows are NOT in this gate: they qualify the CONSEQUENCE of an
 * enforced policy, not the soundness of the measurement, and they get their own verdict.
 */
export function evaluateControls({ policyArm, antiVacuityArm } = {}) {
  const problems = [];
  const rowOf = (arm, id) => arm?.rows?.[id] ?? null;

  if (!policyArm || policyArm.created !== true) {
    problems.push({
      code: "policy-arm-missing",
      detail: `the POLICY arm did not run: ${String(policyArm?.detail ?? "no record at all")}`,
    });
  }
  if (!antiVacuityArm || antiVacuityArm.created !== true) {
    problems.push({
      code: "anti-vacuity-arm-missing",
      detail:
        `the ANTI-VACUITY arm did not run: ${String(antiVacuityArm?.detail ?? "no record at all")}. Without it a deny ` +
        "result cannot be attributed to the policy rather than to E2B blocking the destination anyway.",
    });
  }
  if (problems.length > 0) return { ok: false, problems };

  // ★ STRICT ON PURPOSE, AND NOT TO BE "MADE CONSISTENT" WITH THE PHASE READING ELSEWHERE.
  // A completed transfer is the only thing that proves the apparatus can reach anything; a
  // connection that broke after connect is enough to REFUTE a block but not enough to
  // establish a healthy control. Relaxing this admits more verdicts, which is the one
  // direction that can close a crossing on a run that measured nothing.
  const positive = rowOf(policyArm, "allowed_public");
  if (classifyHttpRow(positive) !== "reached") {
    problems.push({
      code: "positive-control-failed",
      detail:
        `the allowed public host was NOT reached in the policy arm (${blockShape(positive)}). A run in which everything ` +
        "fails cannot tell an enforced deny set from a sandbox with no egress at all.",
    });
  }
  for (const arm of [policyArm, antiVacuityArm]) {
    const apparatus = rowOf(arm, "unresolvable");
    const state = classifyHttpRow(apparatus);
    if (state === "no-result") {
      problems.push({ code: "apparatus-control-missing", detail: `${arm.label}: the RFC-2606 .invalid row produced no result line at all` });
    } else if (state === "reached") {
      problems.push({
        code: "apparatus-control-violated",
        detail: `${arm.label}: the RFC-2606 .invalid host was REACHED. The probe is not measuring the network; no verdict may be taken.`,
      });
    }
  }
  const antiVacuity = rowOf(antiVacuityArm, "metadata_v4");
  const antiVacuityState = classifyHttpRow(antiVacuity);
  if (antiVacuityState !== "reached") {
    problems.push({
      code: "anti-vacuity-control-failed",
      detail:
        `the question target was NOT reached in the anti-vacuity arm (${blockShape(antiVacuity)}), whose deny set does ` +
        "NOT name it. Whatever blocks it there is not this policy, so a block in the policy arm proves nothing. " +
        "Choose a reachable internal target and re-run; do NOT read this as enforcement.",
    });
  }
  for (const arm of [policyArm, antiVacuityArm]) {
    const missing = (arm.expectedRowIds ?? []).filter((id) => !arm.rows?.[id]);
    if (missing.length > 0) {
      problems.push({ code: "rows-missing", detail: `${arm.label}: no result line for ${missing.join(", ")}` });
    }
  }
  return { ok: problems.length === 0, problems };
}

/** One line the whole pack shares, so a control failure reads identically everywhere. */
function controlsBlocked(probe, controls) {
  return verdict(
    probe,
    "inconclusive",
    "controls-failed",
    `the mandatory control rows did not hold, so nothing may be read from this run: ${controls.problems
      .map((p) => `${p.code} (${p.detail})`)
      .join("; ")}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. (a) IS THE DENY POLICY HONOURED?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Question (a): is a target INSIDE the declared deny set actually unreachable from the guest?
 *
 * The differential is `metadata_v4` in the POLICY arm against the same row in the
 * ANTI-VACUITY arm, and the control gate has already established that the anti-vacuity arm
 * REACHED it. So:
 *
 *   yes — blocked under the policy, reached without it. The deny set is enforced.
 *   no  — reached under the policy too. The deny set is INERT at this tier, exactly as the
 *         `metadata.egressAllowlist` seam was measured to be (E8-F003). A `no` here is a
 *         RESULT that closes the provider-network option and the lane stays green for it.
 *
 * ★ THE IPv6 SPELLINGS ARE REPORTED BESIDE THE VERDICT RATHER THAN FOLDED INTO IT. A deny
 * set that closes `169.254.169.254` and leaves `[::ffff:169.254.169.254]` open IS enforced —
 * and is also useless as a control. Both facts are true; collapsing them into one boolean
 * would lose whichever one the reader needed.
 */
export function verdictHonoured({ controls, policyArm, antiVacuityArm } = {}) {
  const probe = "a";
  if (!controls?.ok) return controlsBlocked(probe, controls ?? { problems: [{ code: "controls-not-evaluated", detail: "" }] });

  const underPolicy = policyArm.rows.metadata_v4;
  const state = classifyHttpRow(underPolicy);
  const spellings = ["metadata_v4_mapped", "metadata_v4_mapped_hex", "metadata_v6"]
    .map((id) => ({ id, state: classifyHttpRow(policyArm.rows[id]), shape: blockShape(policyArm.rows[id]) }));
  const openSpellings = spellings.filter((s) => s.state === "reached").map((s) => s.id);
  const unreadSpellings = spellings.filter((s) => s.state === "no-result").map((s) => s.id);
  const spellingNote =
    `IPv6 spellings of the SAME destination under the same policy: ` +
    spellings.map((s) => `${s.id}=${s.state}/${s.shape}`).join(" ") +
    (openSpellings.length > 0
      ? `. ★ ${openSpellings.length} of them REACHED — an IPv4-only deny set has an open IPv6 flank, which is expected: ` +
        `the SDK's only sentinel is ALL_TRAFFIC = ${ALL_TRAFFIC_SENTINEL}, with no ::/0.`
      : ".") +
    (unreadSpellings.length > 0 ? ` ${unreadSpellings.length} spelling row(s) produced no line: ${unreadSpellings.join(", ")}.` : "");

  if (state === "no-result") {
    return verdict(probe, "inconclusive", "question-row-missing", "the question target produced no result line in the policy arm; nothing may be concluded.");
  }
  // ★★★ THE ENFORCEMENT ANSWER READS THE PHASE, NOT THE EXIT BOOLEAN. "The transfer did not
  // complete" is true of a refused SYN AND of a TLS handshake that broke after the connection
  // was established — and only the first is evidence of a filter. Reading them alike is what
  // let the sibling allowlist arm report enforcement on a destination it had reached.
  const evidence = classifyReachEvidence(underPolicy);
  if (evidence === "refused-before-connect") {
    return verdict(
      probe,
      "yes",
      "denied-target-unreachable-under-policy",
      `${METADATA_V4} was ${blockShape(underPolicy)} AT OR BEFORE THE TCP CONNECT (${reachEvidenceNote(underPolicy)}) in the arm ` +
        `that declared it denied, and REACHED in the anti-vacuity arm whose deny set does not name it. The tier HONOURS ` +
        `denyOut at Sandbox.create. ${spellingNote}`,
    );
  }
  if (evidence === "indeterminate") {
    return verdict(
      probe,
      "inconclusive",
      "question-row-carries-an-unattributable-exit-code",
      `${METADATA_V4} came back with ${reachEvidenceNote(underPolicy)}, which does not say whether the destination was ` +
        "reached. It is NOT a refusal and must not be counted as one; name the code in CURL_EXIT_MEANINGS with its phase " +
        `and re-run. ${spellingNote}`,
    );
  }
  if (evidence === "reached-then-broke") {
    return verdict(
      probe,
      "no",
      "denied-target-reached-then-the-connection-broke",
      `${METADATA_V4} was REACHED under the policy — ${reachEvidenceNote(underPolicy)} — and the transfer failed only ` +
        `AFTERWARDS. The packets got there, so the deny set did not stop them; whatever broke the connection is not this ` +
        `policy. ${spellingNote}`,
    );
  }
  return verdict(
    probe,
    "no",
    "denied-target-still-reachable",
    `${METADATA_V4} was REACHED (${String(underPolicy.detail)}) from inside the sandbox that declared 169.254.0.0/16 in ` +
      `denyOut, exactly as from the anti-vacuity arm. The declared deny set is INERT at this tier — the same result the ` +
      `metadata.egressAllowlist seam already produced (E8-F003), one API surface over. That closes the provider-network ` +
      `option and it is a RESULT, not a failure. ${spellingNote}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. (b) DOES getInfo MATERIALIZE THE POLICY BACK?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Question (b): can a run VERIFY what was applied?
 *
 * ★★★ THIS IS NOT A NICE-TO-HAVE, AND IT IS WHY IT IS A QUESTION AND NOT AN ASSERTION.
 * `buildNetworkEgress` is a pure passthrough — the SDK validates nothing client-side and
 * the only error path is the HTTP status. The API target is per-company configurable
 * (`config.domain ?? env.E2B_DOMAIN`, with a self-hosted branch). A tolerant or self-hosted
 * server that IGNORES an unknown field returns 200 and hands back an UNPOLICED sandbox with
 * identical code and identical logs. Without a read-back there is no way to tell that
 * sandbox from a policed one, so a `no` here makes the approach unshippable EVEN IF (a) is
 * yes at the operator's own tier.
 *
 * A MISMATCH is its own answer and is NOT rounded to `yes`: the server accepted the request
 * and stored something else, which is worse than storing nothing because it would satisfy a
 * naive read-back check.
 */
export function verdictReadBack({ readBack, declared } = {}) {
  const probe = "b";
  if (!readBack || readBack.ok !== true) {
    return verdict(probe, "inconclusive", "getinfo-failed", `getInfo() did not return: ${String(readBack?.detail ?? "no record at all")}`);
  }
  const materialized = Array.isArray(readBack.denyOut) ? readBack.denyOut.map(String) : null;
  if (materialized === null) {
    return verdict(
      probe,
      "no",
      "network-not-materialized",
      `getInfo() succeeded and its SandboxInfo carries no denyOut (network=${JSON.stringify(readBack.network ?? null)}). ` +
        "A run cannot verify what was applied, so it would have to ASSUME — and a tolerant or self-hosted API that " +
        "ignores the field returns 200 and yields an unpoliced sandbox with identical code and identical logs.",
    );
  }
  const want = [...new Set((declared ?? []).map(String))].sort();
  const got = [...new Set(materialized)].sort();
  const missing = want.filter((c) => !got.includes(c));
  const extra = got.filter((c) => !want.includes(c));
  if (missing.length === 0 && extra.length === 0) {
    return verdict(
      probe,
      "yes",
      "policy-materialized-exactly",
      `getInfo() returned denyOut = [${got.join(", ")}], exactly the declared set. A run CAN verify what was applied ` +
        "instead of assuming it.",
    );
  }
  return verdict(
    probe,
    "no",
    "policy-materialized-but-differs",
    `getInfo() returned denyOut = [${got.join(", ")}] but [${want.join(", ")}] was declared` +
      `${missing.length > 0 ? `; MISSING: ${missing.join(", ")}` : ""}${extra.length > 0 ? `; UNEXPECTED: ${extra.join(", ")}` : ""}. ` +
      "The server accepted the request and stored something else. That is WORSE than storing nothing: a naive " +
      "read-back check would pass on it.",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. (c) ★ THE ABANDON QUESTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Question (c): is the guest's DNS RESOLVER inside the deny set?
 *
 * ★★★ A `yes` HERE ENDS THE OPTION, AND THE LANE STAYS GREEN FOR IT. There is no repair in
 * this API: `denyOut` has no exclude list, and adding ANY `allowOut` entry to carve the
 * resolver out flips the whole policy to default-deny ("If `allowOut` is not specified, all
 * outbound traffic is allowed" — so specifying it is the opposite of a carve-out). A deny
 * set that contains the resolver therefore breaks all name resolution in the guest, and
 * every product-regression row with it. Measuring that is a COMPLETE RESULT that saves the
 * programme a build; it is not a failure of the probe.
 *
 * TWO INDEPENDENT TRIGGERS, and either is sufficient:
 *
 *   STRUCTURAL — a nameserver address falls inside a declared deny range. This is
 *                enforcement-INDEPENDENT: it is true even at a tier that ignores denyOut
 *                entirely, which is what makes (c) answerable when (a) says `no`.
 *   EMPIRICAL  — name resolution measurably failed under the policy (curl exit 6 on the
 *                DNS-dependent row) while the same row resolved in the anti-vacuity arm.
 *
 * `undecided` resolvers are NOT read as safe. If any nameserver could not be classified and
 * the empirical half did not fire, the answer is `inconclusive` — the one thing that must
 * never happen here is reporting "the approach survives" on the strength of an address
 * nobody could parse.
 */
export function verdictResolverInDenySet({ resolvConf, denySet, dnsRow, antiVacuityDnsRow } = {}) {
  const probe = "c";
  const readable = typeof resolvConf?.text === "string" && resolvConf.ok === true;
  const empiricalFailed =
    classifyHttpRow(dnsRow) === "blocked" && blockShape(dnsRow) === "dns-failure" && classifyHttpRow(antiVacuityDnsRow) === "reached";

  if (!readable) {
    if (empiricalFailed) {
      return verdict(
        probe,
        "yes",
        "resolution-broke-under-policy",
        "/etc/resolv.conf could not be read, but name resolution MEASURABLY failed under the deny set (curl exit 6) " +
          "while the same name resolved in the anti-vacuity arm. Whatever the resolver's address is, the deny set " +
          "reaches it. ABANDON the provider-network option: denyOut has no exclude and any allowOut entry flips the " +
          "policy to default-deny.",
      );
    }
    return verdict(
      probe,
      "inconclusive",
      "resolv-conf-unreadable",
      `/etc/resolv.conf could not be read (${String(resolvConf?.detail ?? "no detail")}) and name resolution did not ` +
        "measurably fail, so neither trigger fired. The abandon question is UNANSWERED — do not read this as `safe`.",
    );
  }

  const resolvers = parseResolvConf(resolvConf.text);
  if (resolvers.length === 0) {
    return verdict(
      probe,
      "inconclusive",
      "no-nameserver-lines",
      "/etc/resolv.conf was read and contains no `nameserver` line at all. The guest resolves names some other way " +
        "(a container DNS shim, an /etc/hosts-only image), and this probe cannot say which address that reaches.",
    );
  }

  const cls = classifyResolvers(resolvers, denyCidrs(denySet));
  const shown = `nameservers: ${resolvers.join(", ")}; deny set: ${denyCidrs(denySet).join(", ")}`;

  if (cls.inside.length > 0) {
    return verdict(
      probe,
      "yes",
      "resolver-inside-the-deny-set",
      `★ ABANDON. ${cls.inside.map((r) => `${r.address} is inside ${r.cidr}`).join("; ")}. Denying that range breaks ALL ` +
        `name resolution in the guest and there is NO REPAIR IN THIS API: denyOut carries no exclude, and adding an ` +
        `allowOut entry to carve the resolver out flips the entire policy to default-deny. ${shown}` +
        (empiricalFailed ? " The empirical half agrees: resolution failed under the policy." : ""),
    );
  }
  if (empiricalFailed) {
    return verdict(
      probe,
      "yes",
      "resolution-broke-under-policy-despite-resolver-outside",
      `★ ABANDON, and by the more surprising route. No nameserver address is inside the declared deny set — ${shown} — ` +
        "and yet name resolution FAILED under the policy (curl exit 6) while the same name resolved in the anti-vacuity " +
        "arm. Something in the resolution path other than the nameserver's own address is being denied. The option is " +
        "as unusable as if the resolver were denied, and this is worth its own finding.",
    );
  }
  if (cls.undecided.length > 0) {
    return verdict(
      probe,
      "inconclusive",
      "resolver-unclassifiable",
      `${cls.undecided.map((r) => `${r.address} (${r.why})`).join("; ")}. Its containment is NOT established, so ` +
        "`the approach survives` may not be claimed from the remaining nameservers. Re-run or extend the classifier.",
    );
  }
  return verdict(
    probe,
    "no",
    "resolver-outside-the-deny-set",
    `The approach SURVIVES this question. ${cls.outside.map((r) => `${r.address}: ${r.why}`).join("; ")}. ${shown}. ` +
      "Name resolution also worked under the policy, so the deny set does not sit between the guest and its resolver.",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. (d) DOES updateNetwork RE-ASSERT A REUSED SANDBOX?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shape a (d) arm actually achieved. It is REPORTED, never assumed.
 *
 *   "warm-resume"          the sandbox was paused and resumed before the update — the shape
 *                          that models a lease coming back from a pause.
 *   "running-sandbox-only" pause was unavailable at this tier, so the update was applied to
 *                          a still-running reused sandbox. Still the question AoA's
 *                          `reuseLease` path asks, but NOT the resume half, and a verdict
 *                          built on it must say so rather than over-claim.
 */
export const REUSE_SHAPES = Object.freeze(["warm-resume", "running-sandbox-only"]);

/**
 * Question (d): does `updateNetwork` take effect on a reused sandbox?
 *
 * The arm creates a sandbox with NO network policy, proves the target is REACHABLE from it,
 * then applies the deny set with `updateNetwork` and probes again.
 *
 * ★ THE BEFORE ROW IS THE ARM'S OWN POSITIVE CONTROL and it is checked FIRST. Without it,
 * "unreachable after the update" is satisfied by a sandbox that could never reach the target
 * in the first place — the arm would confirm the update on the strength of nothing.
 */
export function verdictWarmReassert({ arm } = {}) {
  const probe = "d";
  if (!arm || arm.created !== true) {
    return verdict(probe, "inconclusive", "arm-missing", `the reuse arm did not run: ${String(arm?.detail ?? "no record at all")}`);
  }
  if (arm.updateOk !== true) {
    return verdict(
      probe,
      "inconclusive",
      "updatenetwork-threw",
      `updateNetwork did not succeed, so nothing was re-asserted and the question was not reached: ${String(arm.updateDetail ?? "no detail")}`,
    );
  }
  const before = classifyHttpRow(arm.before);
  const after = classifyHttpRow(arm.after);
  if (before === "no-result" || after === "no-result") {
    return verdict(probe, "inconclusive", "reuse-rows-missing", `before=${before} after=${after}; a missing row establishes nothing.`);
  }
  const shapeNote =
    arm.reuseShape === "warm-resume"
      ? "The sandbox was paused and resumed before the update, so this is the warm-resume shape."
      : `Pause was unavailable at this tier (${String(arm.reuseShapeDetail ?? "no detail")}), so the update was applied to a ` +
        "still-RUNNING reused sandbox. That is AoA's reuseLease question but NOT the resume half; do not read a resume result into it.";

  // Strict for the same reason the control gate is: this row is what makes "unreachable
  // after" mean anything, and a control that only half-worked cannot license a `yes`.
  if (before !== "reached") {
    return verdict(
      probe,
      "inconclusive",
      "reuse-arm-positive-control-failed",
      `the target was NOT reachable BEFORE the update (${blockShape(arm.before)}), so "unreachable after" is satisfied by a ` +
        "sandbox that could never reach it. The arm's own positive control did not hold.",
    );
  }
  // The same phase reading as (a): an update that "took effect" must have stopped the packets,
  // not merely broken the transfer after they arrived.
  const afterEvidence = classifyReachEvidence(arm.after);
  if (afterEvidence === "refused-before-connect") {
    return verdict(
      probe,
      "yes",
      "update-took-effect-on-a-reused-sandbox",
      `the target was REACHED before updateNetwork and ${blockShape(arm.after)} after it — refused AT OR BEFORE THE TCP ` +
        `CONNECT (${reachEvidenceNote(arm.after)}) — on the same sandbox. A reused lease CAN be re-policed rather than ` +
        `trusted. ${shapeNote}`,
    );
  }
  if (afterEvidence === "indeterminate") {
    return verdict(
      probe,
      "inconclusive",
      "post-update-row-carries-an-unattributable-exit-code",
      `after the update the target came back with ${reachEvidenceNote(arm.after)}, which does not say whether it was ` +
        `reached. Counting it as a block would credit updateNetwork with a failure it may have had no part in. ${shapeNote}`,
    );
  }
  if (afterEvidence === "reached-then-broke") {
    return verdict(
      probe,
      "no",
      "update-did-not-stop-the-packets",
      `after updateNetwork the target was still REACHED — ${reachEvidenceNote(arm.after)} — and the transfer broke only ` +
        `afterwards. The connection was established, so the re-asserted policy did not stop it. ${shapeNote}`,
    );
  }
  return verdict(
    probe,
    "no",
    "update-did-not-take-effect",
    `updateNetwork returned successfully and the target was still REACHED afterwards (${String(arm.after.detail)}). A reused ` +
      `lease CANNOT be re-policed through this call, so any design that re-asserts policy on reuse is unavailable. ${shapeNote}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. (e) PACKET PATH OR L7 PROXY?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Question (e): WHERE does enforcement live?
 *
 * ★★★ THE ANSWER DECIDES WHETHER THE CONTROL IS A CONTROL. Every in-guest mechanism is
 * agent-writable by construction — `buildE2bLoginShellScript` sources `/etc/profile`,
 * `$HOME/.profile` and `$HOME/.bashrc` from an AGENT-WRITABLE home before `exec env … claude`
 * — and Node's global `fetch` IGNORES every proxy environment variable, which was MEASURED
 * (the proxy port was never contacted and the request returned 200) on an image that is
 * `node:22`. So an L7 proxy the guest can route around is not a boundary against the very
 * workload it is meant to contain. Only enforcement in the packet path survives that.
 *
 * A raw TCP connect to an internal address on a NON-HTTP port, and hand-written HTTP bytes
 * on a raw socket, are both invisible to an HTTP-only filter and both closed by a packet
 * filter. Read against the anti-vacuity arm, they separate the two.
 *
 * ★ WHEN (a) SAID `no`, THIS IS `no` AND NOT `inconclusive`. If nothing was blocked there is
 * no enforcement to locate, and reporting "run me again" would ask the operator to re-spend
 * an authorised run on a question the previous run already dissolved.
 */
export function verdictEnforcementLayer({ controls, honoured, policyArm, antiVacuityArm } = {}) {
  const probe = "e";
  if (!controls?.ok) return controlsBlocked(probe, controls ?? { problems: [{ code: "controls-not-evaluated", detail: "" }] });

  if (honoured?.state === "no") {
    return verdict(
      probe,
      "no",
      "nothing-was-blocked-so-there-is-no-layer-to-locate",
      "question (a) measured the deny set INERT: the target was reached under the policy. There is no enforcement " +
        "anywhere, so asking which layer holds it is dissolved rather than unanswered.",
    );
  }
  if (honoured?.state !== "yes") {
    return verdict(probe, "inconclusive", "honoured-question-unanswered", `question (a) is ${String(honoured?.state ?? "missing")}, so (e) has no premise to build on.`);
  }

  const rows = RAW_TARGETS.map((t) => ({
    id: t.id,
    policy: classifyRawRow(policyArm.rawRows?.[t.id]),
    control: classifyRawRow(antiVacuityArm.rawRows?.[t.id]),
    tool: String(policyArm.rawRows?.[t.id]?.tool ?? antiVacuityArm.rawRows?.[t.id]?.tool ?? "none"),
  }));
  const shown = rows.map((r) => `${r.id}: policy=${r.policy} control=${r.control} (tool=${r.tool})`).join("; ");

  const unusable = rows.filter((r) => r.policy === "unknown" || r.control === "unknown");
  if (unusable.length > 0) {
    return verdict(
      probe,
      "inconclusive",
      "raw-socket-rows-unusable",
      `${unusable.map((r) => r.id).join(", ")} produced no classifiable outcome — usually a template with no raw-socket ` +
        `tool. Re-dispatch with an image that carries python3 (aoa-base does). ${shown}`,
    );
  }
  // The control arm must be able to reach the raw targets, or "closed under policy" means nothing.
  const controlOpen = rows.filter((r) => r.control === "connected");
  if (controlOpen.length === 0) {
    return verdict(
      probe,
      "inconclusive",
      "raw-targets-unreachable-in-the-control-arm",
      `no raw target connected in the ANTI-VACUITY arm, so their closure under the policy is unattributable. ${shown}`,
    );
  }
  const stillOpenUnderPolicy = controlOpen.filter((r) => r.policy === "connected");
  if (stillOpenUnderPolicy.length > 0) {
    return verdict(
      probe,
      "no",
      "enforcement-is-not-in-the-packet-path",
      `HTTP through curl was blocked, but ${stillOpenUnderPolicy.map((r) => r.id).join(", ")} still CONNECTED under the same ` +
        `policy. Enforcement is at an L7/HTTP layer, not in the packet path — and an L7 layer is not a boundary against ` +
        `this workload: the guest's login shell is agent-writable, and Node's global fetch ignores every proxy variable ` +
        `on a node:22 image. ${shown}`,
    );
  }
  return verdict(
    probe,
    "yes",
    "enforcement-is-in-the-packet-path",
    `every raw target that CONNECTED in the anti-vacuity arm was closed under the policy, on a non-HTTP port and with ` +
      `hand-written request bytes that no HTTP client and no proxy variable touches. Enforcement is below L7. ${shown}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. THE PRODUCT-REGRESSION VERDICT — would the control break the product?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Would the deny set break the things the product needs?
 *
 * ★ IT IS A SEPARATE VERDICT, not a control gate, and the distinction is deliberate. A
 * regression does not make the MEASUREMENT unsound — (a), (b), (c) and (e) are all still
 * readable — it makes the CONTROL unshippable. Folding it into the gate would turn "this
 * policy would break npm" into "this run measured nothing", which throws away four answers
 * to report one.
 *
 * ★★ A ROW THAT WAS NOT EXERCISED IS NAMED, NEVER COUNTED AS PASSING. The AoA control-plane
 * row is an operator input; when it is absent the verdict says which rows it covered and
 * which it did not, so nobody reads a partial regression check as a complete one.
 */
export function verdictProductRegression({ controls, policyArm, exercisedIds, skippedIds } = {}) {
  const probe = "regression";
  if (!controls?.ok) return controlsBlocked(probe, controls ?? { problems: [{ code: "controls-not-evaluated", detail: "" }] });

  const ids = exercisedIds ?? [];
  const skipped = skippedIds ?? [];
  const results = ids.map((id) => ({ id, state: classifyHttpRow(policyArm.rows[id]), shape: blockShape(policyArm.rows[id]) }));
  const shown = results.map((r) => `${r.id}=${r.state}/${r.shape}`).join(" ");
  const coverage = skipped.length > 0 ? ` NOT EXERCISED: ${skipped.join(", ")} — this check is PARTIAL.` : "";

  const missing = results.filter((r) => r.state === "no-result");
  if (missing.length > 0) {
    return verdict(probe, "inconclusive", "regression-rows-missing", `${missing.map((r) => r.id).join(", ")} produced no result line.${coverage}`);
  }
  const broken = results.filter((r) => r.state !== "reached");
  if (broken.length > 0) {
    return verdict(
      probe,
      "yes",
      "the-deny-set-breaks-the-product",
      `under the deny set, ${broken.map((r) => `${r.id} (${r.shape})`).join(", ")} could NOT be reached. A control that ` +
        `breaks DNS, the package registry, the model API or the AoA control plane is unshippable whatever (a) says. ${shown}${coverage}`,
    );
  }
  return verdict(
    probe,
    "no",
    "the-deny-set-does-not-break-the-product",
    `every exercised product-regression row was REACHED under the deny set: ${shown}.${coverage}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. THE PACK'S DISPOSITION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How the LANE should terminate.
 *
 * ★★★ A `no` KEEPS THE LANE GREEN, AND SO DOES THE ABANDON `yes` ON (c). If the only green
 * outcome were "the boundary works", then "the boundary does not work" would arrive as a red
 * build — indistinguishable from a bad key, a template change or an outage — and the
 * operator's authorised run would have bought an ambiguity instead of an answer.
 * `inconclusive` is the ONLY state that reds, because it is the only one that means "the
 * apparatus did not answer; run me again".
 */
export function packDisposition(verdicts) {
  const list = (verdicts ?? []).filter(Boolean);
  if (list.length === 0) {
    return { exitCode: 1, disposition: "inconclusive", detail: "no probe produced a verdict at all" };
  }
  const bad = list.filter((v) => v.state === "inconclusive");
  if (bad.length > 0) {
    return {
      exitCode: 1,
      disposition: "inconclusive",
      detail: `inconclusive probes: ${bad.map((v) => `${v.probe} (${v.reason})`).join("; ")}`,
    };
  }
  return { exitCode: 0, disposition: "measured", detail: list.map((v) => `${v.probe}=${v.state}`).join(" ") };
}

/**
 * The operator-facing headline: what this run DECIDED about the provider-network option.
 *
 * ★ THE STOP CONDITION IS COMPUTED, NOT LEFT TO THE READER. Five three-state verdicts admit
 * a lot of combinations, and the one that matters most — (c) says the resolver is denied —
 * is the one a reader skimming five green-ish lines is most likely to miss. So the pack
 * states the consequence itself, in the report and in the durable record.
 */
export function decideOption(verdicts) {
  const by = new Map((verdicts ?? []).filter(Boolean).map((v) => [v.probe, v]));
  const c = by.get("c");
  const a = by.get("a");
  const b = by.get("b");
  const e = by.get("e");
  const reg = by.get("regression");

  if (c?.state === "yes") {
    return {
      decision: "abandon",
      because: "resolver-or-resolution-is-inside-the-deny-set",
      detail:
        "★ STOP. The guest's name resolution is inside the deny set, and this API has no repair: denyOut carries no " +
        "exclude, and adding an allowOut entry to carve the resolver out flips the whole policy to default-deny. The " +
        "provider-network option is ABANDONED. That is a COMPLETE AND VALUABLE RESULT — it closes the last candidate " +
        "enforcement layer outside the guest, and DE-08 must then be recorded as having no available provider-level " +
        "control rather than an unbuilt one.",
    };
  }
  if (a?.state === "no") {
    return {
      decision: "abandon",
      because: "denyout-is-inert-at-this-tier",
      detail:
        "The declared deny set had no effect: the target was reached under the policy exactly as without it. The " +
        "provider-network option is unavailable at this tier for the same reason the metadata.egressAllowlist seam was " +
        "(E8-F003), one API surface over.",
    };
  }
  if (a?.state === "yes" && b?.state === "no") {
    return {
      decision: "abandon",
      because: "unverifiable",
      detail:
        "The deny set was honoured HERE, but the applied policy cannot be read back, so no run could ever verify what it " +
        "got. Since the API target is per-company configurable and the SDK validates nothing client-side, a tolerant or " +
        "self-hosted server would hand back an unpoliced sandbox with identical code and identical logs. Unshippable as a " +
        "control even though it worked in this measurement.",
    };
  }
  if (a?.state === "yes" && b?.state === "yes" && reg?.state === "yes") {
    return {
      decision: "blocked-on-regression",
      because: "the-control-breaks-the-product",
      detail: "Enforced and verifiable, but the deny set broke a product-regression row. Narrow the set and re-measure before designing anything on it.",
    };
  }
  if (a?.state === "yes" && b?.state === "yes") {
    return {
      decision: "viable",
      because: e?.state === "yes" ? "enforced-verifiable-and-in-the-packet-path" : "enforced-and-verifiable",
      detail:
        "The provider-network option is AVAILABLE and the programme-wide premise that booked it as unavailable is " +
        `refuted by measurement${e?.state === "no" ? ". NOTE: enforcement is at L7, which the guest can route around — read (e) before designing on this" : ""}.`,
    };
  }
  return {
    decision: "undecided",
    because: "not-every-decisive-question-was-answered",
    detail: `verdicts: ${(verdicts ?? []).filter(Boolean).map((v) => `${v.probe}=${v.state}`).join(" ") || "(none)"}`,
  };
}

/** Human-readable one-liner per verdict, for the log and the job summary. */
export function formatVerdict(v) {
  return `PROBE ${v.probe}: ${String(v.state).toUpperCase()} — ${v.reason}\n    ${v.detail}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. THE DURABLE RECORD — the run's answer must survive the job log
// ─────────────────────────────────────────────────────────────────────────────

/** The record's shape identifier, so a later reader can tell what it is holding. */
export const PROBE_RECORD_SCHEMA = "aoa.w10b.egress-enforcement-record/1";

/** Raised when a record would be written that cannot be interpreted later. */
export class ProbeRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProbeRecordError";
  }
}

/**
 * Build the structured record the keyed run leaves behind.
 *
 * ★★★ THE VERDICT MUST NOT LIVE ONLY IN A JOB LOG. E7-F025 measured this programme's own
 * instance: a sibling keyed lane fired twice and NO document in the repo records either
 * outcome, so the honest state of that measurement is "fired and unrecorded" and the next
 * session re-asks the question.
 *
 * ★★ A RECORD THAT OMITS THE TEMPLATE OR THE DENY SET CANNOT BE INTERPRETED LATER. The
 * template is an operator input invisible to every protocol surface (E7-F022), and a
 * reachability result means nothing without the deny set it was measured against — the same
 * targets under a different set are a different experiment. Both are REQUIRED and this
 * function REFUSES rather than writing a record without them.
 */
export function buildProbeRecord({
  verdicts,
  disposition,
  decision,
  template,
  templateSource,
  templateNote,
  denySet,
  commitSha,
  runNonce,
  generatedAt,
  workflowRunUrl,
  observations,
} = {}) {
  const resolvedTemplate = typeof template === "string" ? template.trim() : "";
  if (resolvedTemplate.length === 0) {
    throw new ProbeRecordError(
      "buildProbeRecord: the resolved template id is REQUIRED. A record that does not say which image answered cannot " +
        "be interpreted later (E7-F022) — refusing to write one.",
    );
  }
  const cidrs = denyCidrs(denySet ?? []);
  if (cidrs.length === 0) {
    throw new ProbeRecordError(
      "buildProbeRecord: the declared deny set is REQUIRED. A reachability result is meaningless without the policy it " +
        "was measured against — refusing to write one.",
    );
  }
  const list = (verdicts ?? []).filter(Boolean);
  const d = disposition ?? packDisposition(list);
  const dec = decision ?? decideOption(list);
  return {
    schema: PROBE_RECORD_SCHEMA,
    generatedAt: typeof generatedAt === "string" && generatedAt.length > 0 ? generatedAt : "unknown",
    commitSha: typeof commitSha === "string" && commitSha.length > 0 ? commitSha : "unknown",
    workflowRunUrl: typeof workflowRunUrl === "string" && workflowRunUrl.length > 0 ? workflowRunUrl : "unknown",
    runNonce: typeof runNonce === "string" && runNonce.length > 0 ? runNonce : "unknown",
    template: {
      resolved: resolvedTemplate,
      source: typeof templateSource === "string" && templateSource.length > 0 ? templateSource : "unknown",
      note: typeof templateNote === "string" ? templateNote : "",
    },
    denySet: cidrs,
    disposition: { disposition: d.disposition, exitCode: d.exitCode, detail: d.detail },
    decision: { decision: dec.decision, because: dec.because, detail: dec.detail },
    probes: list.map((v) => ({
      probe: String(v.probe),
      state: String(v.state),
      reason: String(v.reason),
      detail: String(v.detail ?? ""),
    })),
    observations: observations && typeof observations === "object" ? observations : {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. THE LANE'S OWN DURABILITY, ASSERTED AGAINST THE WORKFLOW YAML
// ─────────────────────────────────────────────────────────────────────────────
//
// ★★★ WITHOUT THIS, EVERYTHING ABOVE IS UNGUARDED. `buildProbeRecord` can be perfect and the
// record still never reach anyone, because whether it is uploaded — and whether it is
// uploaded on a RED run — is decided in YAML that no test reads. That is this programme's
// [[checks-that-nothing-runs]] class: the mechanism exists, nothing asserts it fires.
//
// The shape is lifted from `scripts/lib/ci-lanes.mjs`'s `uploadsEvidenceBundleOnFailure` and
// from W7U1's `evaluateDurableRecord`: bound the step block by indentation, require an `if:`
// naming `always()`/`failure()`, and require the step to reference the artefact SPECIFICALLY
// so a guarded upload of something else cannot satisfy the rule.

/** Extract the block of the step containing line `i`, bounded by indentation. */
function stepBlockAround(lines, i) {
  let start = i;
  while (start >= 0 && !/^\s*-\s/.test(lines[start])) start -= 1;
  if (start < 0) start = i;
  const stepIndent = (lines[start].match(/^(\s*)-/) || [, ""])[1].length;
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() !== "" && l.match(/^(\s*)/)[1].length <= stepIndent) break;
    end += 1;
  }
  return lines.slice(start, end).join("\n");
}

const GUARDED_IF = /(^|\n)\s*if:[^\n]*(failure\(\)|always\(\))/;

/**
 * Does the W10B lane leave a durable, retrievable record — on a RED run as well as a green
 * one — does its shell fallback agree with the pure core about the template, and does it
 * carry the positive-control step that stops a keyless SKIP from reading as success?
 *
 * @param {string} workflowText the raw YAML of the lane
 * @param {{recordPathVar?: string, defaultTemplateVar?: string}} [opts]
 * @returns {{violations: {code: string, detail: string}[]}}
 */
export function evaluateDurableRecord(workflowText, opts = {}) {
  const recordPathVar = opts.recordPathVar ?? "W10B_RECORD_PATH";
  const defaultTemplateVar = opts.defaultTemplateVar ?? "W10B_DEFAULT_TEMPLATE";
  // ★★★ COMMENT LINES ARE BLANKED BEFORE ANYTHING IS SEARCHED, AND THIS IS NOT TIDINESS —
  // it is a defect this file's own suite caught. The lane's skip-guard step carries a comment
  // that MENTIONS `exit 1` ("…if this step's `exit 1` is ever softened"), so a search over the
  // raw bytes found the guard satisfied by the sentence describing it: deleting the real
  // `exit 1` left the check green. That is exactly this programme's [[checks-that-nothing-runs]]
  // class — prose being credited as enforcement — one layer inside the guard that exists to
  // prevent it. Blanking (rather than deleting) preserves the indentation `stepBlockAround`
  // reads, and a blank line is skipped by its walk.
  const rawLines = String(workflowText ?? "").split(/\r?\n/);
  const lines = rawLines.map((l) => (/^\s*#/.test(l) ? "" : l));
  const text = lines.join("\n");
  const violations = [];

  // 1 + 2. The upload step: it must exist, reference the record, and be guarded so that the
  // INCONCLUSIVE run — the one whose detail somebody will actually need — is not the one
  // whose artefact gets dropped.
  let uploadFound = false;
  let uploadGuarded = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/uses:\s*actions\/upload-artifact/.test(lines[i])) continue;
    const block = stepBlockAround(lines, i);
    const referencesRecord =
      new RegExp(`(^|\\n)\\s*path:[^\\n]*${recordPathVar}`).test(block) ||
      /(^|\n)\s*name:[^\n]*w10b[^\n]*record/i.test(block);
    if (!referencesRecord) continue;
    uploadFound = true;
    if (GUARDED_IF.test(block)) uploadGuarded = true;
  }
  if (!uploadFound) {
    violations.push({
      code: "record-upload-missing",
      detail:
        "no `actions/upload-artifact` step uploads the W10B probe record. The verdict would exist only in the job log — " +
        "E7-F025's exact shape: a keyed lane that fired and left nothing behind.",
    });
  } else if (!uploadGuarded) {
    violations.push({
      code: "record-upload-unguarded",
      detail:
        "the record's `upload-artifact` step is not guarded by `if: always()` (or `failure()`), so it is SKIPPED on a red " +
        "run. An inconclusive run is precisely the run whose detail someone needs, and precisely the run a success-gated " +
        "upload throws away.",
    });
  }

  // 3. The fallback writer: if the pack never reaches its own reporting stage (a crash, a
  // failed install, a lost secret), something must still write a record saying so.
  let fallbackFound = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!new RegExp(`${recordPathVar}`).test(lines[i])) continue;
    const block = stepBlockAround(lines, i);
    if (!/(^|\n)\s*run:/.test(block)) continue;
    if (!GUARDED_IF.test(block)) continue;
    fallbackFound = true;
    break;
  }
  if (!fallbackFound) {
    violations.push({
      code: "record-fallback-missing",
      detail:
        `no \`always()\`-guarded \`run:\` step writes ${recordPathVar}. A pack that dies before its own reporting stage ` +
        "would then upload nothing at all, and the run would again be `fired and unrecorded`.",
    });
  }

  // 4. The fallback's template default is duplicated in shell (the pack resolves in JS). Pin
  // the two together so they cannot drift into disagreeing about which image ran.
  const declared = new RegExp(`${defaultTemplateVar}:\\s*"?([A-Za-z0-9._-]+)"?`).exec(text);
  if (!declared) {
    violations.push({
      code: "default-template-undeclared",
      detail: `the workflow declares no ${defaultTemplateVar}, so its fallback record cannot name the resolved template.`,
    });
  } else if (declared[1] !== PROBE_TEMPLATE_ALIAS) {
    violations.push({
      code: "default-template-mismatch",
      detail:
        `${defaultTemplateVar} is "${declared[1]}" but the pure core resolves an omitted input to "${PROBE_TEMPLATE_ALIAS}". ` +
        "The record and the run would name different images.",
    });
  }

  // 5. THE POSITIVE CONTROL ON THE LANE ITSELF. Without a key the pack SKIPS, which is a
  // GREEN vitest run — this programme's single most repeated defect class ([[checks-that-
  // nothing-runs]], variant: a lane that lost its secret reports success while proving
  // nothing). A step must assert the key was present and fail the job if it was not.
  let skipGuardFound = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/E2B_API_KEY/.test(lines[i])) continue;
    const block = stepBlockAround(lines, i);
    if (!/(^|\n)\s*run:/.test(block)) continue;
    if (!/exit\s+1/.test(block)) continue;
    if (!/-z\s+"?\$\{?E2B_API_KEY/.test(block)) continue;
    skipGuardFound = true;
    break;
  }
  if (!skipGuardFound) {
    violations.push({
      code: "skip-positive-control-missing",
      detail:
        "no `run:` step fails the job when E2B_API_KEY is empty. Without a key the pack SKIPS and vitest exits 0, so a " +
        "lane that lost its secret would report success while measuring nothing.",
    });
  }

  return { violations };
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. THE ALLOWLIST ARM — the shape E2B DOCUMENTS as the control, never tested
// ─────────────────────────────────────────────────────────────────────────────
//
// ★★★ WHY THIS EXISTS, AND WHY THE FIRST RUN DID NOT ANSWER IT.
//
// Run 34085130892 measured ONE shape: a `denyOut` list of CIDRs with NO `allowOut`. It came
// back inert (E8-F008). That is a real result about THAT shape, and several records then
// generalised it to "the tier does not honour a network body" — a claim about ALL network
// bodies, inferred from one.
//
// E2B's own documentation (https://docs.e2b.dev/network/internet-access.md) presents the
// fine-grained control as the OPPOSITE construction: DEFAULT-DENY PLUS AN ALLOWLIST.
//
//     denyOut: ({ allTraffic }) => [allTraffic],   // allTraffic === "0.0.0.0/0"
//     allowOut: ["1.1.1.1", "8.8.8.0/24"]
//
// and it states that domains are NOT supported in deny lists — so domain-level filtering
// REQUIRES this form. It is the shape a real DE-08 control would have to take, and it is
// exactly the shape nobody has measured.
//
// ★★★ WHY THIS ARM IS NOW CIDRs/IPs ONLY (the domain was dropped after two UNRUN dispatches).
// A prior revision carried a third `allowOut` entry, `example.com` as a `kind:"hostname"`
// observation. A HOSTNAME in `allowOut` forces E2B's `validateEgressRules` to require
// `0.0.0.0/0` in `denyOut` AND routes the sandbox through the tcpproxy (L7) path — which
// reproducibly 500s at create ("failed to place") on this tier. Both prior dispatches
// therefore returned UNRUN and measured NOTHING (see the runbook §13.7 record). Removing the
// domain leaves `allowOut = ["8.8.8.0/24","1.1.1.1"]` — CIDRs/IPs only — which routes down the
// plain iptables path and should place, finally measuring whether E2B egress enforces. This is
// the single change from the shape that would not place; the differential and anti-vacuity
// reasoning below are otherwise unchanged.
//
// ★ THE RUNBOOK ALREADY KNEW THE MECHANISM AND FILED IT AS A HAZARD. §2 records that "any
// `allowOut` entry flips the whole policy to default-deny", and treated that as the STOP
// CONDITION to avoid — because carving the guest's DNS resolver out of a deny set is
// impossible, and a default-deny that starves the resolver would break the experiment
// rather than measure it. That reasoning was correct for the deny-set probe. It also means
// the allowlist shape was never attempted, and "flips to default-deny" is a HAZARD only
// while the resolver is unnameable. It is nameable: see below.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RESOLVER, WHICH IS WHAT MAKES THE ARM RUNNABLE AT ALL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The guest's DNS resolver, MEASURED — not assumed, and not read from documentation.
 *
 * ★★★ THIS IS THE FACT THE WHOLE ARM TURNS ON. Run 34085130892 read `/etc/resolv.conf`
 * inside BOTH sandboxes on the `aoa-base` template and both said, verbatim,
 * `nameserver 8.8.8.8` (probe (c)'s detail, and `observations.resolvConfPolicyArm` /
 * `observations.resolvConfControlArm` in `W10B-egress-enforcement-result.md`). It is a
 * static, public, globally-routed address — so unlike a dynamic in-fabric resolver it CAN
 * be named in an `allowOut` entry, and the documented shape is therefore usable for us.
 *
 * ★★ AND THE ARM DOES NOT TRUST THIS CONSTANT. It re-reads `/etc/resolv.conf` inside its own
 * guest and reports what it finds, and it runs a resolution probe that is independent of any
 * connect. If a future template moves the resolver, the arm says so instead of silently
 * measuring a starved sandbox — which would look identical to enforcement.
 */
export const MEASURED_GUEST_RESOLVER = "8.8.8.8";

/** The run that measured it, so the constant above can be re-derived rather than believed. */
export const MEASURED_GUEST_RESOLVER_RUN = "34085130892";

/**
 * What the allowlist arm ALLOWS. Everything else is denied by the `denyOut: [allTraffic]`
 * half, which is what makes this the documented shape rather than a second deny list.
 *
 * ★ EVERY ENTRY IS HERE FOR A NAMED REASON, and an entry with no reason is an entry that
 * quietly widens the control until the experiment cannot fail.
 */
export const ALLOWLIST_ALLOW_SET = Object.freeze([
  Object.freeze({
    value: "8.8.8.0/24",
    kind: "cidr",
    why:
      `contains the MEASURED guest resolver ${MEASURED_GUEST_RESOLVER} (run ${MEASURED_GUEST_RESOLVER_RUN}, /etc/resolv.conf ` +
      "in both arms). Without it the default-deny half starves name resolution and every row fails for the wrong reason — " +
      "the exact hazard the runbook's §2 stop condition names. It is also the SDK's own documented example entry.",
  }),
  Object.freeze({
    value: "1.1.1.1",
    kind: "ip",
    why:
      "the arm's POSITIVE CONTROL destination: a stable anycast public address that answers HTTPS and needs NO name " +
      "resolution, so it separates `the allowlist permits what it names` from `DNS happens to work`.",
  }),
  // ★★★ THE ALLOW SET IS CIDRs/IPs ONLY — NO HOSTNAME — AND THAT IS THE ONE THING THIS
  // REVISION CHANGED. A prior shape carried a third entry, `example.com` as `kind:"hostname"`,
  // as an unmeasured OBSERVATION. It was not load-bearing, but it was not free either: a
  // hostname in `allowOut` forces E2B's `validateEgressRules` to require `0.0.0.0/0` in
  // `denyOut` AND routes the sandbox through the tcpproxy L7 path, which reproducibly 500s at
  // create ("failed to place") on this tier — so BOTH prior dispatches (§13.7) returned UNRUN
  // and measured NOTHING. Dropping the domain leaves `allowOut = ["8.8.8.0/24","1.1.1.1"]`,
  // which routes down the plain iptables path and can actually place, so the arm finally
  // measures whether egress enforces instead of failing to be created. "Change one thing":
  // the domain is the thing.
]);

/** Just the strings, in declaration order — the shape `allowOut` takes. */
export function allowOutEntries(entries) {
  return (entries ?? []).map((e) => e.value);
}

/**
 * The allowlist arm's target set.
 *
 * ★★★ THE POSITIVE CONTROL IS NOT OPTIONAL HERE, AND IT IS THE REASON THIS ARM CAN MEAN
 * ANYTHING. An allowlist that blocks EVERYTHING is byte-indistinguishable from a broken or
 * dead sandbox: in both, every request fails. Reading "everything failed" as "enforcement
 * works" is the same error as reading a skipped test suite as a passing one. So the arm asks
 * both directions, and a run in which the ALLOWED destination was not reached yields NO
 * verdict on enforcement at all.
 *
 * ★★ AND THE DENIED PUBLIC IP IS A WITHIN-ARM DIFFERENTIAL. `1.1.1.1` (allowed) and
 * `9.9.9.9` (not allowed) are both ordinary anycast public resolvers answering HTTPS from
 * the same sandbox at the same moment. The ONLY thing that differs between them is whether
 * the allowlist names them — which is a tighter control than any cross-sandbox comparison,
 * because no second sandbox has to be assumed identical.
 */
export const ALLOWLIST_HTTP_TARGETS = Object.freeze([
  Object.freeze({
    id: "allow_ip",
    role: "positive_control",
    url: "https://1.1.1.1/",
    why:
      "IN the allowlist, by IP literal, so no name resolution is involved. MUST be REACHED. If it is not, the arm is " +
      "BROKEN and no enforcement verdict may be read from it, however cleanly the denied rows failed.",
  }),
  // ★ THE `allow_host` (`https://example.com/`) TARGET IS GONE ALONG WITH THE HOSTNAME ALLOW
  // ENTRY. With no hostname in `allowOut`, example.com is no longer allowlisted — it would be
  // DENIED — so a target that asserted it as an allowed observation would be measuring the
  // opposite of what its row implied. It was a pure `role:"observation"`, never in the
  // positive-control or denied sets and never consulted by the verdict, so removing it is
  // clean: nothing in the expectation-building or classifier referenced its id.
  Object.freeze({
    id: "deny_metadata",
    role: "question",
    url: `http://${METADATA_V4}/latest/meta-data/`,
    why:
      "THE MEASUREMENT. NOT in the allowlist. Measured REACHED (HTTP 401) under a deny set naming its own range, and " +
      "REACHED in the anti-vacuity arm, so a refusal here is attributable to the allowlist shape.",
  }),
  Object.freeze({
    id: "deny_public_ip",
    role: "question",
    url: "https://9.9.9.9/",
    why:
      "AN ORDINARY PUBLIC DESTINATION, not in the allowlist. Its partner is `allow_ip`: same sandbox, same instant, same " +
      "kind of destination, differing only in whether the allowlist names it. Without this row a refusal of the metadata " +
      "endpoint alone could not tell `default-deny is enforced` from `this one destination is special`.",
  }),
  Object.freeze({
    id: "deny_public_host",
    role: "observation",
    url: "https://registry.npmjs.org/",
    why:
      "a NAME that is not in the allowlist. Its curl exit code separates two very different failures that look alike in a " +
      "summary: exit 6 means the name could not be resolved AT ALL (the resolver entry did not work), while 7 or 28 means " +
      "resolution SUCCEEDED and the connection was denied. Read with `dns_lookup`, never alone.",
  }),
  Object.freeze({
    id: "apparatus",
    role: "apparatus_control",
    url: "https://aoa-w10b-must-not-resolve.invalid/",
    why: "RFC 2606 `.invalid`. Must FAIL. If it is REACHED the arm is not reading the network and nothing may be read.",
  }),
]);

/** The id of the arm's own positive control, named once so no caller can mistype it. */
export const ALLOWLIST_POSITIVE_CONTROL_ID = "allow_ip";

/** The rows whose refusal is what "enforced" would mean. Both must agree, or the arm is mixed. */
export const ALLOWLIST_DENIED_IDS = Object.freeze(["deny_metadata", "deny_public_ip"]);

/**
 * The DNS-resolution row's outcomes.
 *
 * ★ RESOLUTION IS PROBED SEPARATELY FROM EVERY CONNECT, because under a default-deny policy
 * a failure to resolve and a failure to connect produce the same user-visible "it did not
 * work" — and they mean opposite things. A failed resolve means the allowlist did not
 * actually admit the resolver, i.e. the ARM is invalid. A successful resolve followed by a
 * refused connect is precisely the enforcement being measured.
 */
export const DNS_LOOKUP_OUTCOMES = Object.freeze(["resolved", "resolve-failed", "unknown"]);

export function classifyDnsRow(row) {
  const detail = String(row?.detail ?? "");
  if (!row || typeof row.exitCode !== "number") return "unknown";
  if (detail.startsWith("resolved")) return "resolved";
  if (detail.startsWith("resolve-failed")) return "resolve-failed";
  return "unknown";
}

/** The IPv4 literals this arm counts as DENIED, read off the targets rather than retyped. */
export function allowlistDeniedAddresses() {
  return ALLOWLIST_DENIED_IDS.map((id) => {
    const target = ALLOWLIST_HTTP_TARGETS.find((t) => t.id === id);
    return /^https?:\/\/(\d+\.\d+\.\d+\.\d+)(?:[:/]|$)/.exec(String(target?.url ?? ""))?.[1] ?? null;
  }).filter((value) => value !== null);
}

/**
 * Does the MATERIALIZED policy contradict the one this arm asked for? Returns a reason or null.
 *
 * ★★★ A READ-BACK VERIFIES WHAT WAS DECLARED, NOT WHAT IS ENFORCED — that lesson is why this
 * is a DISQUALIFIER and never a confirmation. It can only take the verdict away. The tier
 * stores what it is given (measured: it refused an IPv6 CIDR with a 400 rather than silently
 * dropping it), so a materialized policy that differs from the declared one says the REQUEST
 * was wrong and the sandbox ran some other shape.
 *
 * ★★ AND IT FIRES ONLY ON A POSITIVE CONTRADICTION. `getInfo()`'s `allowOut` shape is
 * UNMEASURED at this tier: it may normalise `1.1.1.1` to `1.1.1.1/32`, reorder the CIDR/IP
 * entries, or carry no network object at all. Reading any of those as a mismatch would spend
 * the operator's single authorised run on formatting — a false BROKEN costs a run, so it is
 * cheap, but not free, and it must not be manufactured. (The allow set is now CIDRs/IPs only;
 * the `entry.kind !== "hostname"` filter below is retained defensively so a future hostname
 * observation could never be treated as load-bearing.)
 */
export function allowlistReadBackProblem({ readBack } = {}) {
  if (!readBack || readBack.ok !== true) return null;
  const network = readBack.network;
  if (network === null || typeof network !== "object") return null;

  const problems = [];
  const denyOut = Array.isArray(network.denyOut) ? network.denyOut.map(String) : null;
  const allowOut = Array.isArray(network.allowOut) ? network.allowOut.map(String) : null;

  if (denyOut !== null && !denyOut.some((entry) => entry.includes(ALL_TRAFFIC_SENTINEL))) {
    problems.push(
      `the materialized denyOut ${JSON.stringify(denyOut)} does not carry the all-traffic sentinel ${ALL_TRAFFIC_SENTINEL}, ` +
        "so the DEFAULT-DENY half of the documented shape is not what ran",
    );
  }
  if (allowOut !== null) {
    // Containment either way, so a normalised spelling is not a contradiction.
    const loadBearing = ALLOWLIST_ALLOW_SET.filter((entry) => entry.kind !== "hostname").map((entry) => entry.value);
    const uncovered = loadBearing.filter((value) => !allowOut.some((got) => got.includes(value) || value.includes(got)));
    if (uncovered.length > 0) {
      problems.push(`the materialized allowOut ${JSON.stringify(allowOut)} does not carry the load-bearing entr${uncovered.length === 1 ? "y" : "ies"} ${uncovered.join(", ")}`);
    }
    const admittedDenied = allowlistDeniedAddresses().filter((address) => allowOut.some((entry) => ipv4InCidr(address, entry)));
    if (admittedDenied.length > 0) {
      problems.push(
        `the materialized allowOut ADMITS ${admittedDenied.join(", ")}, which this arm counts as DENIED — the allowed and ` +
          "denied sets overlap, so nothing that happened to those destinations is attributable to the allowlist shape",
      );
    }
  }
  return problems.length > 0 ? `${problems.join("; ")}.` : null;
}

/** What the read-back is allowed to add to a verdict: confirmation, or a named absence. */
export function allowlistReadBackNote(readBack) {
  if (!readBack || readBack.ok !== true) {
    return (
      `★ The policy read-back could NOT be taken (${String(readBack?.detail ?? "not attempted")}), so this rests on what was ` +
      "REQUESTED at create rather than on what the tier confirmed it stored."
    );
  }
  const network = readBack.network;
  if (network === null || typeof network !== "object") {
    return "★ The read-back carried no network object, so this rests on what was REQUESTED at create rather than on what the tier confirmed it stored.";
  }
  if (!Array.isArray(network.allowOut)) {
    return (
      `★ The read-back carried no allowOut array (network=${JSON.stringify(network)}), so the ALLOWLIST half rests on what ` +
      "was REQUESTED at create rather than on what the tier confirmed it stored."
    );
  }
  return `The read-back does not contradict the request: network=${JSON.stringify(network)}.`;
}

/**
 * The outcome vocabulary for this arm.
 *
 * ★★★ THE UNIT ASKED FOR THREE OUTCOMES AND THIS DECLARES FIVE, DELIBERATELY. Three are the
 * answers — `enforces`, `inert`, `broken`. The other two are NOT answers and are named
 * rather than folded into one of the three, because folding them is the massaging that would
 * make this arm untrustworthy:
 *
 *   enforces — the ALLOWED destination was reached (transfer completed) AND every denied
 *              destination was refused AT OR BEFORE THE TCP CONNECT, with the arm's own
 *              preconditions intact: a live guest, a working apparatus control, name
 *              resolution through a resolver the allow set names, and a read-back that does
 *              not contradict the requested policy.
 *   inert    — denied destinations were REACHED — including reached-then-broken, because a
 *              connection that was established and then failed still proves the packets got
 *              there. The shape declared a policy and routed the traffic anyway, exactly as
 *              the deny-set shape did.
 *   broken   — the experiment did not measure the policy it claims to measure. Three shapes:
 *              the sandbox was ALIVE and reached NOTHING (an allowlist that blocks everything
 *              cannot be distinguished from an enforced one); name resolution was starved or
 *              came through a resolver the allow set does not name (the policy that ran is not
 *              the policy under test); or a row carries an exit code the pack cannot place,
 *              which is NOT a refusal. A legitimate outcome, reported as itself.
 *   mixed    — the denied rows DISAGREED with each other, or the positive control failed
 *              while a denied destination was reached. Neither `enforces` nor `inert` is
 *              true; reporting either would be a claim the rows do not support.
 *   unrun    — the experiment never happened: the arm was not created, the guest could not
 *              run a local command, or a required row — the resolution control included —
 *              produced no line. Distinct from `broken`, where the apparatus worked and the
 *              measurement is the thing that cannot be read.
 *
 * ★★★ AND THE ASYMMETRY THAT DECIDES EVERY TIE BETWEEN THEM: a false BROKEN costs one more
 * run; a false ENFORCES closes a Critical trust crossing on an experiment that did not happen.
 * Where the rows admit both readings, this classifier takes the one that costs a run.
 */
export const ALLOWLIST_OUTCOMES = Object.freeze(["enforces", "inert", "broken", "mixed", "unrun"]);

/** Which of the three the operator asked for, if any, an outcome maps to. */
export const ALLOWLIST_OUTCOME_IS_A_VERDICT = Object.freeze({
  enforces: true,
  inert: true,
  broken: true,
  mixed: false,
  unrun: false,
});

/**
 * Classify the allowlist arm.
 *
 * The order of the guards is the argument. Liveness first, because a dead guest explains
 * every other row; then the apparatus control, because a probe that is not reading the
 * network cannot be read; then the rows themselves.
 *
 * @param {{arm?: object}} input `arm` carries `created`, `detail`, `liveness`, `rows`,
 *   `dnsRow`, `resolvConf` and `readBack`, filled by the keyed file.
 */
export function classifyAllowlistArm({ arm } = {}) {
  const rowOf = (id) => arm?.rows?.[id] ?? null;
  // ★★★ THE SUMMARY ROW STRING READS THROUGH `classifyReachEvidence`, NOT `classifyHttpRow`.
  // `classifyHttpRow` answers "did the transfer complete", and prints "blocked" for a
  // reached-then-broke row (curl 35/56) — the exact transfer-completion reading its own
  // docstring forbids an enforcement claim from resting on. This string sits next to the
  // arm's verdict in the durable record, and a recorder read `deny_public_ip=blocked/curl-35`
  // as "the allowlist blocked public egress" when the row was REACHED-then-broke (INERT). The
  // summary now speaks the enforcement classifier's own vocabulary, so it can never again say
  // "blocked" for a destination that was reached. `no-result` still marks a missing row.
  const shown = ALLOWLIST_HTTP_TARGETS.map((t) => {
    const r = rowOf(t.id);
    return `${t.id}=${classifyReachEvidence(r)}/${blockShape(r)}`;
  }).join(" ");
  const dns = classifyDnsRow(arm?.dnsRow);
  const resolverNote = `dns_lookup=${dns}`;
  const observedResolvers =
    typeof arm?.resolvConf?.text === "string" && arm.resolvConf.ok === true ? parseResolvConf(arm.resolvConf.text) : null;

  const out = (outcome, reason, detail) => ({
    arm: "allowlist",
    outcome,
    reason,
    detail,
    isVerdict: ALLOWLIST_OUTCOME_IS_A_VERDICT[outcome] === true,
    rows: shown,
    dns,
    resolver: { expected: MEASURED_GUEST_RESOLVER, observed: observedResolvers },
  });

  // ── (0) THE ARM MUST EXIST ────────────────────────────────────────────────
  // ★ A create failure IS A RESULT ABOUT THE SHAPE, but WHICH result depends on the status,
  // and this branch must not overstate it. A 4xx is a VALIDATION REFUSAL — the tier does not
  // accept the body (measured precedent: the IPv6 deny arm, `400: invalid denied CIDR
  // ::ffff:0:0/96`). A 5xx is a PLACEMENT FAILURE — the tier accepted the request and could
  // not satisfy it; that is NOT a refusal, however many times it repeats. This branch used to
  // print "the tier refused the ... body" for BOTH, which made a false claim on 2026-09-09
  // when runs 34328502574 / 34328780645 hit a 500 (see the header). Either way it is `unrun`
  // for verdict purposes: NOTHING was measured about enforcement, and UNRUN IS NOT INERT.
  if (arm?.created !== true) {
    const createDetail = String(arm?.detail ?? "no record at all");
    const status = /\b(4\d\d)\b/.test(createDetail)
      ? "refusal"
      : /\b(5\d\d)\b/.test(createDetail)
        ? "server-side"
        : "unknown";
    const reading =
      status === "refusal"
        ? "That is a 4xx: the tier REFUSED the deny-all-plus-allowlist body, i.e. it does not accept the documented shape. " +
          "Record it as a refusal."
        : status === "server-side"
          ? "That is a 5xx: the tier ACCEPTED the request and FAILED TO PLACE the sandbox. That is NOT a refusal and NOT a " +
            "statement about whether the shape is valid — record it as 'fails to place, cause unknown', and check whether the " +
            "sibling arms placed in the same run before calling it anything stronger or weaker than that."
          : "No HTTP status is visible in that detail, so nothing may be inferred about the shape from it at all.";
    return out(
      "unrun",
      "arm-was-never-created",
      `Sandbox.create did not return for the allowlist arm: ${createDetail}. ${reading} ` +
        "It is not an enforcement measurement either way: the sandbox never existed, so UNRUN must never be read as INERT.",
    );
  }

  // ── (1) THE GUEST MUST BE ALIVE, PROVEN WITHOUT THE NETWORK ───────────────
  // ★★★ THIS IS THE GUARD THAT SEPARATES `broken` FROM `unrun`, AND IT IS THE ONE THE UNIT
  // ASKED FOR BY NAME. A local `echo` traverses no egress path. If it does not come back,
  // the sandbox never really started (or the default-deny took its control channel with it)
  // and every network row is explained by that, not by a policy.
  if (arm?.liveness?.ok !== true) {
    return out(
      "unrun",
      "guest-never-answered-a-local-command",
      `the sandbox was created (${String(arm?.sandboxId ?? "no id")}) but a purely LOCAL command produced no line ` +
        `(${String(arm?.liveness?.detail ?? "no detail")}). Nothing about the network may be read: an unreachable ` +
        "destination and an unreachable guest look identical from here.",
    );
  }

  // ── (2) THE PROBE MUST BE READING THE NETWORK ─────────────────────────────
  const apparatus = classifyHttpRow(rowOf("apparatus"));
  if (apparatus === "no-result") {
    return out("unrun", "apparatus-row-missing", `the RFC-2606 .invalid row produced no line at all. ${shown}`);
  }
  if (apparatus === "reached") {
    return out(
      "unrun",
      "apparatus-control-violated",
      `the RFC-2606 .invalid host was REACHED, so this arm is not measuring the network and no row may be read. ${shown}`,
    );
  }

  // ── (3) EVERY LOAD-BEARING ROW MUST HAVE LANDED ───────────────────────────
  const required = [ALLOWLIST_POSITIVE_CONTROL_ID, ...ALLOWLIST_DENIED_IDS];
  const missing = required.filter((id) => classifyHttpRow(rowOf(id)) === "no-result");
  if (missing.length > 0) {
    return out("unrun", "load-bearing-rows-missing", `no result line for ${missing.join(", ")}. ${shown} ${resolverNote}`);
  }

  // ── (3b) ★★★ THE RESOLVER CONTROL IS A PRECONDITION, NOT A POSTSCRIPT ─────
  //
  // ★★★ IT USED TO BE CONSULTED ONLY AFTER THE POSITIVE CONTROL HAD ALREADY FAILED, WHICH
  // MEANT A DNS-STARVED RUN COULD REPORT ENFORCEMENT. The arm's premise is that `allowOut`
  // admits the guest's resolver; the whole reason the arm is runnable at all is that the
  // resolver is a nameable public address. If resolution did not work, the policy that ran is
  // NOT the policy under test — the default-deny half starved the experiment — and the rows it
  // produced are indistinguishable from enforcement. That is an INVALID experiment, and an
  // invalid experiment has no verdict in either direction: never ENFORCES, and never INERT
  // either, because "reached a denied destination" under a policy nobody can describe is a
  // claim about the wrong policy.
  if (arm?.dnsRow == null || dns === "unknown") {
    return out(
      "unrun",
      "dns-control-did-not-run",
      `the resolution control produced no classifiable line (${resolverNote}; usually a template with no python3). It is ` +
        "the row that separates `the allowlist refused this destination` from `the allowlist starved the resolver`, so " +
        `without it neither reading may be taken. ${shown}`,
    );
  }
  if (dns === "resolve-failed") {
    return out(
      "broken",
      "name-resolution-failed-so-the-experiment-was-starved",
      `★ BROKEN, and the cause is named: the guest resolved NO name (${resolverNote}), so the allowlist did not in fact ` +
        `admit the resolver — the arm starved its own experiment. Expected resolver ${MEASURED_GUEST_RESOLVER}; the guest ` +
        `reported ${JSON.stringify(observedResolvers)}. If those differ, the constant is stale and the allow set needs the ` +
        "observed address. NO enforcement verdict in EITHER direction: the policy that ran is not the policy under test, " +
        `and an allowlist that blocks everything is indistinguishable from an enforced one. ${shown}`,
    );
  }
  // Resolution SUCCEEDED — through which resolver? It must be one the allow set names, or the
  // success is either a stale constant or egress to a destination the policy excluded, and
  // the second reading is the OPPOSITE of enforcement. The arm cannot tell them apart, so it
  // takes the outcome that costs a run rather than the one that closes a crossing.
  const allowEntries = allowOutEntries(ALLOWLIST_ALLOW_SET);
  const unallowedResolvers = (observedResolvers ?? []).filter((ns) => !allowEntries.some((entry) => ipv4InCidr(ns, entry) === true));
  if (observedResolvers === null || observedResolvers.length === 0 || unallowedResolvers.length > 0) {
    return out(
      "broken",
      "the-resolver-that-answered-is-not-one-the-allow-set-names",
      `★ BROKEN. Name resolution SUCCEEDED, but the arm cannot attribute it to an allowed resolver: ` +
        `${observedResolvers === null ? `/etc/resolv.conf was unreadable (${String(arm?.resolvConf?.detail ?? "no detail")})` : observedResolvers.length === 0 ? "/etc/resolv.conf named no nameserver at all" : `${unallowedResolvers.join(", ")} is not covered by allowOut ${allowEntries.join(", ")}`}. ` +
        `Either the measured constant ${MEASURED_GUEST_RESOLVER} is stale, or egress to an UNALLOWED destination succeeded — ` +
        `which would be the opposite of enforcement. Both readings forbid a verdict here. ${shown} ${resolverNote}`,
    );
  }

  // ── (3c) THE MATERIALIZED POLICY MUST NOT CONTRADICT THE REQUESTED ONE ────
  // ★ The tier stores what it is given, so a read-back that DIFFERS means the request was
  // wrong and the run measured some other shape. It fires only on a positive contradiction:
  // `getInfo()`'s `allowOut` shape is UNMEASURED at this tier, and treating a normalisation
  // (`1.1.1.1` → `1.1.1.1/32`) or a reordering of the CIDR/IP entries as a mismatch would spend
  // the operator's authorisation on formatting.
  const readBackProblem = allowlistReadBackProblem({ readBack: arm?.readBack });
  if (readBackProblem !== null) {
    return out(
      "broken",
      "the-read-back-contradicts-the-requested-policy",
      `★ BROKEN. ${readBackProblem} The tier stores what it is given, so this says the REQUEST was wrong and the sandbox ` +
        "was not running the documented deny-all-plus-allowlist shape. Whatever the rows show, they are not evidence about " +
        `that shape. ${shown} ${resolverNote}`,
    );
  }

  const positiveEvidence = classifyReachEvidence(rowOf(ALLOWLIST_POSITIVE_CONTROL_ID));
  const positive = positiveEvidence === "reached";
  const evidenceOf = (id) => classifyReachEvidence(rowOf(id));
  // ★★★ POST-CONNECT EVIDENCE IS ADMITTED AGAINST ENFORCEMENT AND NEVER FOR IT. A denied row
  // that reached the destination and then broke at TLS REFUTES enforcement for that target, so
  // it belongs in `deniedReached`. The same code on the POSITIVE CONTROL does not prove the
  // allowlist admitted it — a TLS-terminating interceptor produces exit 35 without the packets
  // leaving — so it does not unlock a verdict. The asymmetry is deliberate: both halves point
  // away from a false ENFORCES, which is the only error here that closes a crossing on nothing.
  const deniedReached = ALLOWLIST_DENIED_IDS.filter((id) => evidenceOf(id) === "reached" || evidenceOf(id) === "reached-then-broke");
  const deniedRefused = ALLOWLIST_DENIED_IDS.filter((id) => evidenceOf(id) === "refused-before-connect");
  const deniedUnreadable = ALLOWLIST_DENIED_IDS.filter((id) => evidenceOf(id) === "indeterminate");

  // ── (4) THE ANSWERS ───────────────────────────────────────────────────────
  if (deniedReached.length === 0 && deniedUnreadable.length > 0) {
    // ★ AN EXIT CODE IN NEITHER BUCKET MUST NOT DEFAULT TO REFUSED. `curl: not found` (127) and
    // a name that never resolved (6) are facts about the template and the resolver; reading
    // either as "the policy refused this destination" is defect 2 with a wider blast radius,
    // because it applies to every code nobody has thought about yet.
    return out(
      "broken",
      "a-denied-row-carries-an-unmodelled-exit-code",
      `★ BROKEN. ${deniedUnreadable.map((id) => `${id}: ${reachEvidenceNote(rowOf(id))}`).join("; ")}. That is NOT evidence of ` +
        "a refusal — it does not say whether the destination was reached — and defaulting it to `refused` is how a run that " +
        "measured the template, or the resolver, would read as a run that measured the policy. Name the code, add it to " +
        `CURL_EXIT_MEANINGS with its phase, and re-run. ${shown} ${resolverNote}`,
    );
  }
  if (positive && deniedReached.length === 0) {
    return out(
      "enforces",
      "allowed-reached-and-every-denied-destination-refused",
      `★ the DOCUMENTED shape ENFORCES at this tier. The allowlisted destination was REACHED (transfer completed) and ` +
        `${deniedRefused.map((id) => `${id} (${blockShape(rowOf(id))}, ${reachEvidenceNote(rowOf(id))})`).join(", ")} ` +
        `${deniedRefused.length === 1 ? "was" : "were"} refused AT OR BEFORE THE TCP CONNECT from the SAME sandbox at the ` +
        `same moment — including an ordinary public address whose only difference from the allowed one is that the ` +
        `allowlist does not name it. Name resolution worked through ${JSON.stringify(observedResolvers)}, which the allow ` +
        `set covers, so the policy that ran is the policy under test. ${allowlistReadBackNote(arm?.readBack)} ` +
        `${shown} ${resolverNote}. This says nothing about DE-08's delivery: nothing in the product passes a network ` +
        "body, and adopting one would be a build with its own design, regression and verification questions.",
    );
  }
  if (deniedReached.length === ALLOWLIST_DENIED_IDS.length) {
    return out(
      "inert",
      "denied-destinations-still-reachable",
      `the DOCUMENTED shape is INERT at this tier too: ${deniedReached.join(", ")} ${deniedReached.length === 1 ? "was" : "were"} ` +
        `REACHED from a sandbox whose policy denied all traffic and allowed only ${allowOutEntries(ALLOWLIST_ALLOW_SET).join(", ")}. ` +
        `Positive control ${positive ? "held" : "did NOT hold, which is noted but does not change this: reaching a destination the policy excluded is decisive on its own"}. ` +
        `${shown} ${resolverNote}`,
    );
  }
  if (deniedReached.length > 0) {
    return out(
      "mixed",
      "the-denied-rows-disagree",
      `NO VERDICT. ${deniedReached.join(", ")} was REACHED while ${deniedRefused.join(", ") || "nothing"} was refused, so the ` +
        "shape neither enforced nor was inert as a whole. Reporting either would be a claim these rows do not support; the " +
        `pattern is the finding. ${shown} ${resolverNote}`,
    );
  }
  // Nothing denied was reached, and the positive control did not hold. Name resolution is
  // already known to have worked through an allowed resolver — guard (3b) would have returned
  // otherwise — so the cause is NOT a starved resolver, and the detail must not offer one.
  return out(
    "broken",
    "nothing-reachable-including-the-allowed-destination",
    `★ BROKEN. The guest was ALIVE (a local command answered) and reached NOTHING — not even ${ALLOWLIST_POSITIVE_CONTROL_ID}, ` +
      `the destination this policy explicitly ALLOWS (${reachEvidenceNote(rowOf(ALLOWLIST_POSITIVE_CONTROL_ID))}). So the arm ` +
      "cannot tell an enforced allowlist from a sandbox with no egress at all, and it reports NO verdict rather than the " +
      `flattering one. ★ Note that a POST-CONNECT failure on this row is deliberately NOT counted as reaching it: it would ` +
      `be enough to refute enforcement for a denied target, and is not enough to establish it for the allowed one. ` +
      `${shown} ${resolverNote}`,
  );
}

/** The arm's headline, formatted so it cannot be skimmed past in the report. */
export function formatAllowlistOutcome(result) {
  const r = result ?? { outcome: "unrun", reason: "no-result-object", detail: "", rows: "", dns: "unknown" };
  const banner = r.isVerdict ? String(r.outcome).toUpperCase() : `${String(r.outcome).toUpperCase()} — NO VERDICT`;
  return `ALLOWLIST ARM (the shape E2B documents): ${banner} — ${r.reason}\n    ${r.detail}`;
}
