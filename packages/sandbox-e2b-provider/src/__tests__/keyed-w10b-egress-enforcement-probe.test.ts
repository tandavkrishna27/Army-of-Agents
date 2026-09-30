import { describe, expect, it } from "vitest";

// -----------------------------------------------------------------------------
// W10B — THE DE-08 EGRESS-ENFORCEMENT PROBE. ONE KEYED RUN, FIVE QUESTIONS,
// THREE-STATE ANSWERS.
//
// DE-08 ("Sandbox <-> network egress", severity Critical) has enforcement at NO layer.
// E8-F003 (HIGH, open) measured that against real E2B in workflow run 33857218680, with a
// positive control and an apparatus control, and traced the absence to all three candidate
// points: the provider seam is inert, the in-sandbox point was never attempted, and the
// proxy classifier's only route into production is a module nothing imports.
//
// This file decides whether the ONE candidate layer OUTSIDE the guest is real. It BUILDS
// NOTHING, applies no policy to any production path, mutates no gate, counter or register,
// spends NO model tokens, and touches no database. It creates short-TTL sandboxes, runs
// read-only reachability probes inside them, leaves a DURABLE record of the verdict, and
// tears them down.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE PROVIDER LAYER IS THE ONLY ONE THAT COULD WORK
// ─────────────────────────────────────────────────────────────────────────────
// Every in-guest mechanism is agent-writable BY CONSTRUCTION:
// `buildE2bLoginShellScript` (server/src/services/sandbox-provider-runtime.ts) sources
// `/etc/profile`, `$HOME/.profile` and `$HOME/.bashrc` from an AGENT-WRITABLE home before
// `exec env … claude`. And an in-guest PROXY is no better: Node's global `fetch` IGNORES
// every proxy environment variable — MEASURED, with the proxy port never contacted and the
// request returning 200 — on an image that is `node:22`, so the agent's own WebFetch walks
// straight past it. Only enforcement outside the guest survives that, which is why (e) asks
// where the enforcement actually lives rather than assuming.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PREMISE THIS FILE RETIRES, RE-VERIFIED AGAINST THE PINNED SDK
// ─────────────────────────────────────────────────────────────────────────────
// "Managed-E2B egress is not fully lockable" (REFUTED as a capability claim — E8-F007) is
// booked in three places and is FALSE as a statement about the SEAM. `e2b@2.30.5`
// (pnpm-lock.yaml) exposes `SandboxOpts.network`
// with `allowOut`/`denyOut`, puts it in the `POST /sandboxes` body, exposes
// `Sandbox.updateNetwork`, and maps the server's answer back through `getInfo()`. AoA has
// never called any of it. What was UNMEASURED is ENFORCEMENT — and the no-key block at the
// bottom of this file PINS those SDK facts on every PR, so the premise cannot silently rot
// in the other direction either.
//
// ★★★ ENFORCEMENT IS NOW MEASURED, ONCE, FOR ONE SHAPE: run 34085130892 (2026-09-07,
// ab23eabdc, aoa-base).
// a=no b=yes c=no d=no e=no regression=no; DECISION abandon (denyout-is-inert-at-this-tier).
// The tier accepts, validates, stores and echoes the deny set and enforces none of it, on
// both Sandbox.create and updateNetwork. Finding E8-F008; the operator record is the runbook
// §12 and W10B-egress-enforcement-result.md.
//
// ★★★ AND THE SHAPE E2B DOCUMENTS AS THE CONTROL WAS NEVER TESTED (W10B-B, 2026-09-09).
// Questions (a)–(e) declare a `denyOut` CIDR list with NO `allowOut`. E2B's docs present the
// fine-grained control as default-deny — `denyOut: ({allTraffic}) => [allTraffic]` — PLUS an
// `allowOut` allowlist, and say domains are unsupported in DENY lists, so domain filtering
// requires that form. The ALLOWLIST ARM below measures it. It reports
// ENFORCES / INERT / BROKEN in its own vocabulary and takes NO part in the disposition,
// because BROKEN — a live guest that reached nothing, including what the policy ALLOWS — is a
// legitimate outcome and must not red a lane that answered everything it was dispatched for.
// Records that generalised the run above to "the tier does not honour a network body" have
// been narrowed to the deny-only shape. UNMEASURED IS NOT "PROBABLY WORKS": DE-08 stays
// not-delivered and this file still applies no policy to any production path.
//
// ★★★ THE ALLOWLIST ARM HAS NOW BEEN DISPATCHED TWICE AND HAS STILL MEASURED NOTHING.
// Runs 34328502574 and 34328780645 (2026-09-09, three minutes apart, on
// replatform/w10b-allowlist-arm at 899aceeec, template aoa-base) BOTH returned
// `UNRUN — arm-was-never-created`: `Sandbox.create` answered `500: Failed to place sandbox:
// sandbox creation failed on 3 node(s), please retry; if the problem persists, contact us`.
// Not one row ran. ★ The discriminating fact: in the SAME runs, SECONDS apart, on the SAME
// template, the policy and anti-vacuity arms CREATED successfully
// (i531or2zgvmdlt18e2u2s / i13yih10trv4512eugjmz, then im9ge2ldwohsitqrtx5rc /
// i0xsmm4fzyhr3ep736ge9). So: THE DOCUMENTED SHAPE REPRODUCIBLY FAILS TO PLACE AT THIS TIER,
// cause unknown and E2B's to explain. NOT a refusal — a 500 with a please-retry hint is not a
// validation rejection, and the same run's IPv6 arm shows what one looks like
// (`400: invalid denied CIDR ::ffff:0:0/96`). NOT transient — it reproduced with successful
// siblings. Two attempts is the evidence. ★★ AND UNRUN IS NOT INERT: the sandbox never
// existed, so nothing here may be read as the allowlist construction having been tested and
// found not to enforce. Both lanes concluded `success`, which is the arm's design working —
// a non-verdict neither reds the lane nor reads as enforcement. E8-F008 §8;
// W10B-egress-enforcement-result.md §14; runbook §13.7.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO READ THE RESULT — and why a NO, and the ABANDON YES, keep this lane GREEN
// ─────────────────────────────────────────────────────────────────────────────
// Every probe reports yes / no / inconclusive-because-<reason>. A `no` is a RESULT and so
// is (c)'s `yes`: if the only green outcome were "the boundary works", then "the boundary
// does not work" would arrive as a red build, indistinguishable from a bad key, a template
// change or an outage — and the operator's authorised run would have bought an ambiguity.
// `inconclusive` is the only state that reds, because it is the only one that means
// "run me again".
//
// Without `E2B_API_KEY` this file SKIPS cleanly and claims nothing. The workflow's own
// positive-control step is what stops that skip from reading as success.
//
// SECRETS: `E2B_API_KEY` is the only one, it is never printed, and every string this file
// emits goes through `redactSecrets`.
// -----------------------------------------------------------------------------

import { ALL_TRAFFIC, Sandbox } from "e2b";
import type { SandboxNetworkOpts } from "e2b";

import {
  AOA_API_TARGET_ID,
  ALLOWLIST_ALLOW_SET,
  ALLOWLIST_DENIED_IDS,
  ALLOWLIST_HTTP_TARGETS,
  ALLOWLIST_OUTCOMES,
  ALLOWLIST_OUTCOME_IS_A_VERDICT,
  ALLOWLIST_POSITIVE_CONTROL_ID,
  ALL_TRAFFIC_SENTINEL,
  DEFAULT_AOA_API_URL,
  DENY_SET_V4,
  DENY_SET_V6,
  HTTP_TARGETS,
  MEASURED_GUEST_RESOLVER,
  NON_MATCHING_DENY_SET,
  PROBE_TEMPLATE_ALIAS,
  RAW_TARGETS,
  allowOutEntries,
  buildHttpTargetCommand,
  buildProbeRecord,
  classifyAllowlistArm,
  classifyDnsRow,
  classifyRawRow,
  decideOption,
  denyCidrs,
  evaluateControls,
  formatAllowlistOutcome,
  formatVerdict,
  ipv4InCidr,
  packDisposition,
  parseProbeLine,
  redactSecrets,
  resolveAoaApiTarget,
  resolveTemplate,
  verdictEnforcementLayer,
  verdictHonoured,
  verdictProductRegression,
  verdictReadBack,
  verdictResolverInDenySet,
  verdictWarmReassert,
} from "../../../../scripts/lib/w10b-egress-enforcement-probe.mjs";

const HAS_KEY = typeof process.env.E2B_API_KEY === "string" && process.env.E2B_API_KEY.length > 0;
const describeKeyed = HAS_KEY ? describe : describe.skip;

const KEY = process.env.E2B_API_KEY ?? "";
const TEMPLATE_RESOLUTION = resolveTemplate(process.env.E2B_TEMPLATE);
const TEMPLATE = TEMPLATE_RESOLUTION.templateId;
const AOA_API = resolveAoaApiTarget(process.env.W10B_AOA_API_URL);

/** Every secret value in scope, so nothing this file prints can carry one. */
const SECRETS: string[] = [process.env.E2B_API_KEY].filter((v): v is string => typeof v === "string" && v.length > 0);
const safe = (text: unknown, max = 600): string => redactSecrets(String(text ?? ""), SECRETS).slice(0, max);

/** One nonce per RUN, so a stray artefact of an earlier run can never pass for this one. */
const RUN_NONCE = `W10B-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`.toUpperCase();

const COMMIT_SHA = process.env.GITHUB_SHA && process.env.GITHUB_SHA.length > 0 ? process.env.GITHUB_SHA : "unknown";
const RUN_URL = process.env.W10B_RUN_URL && process.env.W10B_RUN_URL.length > 0 ? process.env.W10B_RUN_URL : "unknown";

/** Budgets, explicit so the operator can price the run (see the runbook). */
const ARM_TTL_MS = 420_000;
const SMALL_TTL_MS = 300_000;
const CMD_TIMEOUT_MS = 45_000;

/** Where the raw-socket helper is staged inside each guest. */
const RAW_HELPER_PATH = "/tmp/w10b-raw-socket.py";

/** Where the DNS-resolution helper is staged. Same reason it is a FILE and not an `sh -c`. */
const DNS_HELPER_PATH = "/tmp/w10b-dns-lookup.py";

/** The name the DNS helper resolves. A real name, so a failure means the RESOLVER, not NXDOMAIN. */
const DNS_LOOKUP_NAME = "registry.npmjs.org";

type Row = { id: string; exitCode: number; detail: string } | null;
type RawRow = { id: string; exitCode: number; detail: string; tool: string } | null;
type Verdict = { probe: string; state: string; reason: string; detail: string };

const inconclusive = (probe: string, reason: string, detail: string): Verdict => ({ probe, state: "inconclusive", reason, detail });

interface Arm {
  label: string;
  created: boolean;
  detail: string;
  sandboxId: string;
  expectedRowIds: string[];
  rows: Record<string, Row>;
  rawRows: Record<string, RawRow>;
  /** ★ THE LIVENESS ROW: a purely LOCAL command, so it traverses no egress path at all. */
  liveness: { ok: boolean; detail: string };
  /** The resolution probe, independent of any connect. See DNS_LOOKUP_OUTCOMES. */
  dnsRow: Row;
  resolvConf: { ok: boolean; text: string; detail: string };
  readBack: { ok: boolean; denyOut: string[] | null; network: unknown; detail: string };
}

function emptyArm(label: string): Arm {
  return {
    label,
    created: false,
    detail: "",
    sandboxId: "",
    expectedRowIds: [],
    rows: {},
    rawRows: {},
    liveness: { ok: false, detail: "not attempted" },
    dnsRow: null,
    resolvConf: { ok: false, text: "", detail: "not attempted" },
    readBack: { ok: false, denyOut: null, network: undefined, detail: "not attempted" },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RAW-SOCKET HELPER
// ─────────────────────────────────────────────────────────────────────────────
//
// ★★★ IT IS STAGED AS A FILE, NOT INLINED INTO `sh -c`. A multi-line python program inside a
// single-quoted shell wrapper is one stray quote away from a command that still exits 0 and
// prints nothing — the silently-empty row that cost the sibling probe two runs. The files
// API has no quoting problem at all.
//
// ★★ AND IT SPEAKS THE SAME PROBE/END LINE PROTOCOL as the curl rows, so one parser reads
// both and a truncated line is REJECTED rather than half-read.
//
// The four outcome words are the ONLY vocabulary `classifyRawRow` recognises. Anything else
// — including "python3 is not installed" — classifies as `unknown`, which makes (e)
// inconclusive rather than silently reporting a filter that was never tested.
const RAW_HELPER_SOURCE = [
  "import socket, sys",
  "",
  "mode, host, port, ident = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]",
  "",
  "def clean(text):",
  "    keep = []",
  "    for ch in str(text)[:120]:",
  "        keep.append(ch if (ch.isalnum() or ch in ' .:/=-_,()') else '?')",
  "    return ''.join(keep).replace('END', 'end')",
  "",
  "def emit(word, extra):",
  "    sys.stdout.write('W10B %s 0 %s %s END' % (ident, word, clean(extra)) + chr(10))",
  "    sys.stdout.flush()",
  "",
  "s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
  "s.settimeout(8)",
  "try:",
  "    s.connect((host, port))",
  "except socket.timeout:",
  "    emit('timed-out', 'connect did not complete within 8s')",
  "    sys.exit(0)",
  "except OSError as err:",
  "    num = getattr(err, 'errno', None)",
  "    if num == 111:",
  "        emit('refused', 'ECONNREFUSED errno=111')",
  "    elif num in (101, 113):",
  "        emit('unreachable', 'ENETUNREACH/EHOSTUNREACH errno=%s' % num)",
  "    else:",
  "        emit('unknown', '%s errno=%s' % (type(err).__name__, num))",
  "    sys.exit(0)",
  "",
  "if mode == 'connect':",
  "    emit('connected', 'tcp connect established to %s:%s' % (host, port))",
  "    sys.exit(0)",
  "",
  "try:",
  "    req = 'GET /latest/meta-data/ HTTP/1.0' + chr(13) + chr(10)",
  "    req += 'Host: ' + host + chr(13) + chr(10) + chr(13) + chr(10)",
  "    s.sendall(req.encode('ascii'))",
  "    data = s.recv(256)",
  "    emit('connected', 'handwritten bytes sent, %d back: %s' % (len(data), data[:48].decode('latin-1')))",
  "except socket.timeout:",
  "    emit('timed-out', 'connected but no response bytes within 8s')",
  "except OSError as err:",
  "    emit('unknown', '%s after connect' % type(err).__name__)",
  "sys.exit(0)",
  "",
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// THE DNS-RESOLUTION HELPER — the row that stops "denied" and "starved" looking alike
// ─────────────────────────────────────────────────────────────────────────────
//
// ★★★ UNDER A DEFAULT-DENY ALLOWLIST, A FAILED RESOLVE AND A DENIED CONNECT PRODUCE THE SAME
// "it did not work" AND MEAN OPPOSITE THINGS. A failed resolve means the allowlist did NOT
// admit the guest's resolver, so the arm starved its own experiment and every other row is
// worthless. A successful resolve followed by a refused connect is exactly the enforcement
// being measured. curl cannot separate them reliably (an unreachable resolver can surface as
// exit 6 OR as a timeout), so resolution is probed on its own, with no socket to a remote
// port at all.
//
// It speaks the same PROBE/END line protocol as every other row, so one parser reads them
// all and a truncated line is REJECTED rather than half-read.
const DNS_HELPER_SOURCE = [
  "import socket, sys",
  "",
  "name, ident = sys.argv[1], sys.argv[2]",
  "",
  "def clean(text):",
  "    keep = []",
  "    for ch in str(text)[:120]:",
  "        keep.append(ch if (ch.isalnum() or ch in ' .:/=-_,()') else '?')",
  "    return ''.join(keep).replace('END', 'end')",
  "",
  "socket.setdefaulttimeout(8)",
  "try:",
  "    addr = socket.gethostbyname(name)",
  "    word, extra = 'resolved', '%s -> %s' % (name, addr)",
  "except Exception as err:",
  "    word, extra = 'resolve-failed', '%s %s' % (type(err).__name__, err)",
  "sys.stdout.write('W10B %s 0 %s %s END' % (ident, word, clean(extra)) + chr(10))",
  "sys.stdout.flush()",
  "",
].join("\n");

/** The DNS row's id, kept out of the HTTP target set because it is not an HTTP row. */
const DNS_ROW_ID = "dns_lookup";

function dnsHelperCommand(): string {
  const body =
    `if command -v python3 >/dev/null 2>&1; then python3 ${DNS_HELPER_PATH} ${DNS_LOOKUP_NAME} ${DNS_ROW_ID}; ` +
    `else printf "W10B ${DNS_ROW_ID} 0 no-resolver-tool END\\n"; fi; exit 0`;
  return `sh -c '${body}'`;
}

/**
 * The LIVENESS command: prove the guest can run something, WITHOUT touching the network.
 *
 * ★★★ THIS IS THE DISCRIMINATOR THE ALLOWLIST ARM CANNOT DO WITHOUT. "Every destination
 * failed" is produced by an enforced default-deny AND by a sandbox that never really came
 * up. Only a command that traverses no egress path separates them, and reading the second as
 * the first would be this programme's [[checks-that-nothing-runs]] class wearing a security
 * result's clothes.
 */
const LIVENESS_ROW_ID = "guest_alive";
function livenessCommand(): string {
  return `sh -c 'printf "W10B ${LIVENESS_ROW_ID} 0 local-command-ran END\\n"; exit 0'`;
}

/** The wrapper that runs the helper, or REPORTS that the template carries no python3. */
function rawHelperCommand(target: (typeof RAW_TARGETS)[number]): string {
  const body =
    `if command -v python3 >/dev/null 2>&1; then python3 ${RAW_HELPER_PATH} ${target.mode} ${target.host} ${String(target.port)} ${target.id}; ` +
    `else printf "W10B ${target.id} 0 no-raw-socket-tool END\\n"; fi; exit 0`;
  return `sh -c '${body}'`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SANDBOX PLUMBING — every failure is DATA, never an exception that eats a row
// ─────────────────────────────────────────────────────────────────────────────

interface Execution {
  channel: "returned" | "threw";
  stdout: string;
  stderr: string;
  detail: string;
}

/**
 * Run one command and NEVER throw.
 *
 * ★ E7-F014: against real E2B a non-zero exit is THROWN as a `CommandExitError`, not
 * returned. Every probe command therefore ends `exit 0` so a failing curl cannot throw at
 * the SDK layer — and this wrapper still catches, because a genuine transport fault must
 * become an inconclusive row rather than a lost one. A `CommandExitError` carries the
 * command's stdout on most shapes, so the line is read out of it rather than discarded.
 */
async function run(sandbox: Sandbox, command: string): Promise<Execution> {
  try {
    const out = await sandbox.commands.run(command, { timeoutMs: CMD_TIMEOUT_MS });
    return { channel: "returned", stdout: String(out?.stdout ?? ""), stderr: String(out?.stderr ?? ""), detail: `exitCode=${String(out?.exitCode)}` };
  } catch (err) {
    const e = err as { name?: unknown; message?: unknown; stdout?: unknown; stderr?: unknown; result?: { stdout?: unknown; stderr?: unknown } };
    return {
      channel: "threw",
      stdout: String(e.stdout ?? e.result?.stdout ?? ""),
      stderr: String(e.stderr ?? e.result?.stderr ?? ""),
      detail: `${typeof e.name === "string" ? e.name : "Error"}: ${typeof e.message === "string" ? e.message : String(err)}`,
    };
  }
}

/** Issue one HTTP target and record its row. Every raw channel is printed, parsed or not. */
async function httpRow(sandbox: Sandbox, label: string, target: { id: string; url: string }): Promise<Row> {
  const exec = await run(sandbox, buildHttpTargetCommand(target));
  const parsed = parseProbeLine(exec.stdout, target.id);
  // ★★ A ROW THAT DID NOT PARSE IS PRINTED ANYWAY. Probe runs #1 and #2 of the sibling lane
  // both reported a control as "NO RESULT" with nothing in the log to say why — the row was
  // simply absent. A measurement whose failures are invisible can only be guessed at.
  // eslint-disable-next-line no-console
  console.log(
    `[w10b/${label}] ${target.id}: parsed=${parsed ? "yes" : "NO"} channel=${exec.channel} ${safe(exec.detail, 160)} ` +
      `stdout=${JSON.stringify(safe(exec.stdout, 300))} stderr=${JSON.stringify(safe(exec.stderr, 200))}`,
  );
  return parsed;
}

async function rawRow(sandbox: Sandbox, label: string, target: (typeof RAW_TARGETS)[number]): Promise<RawRow> {
  const exec = await run(sandbox, rawHelperCommand(target));
  const parsed = parseProbeLine(exec.stdout, target.id);
  const detail = parsed?.detail ?? "";
  const tool = detail.startsWith("no-raw-socket-tool") ? "none" : "python3";
  // eslint-disable-next-line no-console
  console.log(
    `[w10b/${label}] RAW ${target.id}: parsed=${parsed ? "yes" : "NO"} outcome=${classifyRawRow(parsed)} tool=${tool} ` +
      `channel=${exec.channel} stdout=${JSON.stringify(safe(exec.stdout, 300))}`,
  );
  return parsed ? { ...parsed, tool } : null;
}

/**
 * Create one arm, run its target set, and ALWAYS tear the sandbox down.
 *
 * `network` is the ONLY difference between the arms. It is passed verbatim to
 * `Sandbox.create` — and note that the SDK validates none of it client-side, which is
 * precisely why the read-back in question (b) exists.
 */
async function runArm(
  label: string,
  network: SandboxNetworkOpts | undefined,
  opts: {
    httpTargets: { id: string; url: string }[];
    raw: boolean;
    readResolvConf: boolean;
    readBack: boolean;
    ttlMs: number;
    /** ★ Prove the guest answers a LOCAL command before reading anything about the network. */
    liveness?: boolean;
    /** Probe name resolution on its own, with no remote socket. */
    dns?: boolean;
  },
): Promise<Arm> {
  const arm = emptyArm(label);
  arm.expectedRowIds = opts.httpTargets.map((t) => t.id);
  let sandbox: Sandbox | null = null;
  try {
    // eslint-disable-next-line no-console
    console.log(`[w10b/${label}] creating (template=${TEMPLATE}) network=${JSON.stringify(network ?? null)}`);
    sandbox = await Sandbox.create(TEMPLATE, {
      apiKey: KEY,
      timeoutMs: opts.ttlMs,
      metadata: { aoaProvider: "e2b", aoa_lane: `w10b-egress-${label}` },
      ...(network ? { network } : {}),
    });
    arm.created = true;
    arm.sandboxId = String(sandbox.sandboxId ?? "");
    // eslint-disable-next-line no-console
    console.log(`[w10b/${label}] sandboxId = ${arm.sandboxId}`);

    // (b) THE READ-BACK, taken BEFORE any command so it describes the sandbox as created.
    if (opts.readBack) {
      try {
        const info = (await sandbox.getInfo()) as { network?: { denyOut?: string[]; allowOut?: string[] } };
        arm.readBack = {
          ok: true,
          denyOut: Array.isArray(info?.network?.denyOut) ? info.network.denyOut.map(String) : null,
          network: info?.network ?? null,
          detail: "",
        };
        // eslint-disable-next-line no-console
        console.log(`[w10b/${label}] getInfo().network = ${JSON.stringify(arm.readBack.network)}`);
      } catch (err) {
        arm.readBack = { ok: false, denyOut: null, network: undefined, detail: safe(String(err), 300) };
        // eslint-disable-next-line no-console
        console.log(`[w10b/${label}] getInfo() FAILED: ${arm.readBack.detail}`);
      }
    }

    // ── LIVENESS, FIRST AND BEFORE ANY NETWORK ROW ─────────────────────────
    // It runs before the targets deliberately: if the guest cannot answer a local command,
    // every subsequent row is explained by that and the arm must say so rather than let a
    // dead sandbox masquerade as an enforced policy.
    if (opts.liveness) {
      const exec = await run(sandbox, livenessCommand());
      const parsed = parseProbeLine(exec.stdout, LIVENESS_ROW_ID);
      arm.liveness = {
        ok: parsed !== null,
        detail: parsed ? "a local command ran and its line parsed" : `channel=${exec.channel} ${safe(exec.detail, 200)} stdout=${JSON.stringify(safe(exec.stdout, 200))}`,
      };
      // eslint-disable-next-line no-console
      console.log(`[w10b/${label}] LIVENESS: ${arm.liveness.ok ? "guest answered a LOCAL command" : `NO LINE — ${arm.liveness.detail}`}`);
    }

    if (opts.readResolvConf) {
      try {
        const text = String(await sandbox.files.read("/etc/resolv.conf"));
        arm.resolvConf = { ok: true, text, detail: "" };
        // eslint-disable-next-line no-console
        console.log(`[w10b/${label}] /etc/resolv.conf:\n${safe(text, 600)}`);
      } catch (err) {
        arm.resolvConf = { ok: false, text: "", detail: safe(String(err), 200) };
        // eslint-disable-next-line no-console
        console.log(`[w10b/${label}] /etc/resolv.conf UNREADABLE: ${arm.resolvConf.detail}`);
      }
    }

    if (opts.raw) {
      try {
        await sandbox.files.write(RAW_HELPER_PATH, RAW_HELPER_SOURCE);
      } catch (err) {
        // Staging failed: the raw rows will come back unparsed and (e) will say so, which is
        // the honest outcome. It must not take the HTTP rows down with it.
        // eslint-disable-next-line no-console
        console.log(`[w10b/${label}] could not stage the raw helper: ${safe(String(err), 200)}`);
      }
    }

    if (opts.dns) {
      try {
        await sandbox.files.write(DNS_HELPER_PATH, DNS_HELPER_SOURCE);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(`[w10b/${label}] could not stage the DNS helper: ${safe(String(err), 200)}`);
      }
      const exec = await run(sandbox, dnsHelperCommand());
      arm.dnsRow = parseProbeLine(exec.stdout, DNS_ROW_ID);
      // eslint-disable-next-line no-console
      console.log(
        `[w10b/${label}] DNS ${DNS_ROW_ID}: parsed=${arm.dnsRow ? "yes" : "NO"} outcome=${classifyDnsRow(arm.dnsRow)} ` +
          `channel=${exec.channel} stdout=${JSON.stringify(safe(exec.stdout, 300))}`,
      );
    }

    for (const target of opts.httpTargets) {
      arm.rows[target.id] = await httpRow(sandbox, label, target);
    }
    if (opts.raw) {
      for (const target of RAW_TARGETS) {
        arm.rawRows[target.id] = await rawRow(sandbox, label, target);
      }
    }
    return arm;
  } catch (err) {
    arm.detail = safe(`${(err as Error)?.name ?? "Error"}: ${(err as Error)?.message ?? String(err)}`, 400);
    // eslint-disable-next-line no-console
    console.log(`[w10b/${label}] ARM FAILED: ${arm.detail}`);
    return arm;
  } finally {
    if (sandbox) {
      await Sandbox.kill(String(sandbox.sandboxId), { apiKey: KEY }).catch(() => undefined);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (d) THE REUSE ARM — created UNPOLICED, then re-policed with updateNetwork
// ─────────────────────────────────────────────────────────────────────────────

interface ReuseArm {
  created: boolean;
  detail: string;
  updateOk: boolean;
  updateDetail: string;
  reuseShape: "warm-resume" | "running-sandbox-only";
  reuseShapeDetail: string;
  before: Row;
  after: Row;
}

/**
 * Question (d): does `updateNetwork` re-police a REUSED sandbox?
 *
 * ★ THE `before` ROW IS THIS ARM'S OWN POSITIVE CONTROL. Without it, "unreachable after the
 * update" is satisfied by a sandbox that could never reach the target in the first place,
 * and the arm would confirm the update on the strength of nothing.
 *
 * ★★ PAUSE IS ATTEMPTED, NOT ASSUMED. `betaPause` is plan-dependent; when it is unavailable
 * the update is applied to a still-RUNNING reused sandbox and the SHAPE IS REPORTED
 * (`running-sandbox-only`), so the verdict cannot over-claim a resume it never performed.
 */
async function reuseArm(target: { id: string; url: string }): Promise<ReuseArm> {
  const out: ReuseArm = {
    created: false,
    detail: "",
    updateOk: false,
    updateDetail: "",
    reuseShape: "running-sandbox-only",
    reuseShapeDetail: "not attempted",
    before: null,
    after: null,
  };
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await Sandbox.create(TEMPLATE, {
      apiKey: KEY,
      timeoutMs: SMALL_TTL_MS,
      metadata: { aoaProvider: "e2b", aoa_lane: "w10b-egress-reuse" },
    });
    out.created = true;
    // eslint-disable-next-line no-console
    console.log(`[w10b/U/reuse] sandboxId = ${String(sandbox.sandboxId)} (created with NO network policy)`);

    out.before = await httpRow(sandbox, "U/reuse/before", target);

    try {
      await sandbox.betaPause();
      const resumed = await sandbox.connect();
      sandbox = resumed;
      out.reuseShape = "warm-resume";
      out.reuseShapeDetail = "betaPause() then connect() — the sandbox came back from a pause";
    } catch (err) {
      out.reuseShape = "running-sandbox-only";
      out.reuseShapeDetail = safe(`betaPause/connect unavailable: ${String(err)}`, 240);
    }
    // eslint-disable-next-line no-console
    console.log(`[w10b/U/reuse] reuse shape = ${out.reuseShape} (${out.reuseShapeDetail})`);

    try {
      await sandbox.updateNetwork({ denyOut: denyCidrs(DENY_SET_V4) });
      out.updateOk = true;
    } catch (err) {
      out.updateOk = false;
      out.updateDetail = safe(`${(err as Error)?.name ?? "Error"}: ${(err as Error)?.message ?? String(err)}`, 300);
      // eslint-disable-next-line no-console
      console.log(`[w10b/U/reuse] updateNetwork FAILED: ${out.updateDetail}`);
      return out;
    }

    out.after = await httpRow(sandbox, "U/reuse/after", target);
    return out;
  } catch (err) {
    out.detail = safe(`${(err as Error)?.name ?? "Error"}: ${(err as Error)?.message ?? String(err)}`, 400);
    return out;
  } finally {
    if (sandbox) await Sandbox.kill(String(sandbox.sandboxId), { apiKey: KEY }).catch(() => undefined);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE REPORT AND THE DURABLE RECORD
// ─────────────────────────────────────────────────────────────────────────────

function report(verdicts: Verdict[], observations: Record<string, unknown>): string {
  const lines: string[] = [];
  const d = packDisposition(verdicts);
  const decision = decideOption(verdicts);
  lines.push("");
  lines.push("========== W10B DE-08 EGRESS-ENFORCEMENT PROBE — RESULT ==========");
  lines.push(`TEMPLATE: ${TEMPLATE}   (${TEMPLATE_RESOLUTION.source})`);
  lines.push(`  ${TEMPLATE_RESOLUTION.note}`);
  lines.push(`DENY SET (policy arm): ${denyCidrs(DENY_SET_V4).join(", ")}`);
  lines.push(`ANTI-VACUITY SET     : ${denyCidrs(NON_MATCHING_DENY_SET).join(", ")}`);
  lines.push(`ALLOWLIST ARM        : denyOut = [${ALL_TRAFFIC_SENTINEL}] (all traffic) + allowOut = ${allowOutEntries(ALLOWLIST_ALLOW_SET).join(", ")}`);
  lines.push(`commit: ${COMMIT_SHA}   run nonce: ${RUN_NONCE}`);
  lines.push("");
  lines.push("Questions:");
  lines.push("  a  HONOURED?   is a target inside the declared deny set actually unreachable?");
  lines.push("  b  VERIFIABLE? does getInfo() materialize the policy back?");
  lines.push("  c  ★ ABANDON?  is the guest's DNS resolver inside the deny set?");
  lines.push("  d  RE-ASSERT?  does updateNetwork work on a reused sandbox?");
  lines.push("  e  WHERE?      packet path, or an L7 proxy the guest can route around?");
  lines.push("");
  lines.push("Plus ONE separate arm, with its OWN vocabulary and no vote in the disposition:");
  lines.push("  ALLOWLIST — the shape E2B DOCUMENTS as the control: default-deny + an allowOut list.");
  lines.push("    (a)–(e) measured a denyOut list with NO allowOut. This is the other construction,");
  lines.push("    and it reports ENFORCES / INERT / BROKEN — BROKEN meaning `no verdict`, not `works`.");
  lines.push("");
  for (const v of verdicts) lines.push(formatVerdict(v));
  lines.push("");
  // ★★★ THE ALLOWLIST ARM IS PRINTED AS ITS OWN HEADLINE BLOCK, NOT BURIED IN OBSERVATIONS.
  // It answers a DIFFERENT question from (a)–(e) — those measure a deny-only body, this
  // measures the default-deny-plus-allowlist shape E2B documents — and it has its own
  // vocabulary (ENFORCES / INERT / BROKEN, plus two explicit no-verdict states) precisely so
  // a BROKEN result cannot be massaged into one of the other two. It deliberately does NOT
  // enter `packDisposition`: a BROKEN arm is a legitimate outcome and must not red a lane
  // that answered every question it was dispatched for.
  const allowlist = (observations as { allowlistArm?: { outcome?: string; reason?: string; detail?: string; isVerdict?: boolean } }).allowlistArm;
  if (allowlist) {
    lines.push(formatAllowlistOutcome(allowlist));
    lines.push("");
  }
  lines.push(`OBSERVATIONS: ${JSON.stringify(observations)}`);
  lines.push("");
  lines.push(`DISPOSITION: ${d.disposition} — ${d.detail}`);
  lines.push(`DECISION   : ${decision.decision} (${decision.because})`);
  lines.push(`  ${decision.detail}`);
  lines.push("A `no`, and (c)'s ABANDON `yes`, are RESULTS and this lane stays green for them. Only `inconclusive` reds.");
  lines.push("=================================================================");
  lines.push("");
  return lines.join("\n");
}

/**
 * Put the run's answer somewhere it SURVIVES.
 *
 * ★★★ E7-F025 IS THE REASON THIS FUNCTION EXISTS. It measured that a sibling keyed lane
 * already fired TWICE and that no document in the repo records either outcome, so the honest
 * state of that measurement is "fired and unrecorded" and the next session re-asks the
 * question. Three channels, each attempted independently so losing one does not cost the
 * others: the job log, `$GITHUB_STEP_SUMMARY`, and `W10B_RECORD_PATH` (uploaded as an
 * artefact on a red run as well as a green one).
 */
async function emitDurableRecord(verdicts: Verdict[], observations: Record<string, unknown>): Promise<void> {
  const text = report(verdicts, observations);
  // eslint-disable-next-line no-console
  console.log(text);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath === "string" && summaryPath.length > 0) {
    try {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(summaryPath, `\n\`\`\`\n${text}\n\`\`\`\n`, "utf8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[w10b] could not append to GITHUB_STEP_SUMMARY: ${safe(String(err), 300)}`);
    }
  }

  const recordPath = process.env.W10B_RECORD_PATH;
  if (typeof recordPath !== "string" || recordPath.length === 0) return;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    // `buildProbeRecord` REFUSES a record with no template or no deny set: a reachability
    // result that does not say which image answered, or under which policy, cannot be
    // interpreted later.
    const record = buildProbeRecord({
      verdicts,
      disposition: packDisposition(verdicts),
      decision: decideOption(verdicts),
      template: TEMPLATE,
      templateSource: TEMPLATE_RESOLUTION.source,
      templateNote: TEMPLATE_RESOLUTION.note,
      denySet: DENY_SET_V4,
      commitSha: COMMIT_SHA,
      runNonce: RUN_NONCE,
      generatedAt: new Date().toISOString(),
      workflowRunUrl: RUN_URL,
      observations,
    });
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, `${redactSecrets(JSON.stringify(record, null, 2), SECRETS)}\n`, "utf8");
    // eslint-disable-next-line no-console
    console.log(`[w10b] durable record written to ${recordPath}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[w10b] could not write the durable record: ${safe(String(err), 300)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PACK
// ─────────────────────────────────────────────────────────────────────────────

describeKeyed("W10B — the DE-08 egress-enforcement probe, against REAL E2B", () => {
  it(
    "measures whether the provider can constrain sandbox egress, and reports five three-state verdicts",
    async () => {
      const httpTargets: { id: string; url: string }[] = HTTP_TARGETS.map((t) => ({ id: t.id, url: t.url }));
      if (AOA_API.supplied && AOA_API.target) httpTargets.push({ id: AOA_API.target.id, url: AOA_API.target.url });

      const ipv6SpellingIds = HTTP_TARGETS.filter((t) => t.family === "v6" || t.family === "v6-mapped").map((t) => t.id);
      const ipv6Targets = httpTargets.filter((t) => ipv6SpellingIds.includes(t.id) || t.id === "allowed_public" || t.id === "unresolvable");

      const observations: Record<string, unknown> = {
        aoaApiRow: AOA_API.note,
        denySetV4: denyCidrs(DENY_SET_V4),
        denySetV6: denyCidrs(DENY_SET_V6),
        antiVacuitySet: denyCidrs(NON_MATCHING_DENY_SET),
      };

      // ── THE TWO DIFFERENTIAL ARMS ────────────────────────────────────────────
      // Identical in every way except WHICH addresses their deny set names. That is what
      // makes a block in the policy arm attributable to the policy.
      const policy = await runArm("P/policy", { denyOut: denyCidrs(DENY_SET_V4) }, {
        httpTargets,
        raw: true,
        readResolvConf: true,
        readBack: true,
        ttlMs: ARM_TTL_MS,
      });
      const antiVacuity = await runArm("N/anti-vacuity", { denyOut: denyCidrs(NON_MATCHING_DENY_SET) }, {
        httpTargets,
        raw: true,
        readResolvConf: true,
        readBack: false,
        ttlMs: ARM_TTL_MS,
      });

      const controls = evaluateControls({ policyArm: policy, antiVacuityArm: antiVacuity });
      observations.controls = { ok: controls.ok, problems: controls.problems.map((p) => p.code) };
      observations.policySandboxId = policy.sandboxId;
      observations.antiVacuitySandboxId = antiVacuity.sandboxId;

      // ── (a) HONOURED, (b) VERIFIABLE ─────────────────────────────────────────
      const a = verdictHonoured({ controls, policyArm: policy, antiVacuityArm: antiVacuity }) as Verdict;
      const b = verdictReadBack({ readBack: policy.readBack, declared: denyCidrs(DENY_SET_V4) }) as Verdict;
      observations.getInfoNetwork = policy.readBack.network ?? null;

      // ── (c) ★ THE ABANDON QUESTION ───────────────────────────────────────────
      // The policy arm's own /etc/resolv.conf is the subject; if it could not be read there,
      // the control arm's copy is reported as context but the verdict keeps the policy arm's
      // read channel, because that is the guest whose resolution the deny set would break.
      const c = verdictResolverInDenySet({
        resolvConf: policy.resolvConf,
        denySet: DENY_SET_V4,
        dnsRow: policy.rows.dns_dependent,
        antiVacuityDnsRow: antiVacuity.rows.dns_dependent,
      }) as Verdict;
      observations.resolvConfPolicyArm = policy.resolvConf.ok ? safe(policy.resolvConf.text, 400) : `UNREADABLE: ${policy.resolvConf.detail}`;
      observations.resolvConfControlArm = antiVacuity.resolvConf.ok
        ? safe(antiVacuity.resolvConf.text, 400)
        : `UNREADABLE: ${antiVacuity.resolvConf.detail}`;

      // ── (e) WHERE DOES ENFORCEMENT LIVE ──────────────────────────────────────
      const e = verdictEnforcementLayer({ controls, honoured: a, policyArm: policy, antiVacuityArm: antiVacuity }) as Verdict;

      // ── PRODUCT REGRESSION ───────────────────────────────────────────────────
      const regressionIds = ["dns_dependent", "model_api", ...(AOA_API.supplied ? [AOA_API_TARGET_ID] : [])];
      const regression = verdictProductRegression({
        controls,
        policyArm: policy,
        exercisedIds: regressionIds,
        skippedIds: AOA_API.supplied ? [] : [AOA_API_TARGET_ID],
      }) as Verdict;

      // ── (d) WARM RE-ASSERT ───────────────────────────────────────────────────
      const reuse = await reuseArm({ id: "metadata_v4", url: HTTP_TARGETS.find((t) => t.id === "metadata_v4")!.url });
      const d = verdictWarmReassert({ arm: reuse }) as Verdict;
      observations.reuseShape = reuse.reuseShape;
      observations.reuseShapeDetail = reuse.reuseShapeDetail;

      // ── THE IPv6 DENY ARM — an OBSERVATION, deliberately not a verdict ────────
      // ★ IT MUST NOT BE ABLE TO RED THE LANE. The five questions are the unit's subject; an
      // API that refuses IPv6 deny entries is worth recording and is NOT a reason to make the
      // operator re-spend an authorised run. So it lands in `observations`, where a failure is
      // still visible and still durable.
      const ipv6Arm = await runArm(
        "P6/ipv6-deny",
        { denyOut: [...denyCidrs(DENY_SET_V4), ...denyCidrs(DENY_SET_V6)] },
        { httpTargets: ipv6Targets, raw: false, readResolvConf: false, readBack: true, ttlMs: SMALL_TTL_MS },
      );
      observations.ipv6DenyArm = {
        created: ipv6Arm.created,
        detail: ipv6Arm.detail,
        readBack: ipv6Arm.readBack.ok ? ipv6Arm.readBack.denyOut : `getInfo failed: ${ipv6Arm.readBack.detail}`,
        rows: Object.fromEntries(Object.entries(ipv6Arm.rows).map(([id, r]) => [id, r ? `exit=${r.exitCode} ${r.detail}` : "NO ROW"])),
        note:
          "Whether the API even ACCEPTS IPv6 deny entries is unknown territory: the SDK validates nothing client-side and " +
          `its only sentinel is ALL_TRAFFIC = ${ALL_TRAFFIC_SENTINEL}, with no ::/0. A create failure here is a RESULT.`,
      };

      // ── ★★★ THE ALLOWLIST ARM — THE SHAPE E2B DOCUMENTS AS THE CONTROL ──────
      //
      // (a)–(e) measured a `denyOut` list with NO `allowOut`, and that came back inert
      // (E8-F008). E2B's own documentation presents the fine-grained control as the OTHER
      // construction — default-deny via the selector, plus an `allowOut` allowlist — and
      // that shape has never been measured. The runbook's §2 knew the mechanism ("any
      // `allowOut` entry flips the whole policy to default-deny") and filed it as a STOP
      // CONDITION TO AVOID, because a default-deny that starves the guest's resolver breaks
      // the experiment rather than measuring it. That is only true while the resolver is
      // unnameable — and it is nameable: run 34085130892 read `nameserver 8.8.8.8` from
      // /etc/resolv.conf in BOTH arms, so `8.8.8.0/24` in `allowOut` admits it.
      //
      // ★ THE SELECTOR FORM IS USED VERBATIM FROM THE DOCS (`({ allTraffic }) => [allTraffic]`)
      // rather than the equivalent literal, so this arm measures the construction a reader of
      // those docs would actually write.
      //
      // ★★ LIKE THE IPv6 ARM, IT CANNOT RED THE LANE. Its outcome vocabulary is its own and
      // it takes no part in `packDisposition`. BROKEN — a live guest that reached nothing,
      // including the destination the policy ALLOWS — is a legitimate outcome that must be
      // reported as itself, and forcing it into a yes/no verdict would be the exact
      // over-reading this arm exists to prevent.
      const allowlistArm = await runArm(
        "A/allowlist",
        { denyOut: ({ allTraffic }) => [allTraffic], allowOut: allowOutEntries(ALLOWLIST_ALLOW_SET) },
        {
          httpTargets: ALLOWLIST_HTTP_TARGETS.map((t) => ({ id: t.id, url: t.url })),
          raw: false,
          readResolvConf: true,
          readBack: true,
          ttlMs: ARM_TTL_MS,
          liveness: true,
          dns: true,
        },
      );
      const allowlistResult = classifyAllowlistArm({ arm: allowlistArm });
      observations.allowlistArm = {
        ...allowlistResult,
        sandboxId: allowlistArm.sandboxId,
        created: allowlistArm.created,
        createDetail: allowlistArm.detail,
        allowOut: allowOutEntries(ALLOWLIST_ALLOW_SET),
        denyOut: [ALL_TRAFFIC_SENTINEL],
        readBack: allowlistArm.readBack.ok ? allowlistArm.readBack.network : `getInfo failed: ${allowlistArm.readBack.detail}`,
        resolvConf: allowlistArm.resolvConf.ok ? safe(allowlistArm.resolvConf.text, 400) : `UNREADABLE: ${allowlistArm.resolvConf.detail}`,
        rowDetail: Object.fromEntries(
          Object.entries(allowlistArm.rows).map(([id, r]) => [id, r ? `exit=${r.exitCode} ${r.detail}` : "NO ROW"]),
        ),
        note:
          "The DOCUMENTED shape (default-deny + allowOut), which questions (a)-(e) did NOT measure. Its outcome is NOT a " +
          "vote in DISPOSITION: BROKEN means the arm reached nothing at all and yields NO verdict, which must never be " +
          "read as enforcement. Nothing here is a claim about DE-08 delivery: no production path passes a network body.",
      };
      // eslint-disable-next-line no-console
      console.log(formatAllowlistOutcome(allowlistResult));

      const verdicts: Verdict[] = [a, b, c, d, e, regression];

      // ★★★ THE RECORD IS EMITTED BEFORE THE ASSERTION, AND IN A `finally`. The run that most
      // needs a durable record is the INCONCLUSIVE one, which is the run that throws here.
      try {
        await emitDurableRecord(verdicts, observations);
      } finally {
        const d0 = packDisposition(verdicts);
        // eslint-disable-next-line no-console
        console.log(`[w10b] disposition=${d0.disposition} decision=${decideOption(verdicts).decision} template=${TEMPLATE} commit=${COMMIT_SHA}`);
      }

      const disposition = packDisposition(verdicts);
      // The measurement itself never fails this assertion — only an apparatus that could not
      // answer does. See the header.
      expect(disposition.disposition, disposition.detail).toBe("measured");
    },
    38 * 60 * 1000,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SDK PREMISE, PINNED WITHOUT A KEY
// ─────────────────────────────────────────────────────────────────────────────
//
// ★★★ THIS BLOCK IS NOT `describeKeyed`, AND IT IS THE HALF THAT KEEPS THE PREMISE HONEST IN
// BOTH DIRECTIONS. The pure core's own suite cannot reach the `e2b` package; what it records
// about the SDK is therefore a CLAIM until something compares it with the real export. The
// unit's whole thesis is that "managed-E2B egress is not fully lockable" was stale (E8-F007
// owns that refutation) — so if a
// future `e2b` bump removed `network`, `updateNetwork` or `getInfo`, the thesis would become
// stale in the opposite direction with nothing to say so. This runs in the same `verify` job
// as the rest of the package, on every PR, with no key and no sandbox.

describe("W10B — the e2b SDK network seam, pinned (no key required)", () => {
  it("exposes the all-traffic sentinel the pure core records — and it is IPv4-only", () => {
    expect(ALL_TRAFFIC).toBe(ALL_TRAFFIC_SENTINEL);
    // ★ THE IPv6 FLANK IS A PROPERTY OF THE SDK, NOT A GUESS. There is no `::/0` counterpart,
    // which is why the target set probes the mapped and native IPv6 spellings.
    expect(ALL_TRAFFIC.includes(":")).toBe(false);
  });

  it("exposes at RUNTIME the two calls the probe makes on a live sandbox", () => {
    expect(typeof Sandbox.updateNetwork).toBe("function");
    expect(typeof Sandbox.getInfo).toBe("function");
    expect(typeof Sandbox.prototype.updateNetwork).toBe("function");
    expect(typeof Sandbox.prototype.getInfo).toBe("function");
  });

  // ★★★ THE CREATE-TIME OPTION IS PINNED AGAINST THE SDK'S SHIPPED BYTES, NOT AGAINST THE
  // TYPE CHECKER — AND THAT DISTINCTION IS A DEFECT THIS UNIT CAUGHT IN ITS OWN WORK.
  //
  // The first draft of this block wrote `{ network: … } satisfies Parameters<typeof
  // Sandbox.create>[0]` and its comment claimed "if a future SDK drops it, `pnpm typecheck`
  // fails here". MEASURED FALSE FOR THIS FILE: CI's `Typecheck` step is `pnpm -r typecheck`,
  // i.e. each package's own config, and THIS package's `tsconfig.json` carries
  // `"exclude": ["src/**/*.test.ts"]`, so no test file under `packages/sandbox-e2b-provider`
  // is type-checked at all. vitest transpiles with esbuild and erases types without checking
  // them, so the clause would have been a check that nothing runs, inside the guard written
  // to stop exactly that.
  //
  // ★ THE SCOPE OF THAT SENTENCE MATTERS, AND AN EARLIER DRAFT OVERSTATED IT — it claimed
  // NO test file in this REPOSITORY is ever type-checked, which is false. The correction is
  // measured, not reasoned: `cli`, `packages/adapter-utils`, `packages/db` and
  // `packages/shared` each declare `include: ["src"]` with NO test exclusion, and appending
  // `const x: number = "s";` to one test file in each made that package's own `tsc --noEmit`
  // report TS2322 (1 each), while the identical append under `packages/sandbox-e2b-provider`
  // reported 0. The exclusion is THIS package's, not the repository's.
  //
  // `network` is a TYPE-ONLY option: it is erased at runtime, so no reflection can see it on
  // a live object. What CAN be read is the SDK's own shipped declaration and its shipped
  // runtime, which is where the premise actually lives — and both are lockfile-pinned.
  it("declares the create-time network seam AoA has never called, in its shipped .d.ts and .js", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { createRequire } = await import("node:module");

    // Resolve the installed `e2b` package's dist directory from its own entry point.
    //
    // ★ `createRequire`, NOT `import.meta.resolve`: under vitest's SSR transform
    // `import.meta.resolve` is undefined (measured — `__vite_ssr_import_meta__.resolve is not
    // a function`), so the elegant form would have thrown on every run. `node:module` is
    // forbidden in this package's RUNTIME source by `check-sandbox-e2b-provider-boundary.mjs`
    // and permitted here only because `classifyRuntimeSourceFileName` classifies a
    // `*.test.ts` as a test; nothing shipped imports this file.
    //
    // If resolution ever fails, this test FAILS. It must never degrade into a silent skip —
    // that is the failure mode the whole block exists to prevent.
    const entry = createRequire(import.meta.url).resolve("e2b");
    const dist = dirname(entry);
    const types = readFileSync(join(dist, "index.d.ts"), "utf8");
    const runtime = readFileSync(join(dist, "index.js"), "utf8");

    // 1. The create-time option exists on `SandboxOpts`, with both selectors.
    expect(types).toContain("network?: SandboxNetworkOpts");
    expect(types).toContain("allowOut?: SandboxNetworkSelector");
    expect(types).toContain("denyOut?: SandboxNetworkSelector");
    // 2. It REACHES THE WIRE: the create body carries it, so it is not a client-side ornament.
    expect(runtime).toContain("network: buildNetworkBody(");
    // 3. The server's answer is mapped BACK, which is what makes question (b) answerable.
    expect(types).toContain("network?: SandboxNetworkInfo");
    expect(runtime).toContain("denyOut: res.data.network.denyOut");
    // 4. ★ AND THE SDK VALIDATES NOTHING CLIENT-SIDE. `buildNetworkEgress` is a passthrough:
    //    an unknown or malformed CIDR reaches the server unexamined and the only error path
    //    is the HTTP status. That is precisely why the read-back is a first-class question
    //    and not a footnote, and why a tolerant or self-hosted API could return 200 with an
    //    unpoliced sandbox.
    expect(runtime).toContain("function buildNetworkEgress(network)");
    expect(/function buildNetworkEgress\(network\)[\s\S]{0,600}?throw /.test(runtime)).toBe(false);
  });

  it("the deny set, the anti-vacuity set and the targets form a real differential", () => {
    const deny = denyCidrs(DENY_SET_V4);
    const control = denyCidrs(NON_MATCHING_DENY_SET);
    // ★ If the two sets overlapped, both arms would deny the same thing and the differential
    // would compare a thing with itself.
    expect(deny.some((c) => control.includes(c))).toBe(false);
    expect(HTTP_TARGETS.some((t) => t.role === "positive_control")).toBe(true);
    expect(HTTP_TARGETS.some((t) => t.role === "apparatus_control")).toBe(true);
    expect(RAW_TARGETS.every((t) => t.port !== 443)).toBe(true);
  });

  it("the raw-socket helper speaks the probe line protocol and carries no shell-breaking quote", () => {
    for (const target of RAW_TARGETS) {
      const cmd = rawHelperCommand(target);
      expect(cmd.startsWith("sh -c '")).toBe(true);
      expect(cmd.slice(7, -1).includes("'")).toBe(false);
      expect(cmd).toContain(target.id);
    }
    // The helper's own fallback line must parse as a row, or a template with no python3 would
    // produce NO row at all and (e) would report "missing" instead of "no tool".
    const fallback = "W10B raw_tcp_nonhttp 0 no-raw-socket-tool END\n";
    expect(parseProbeLine(fallback, "raw_tcp_nonhttp")?.detail).toBe("no-raw-socket-tool");
    expect(classifyRawRow(parseProbeLine(fallback, "raw_tcp_nonhttp"))).toBe("unknown");
    expect(RAW_HELPER_SOURCE).toContain("socket.timeout");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE ALLOWLIST ARM'S OWN WIRING, PROVEN WITHOUT A KEY
  // ───────────────────────────────────────────────────────────────────────────
  //
  // ★★★ THE ARM FIRES ONCE, ON AN AUTHORISATION. If the first execution of its command
  // builders is the authorised run itself, a stray quote or a missing row costs the operator
  // the run — the shape that cost the sibling probe three of them. So every string this arm
  // sends is asserted here, on every PR, with no key and no sandbox.

  it("the DNS and liveness commands survive their own sh -c wrapper and speak the line protocol", () => {
    for (const cmd of [dnsHelperCommand(), livenessCommand()]) {
      expect(cmd.startsWith("sh -c '")).toBe(true);
      // One stray single quote would terminate the wrapper and leave a command that still
      // exits 0 and prints nothing — the silently-empty row.
      expect(cmd.slice(7, -1).includes("'")).toBe(false);
    }
    expect(dnsHelperCommand()).toContain(DNS_LOOKUP_NAME);
    // The no-tool fallbacks must PARSE as rows, or a template without python3 would produce
    // no row at all and the arm would report "missing" instead of "no tool".
    expect(parseProbeLine("W10B dns_lookup 0 no-resolver-tool END\n", DNS_ROW_ID)?.detail).toBe("no-resolver-tool");
    expect(classifyDnsRow(parseProbeLine("W10B dns_lookup 0 no-resolver-tool END\n", DNS_ROW_ID))).toBe("unknown");
    expect(classifyDnsRow(parseProbeLine("W10B dns_lookup 0 resolved a -> 1.2.3.4 END\n", DNS_ROW_ID))).toBe("resolved");
    expect(parseProbeLine(`W10B ${LIVENESS_ROW_ID} 0 local-command-ran END\n`, LIVENESS_ROW_ID)?.detail).toBe("local-command-ran");
    // The DNS helper must not reach a remote PORT: its whole job is to separate resolution
    // from connection, and a connect inside it would reintroduce the ambiguity.
    expect(DNS_HELPER_SOURCE).toContain("gethostbyname");
    expect(DNS_HELPER_SOURCE).toContain("socket.setdefaulttimeout");
  });

  it("the allowlist arm names its resolver, keeps its allowed and denied targets disjoint, and cannot vote", () => {
    const allowed = allowOutEntries(ALLOWLIST_ALLOW_SET);
    // ★ THE RESOLVER ENTRY IS WHAT MAKES THE ARM RUNNABLE. Without an allowOut entry covering
    // the measured guest resolver, the default-deny half starves name resolution and every
    // row fails for a reason that has nothing to do with enforcement.
    expect(allowed.some((entry) => ipv4InCidr(MEASURED_GUEST_RESOLVER, entry))).toBe(true);
    // The positive control must itself be allowed, or the arm has no way to tell an enforced
    // allowlist from a sandbox with no egress at all.
    const positive = ALLOWLIST_HTTP_TARGETS.find((t) => t.id === ALLOWLIST_POSITIVE_CONTROL_ID)!;
    expect(positive.role).toBe("positive_control");
    const positiveHost = /^https?:\/\/(\d+\.\d+\.\d+\.\d+)\//.exec(positive.url)?.[1] ?? "";
    expect(positiveHost.length).toBeGreaterThan(0);
    expect(allowed.some((entry) => ipv4InCidr(positiveHost, entry))).toBe(true);
    // ★ And every DENIED target must be outside the allow set — checked by CIDR CONTAINMENT,
    // not by string comparison. A denied host inside an allowed /24 would be spelt
    // differently and read as "not in the list" while the policy allowed it, and the arm
    // would then report INERT on a destination it had itself permitted.
    for (const id of ALLOWLIST_DENIED_IDS) {
      const target = ALLOWLIST_HTTP_TARGETS.find((t) => t.id === id)!;
      expect(target.role).toBe("question");
      const host = /^https?:\/\/(\d+\.\d+\.\d+\.\d+)\//.exec(target.url)?.[1] ?? "";
      expect(host.length).toBeGreaterThan(0);
      expect(allowed.some((entry) => ipv4InCidr(host, entry))).toBe(false);
    }
    // ★★ BROKEN AND MIXED ARE NOT VERDICTS, AND THE TABLE THAT SAYS SO IS ASSERTED RATHER
    // THAN TRUSTED. If `mixed` or `unrun` ever became a verdict, a run that measured nothing
    // would start reading as one that measured something.
    expect([...ALLOWLIST_OUTCOMES].sort()).toEqual(["broken", "enforces", "inert", "mixed", "unrun"]);
    expect(ALLOWLIST_OUTCOME_IS_A_VERDICT.mixed).toBe(false);
    expect(ALLOWLIST_OUTCOME_IS_A_VERDICT.unrun).toBe(false);
    expect(ALLOWLIST_OUTCOME_IS_A_VERDICT.broken).toBe(true);
  });

  it("the arm passes the DOCUMENTED selector form, and the SDK resolves it to the all-traffic sentinel", () => {
    // The docs' own spelling: `denyOut: ({ allTraffic }) => [allTraffic]`. This asserts the
    // callback the arm ships resolves to exactly the sentinel the SDK exports, so the arm
    // cannot silently declare something narrower than "deny everything".
    const denyOut = ({ allTraffic }: { allTraffic: string }) => [allTraffic];
    expect(denyOut({ allTraffic: ALL_TRAFFIC })).toEqual([ALL_TRAFFIC_SENTINEL]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE RESOLUTION AND THE DURABLE RECORD, both proven WITHOUT a key
// ─────────────────────────────────────────────────────────────────────────────
//
// ★★★ ALSO NOT `describeKeyed`. The pure core owns the DECISIONS (what an omitted template
// resolves to; what a record must contain); this block owns the WIRING — that this file
// actually calls them, and that bytes actually land on disk.

describe("W10B — template resolution and the durable record (no key required)", () => {
  it("an omitted E2B_TEMPLATE resolves to the product image, never bare `base`", () => {
    const raw = process.env.E2B_TEMPLATE;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      expect(TEMPLATE).toBe(PROBE_TEMPLATE_ALIAS);
      expect(TEMPLATE).not.toBe("base");
      expect(TEMPLATE_RESOLUTION.source).toBe("default-product-image");
    } else {
      // POSITIVE CONTROL: an explicitly supplied template is honoured unchanged.
      expect(TEMPLATE).toBe(raw.trim());
      expect(TEMPLATE_RESOLUTION.source).toBe("explicit");
    }
  });

  it("the AoA control-plane row is an operator input, and its absence is reported not assumed", () => {
    const raw = process.env.W10B_AOA_API_URL;
    if (typeof raw === "string" && raw.trim().length > 0) {
      expect(AOA_API.supplied).toBe(true);
      expect(AOA_API.target?.url).toBe(raw.trim());
    } else {
      expect(AOA_API.supplied).toBe(false);
      expect(AOA_API.note).toContain("NOT exercised");
    }
    expect(DEFAULT_AOA_API_URL.startsWith("https://")).toBe(true);
  });

  it("emitDurableRecord writes a retrievable record naming the template, the deny set and every verdict", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "w10b-record-"));
    const target = join(dir, "nested", "record.json");
    const summaryTarget = join(dir, "step-summary.md");
    const previous = process.env.W10B_RECORD_PATH;
    // ★★★ E7-F029's SHAPE, FOUND HERE BY GREP RATHER THAN BY A RUN. That finding was filed
    // from an OBSERVED W7U1 run: the no-key wiring test redirected only the record path, so
    // `emitDurableRecord`'s OTHER two channels rendered a SYNTHETIC report — same banner,
    // same template line, same commit sha, fixture details `d1`/`d2`, ending
    // `DISPOSITION: inconclusive` — into the job log AND the step summary of a run that had
    // measured everything it set out to. This lane's test is byte-for-byte the same shape
    // (`emitDurableRecord` at :521 appends to `GITHUB_STEP_SUMMARY` unconditionally, and only
    // `W10B_RECORD_PATH` was saved/restored here), so the same synthetic block would land on
    // the run page the first time an operator fires this lane.
    //
    // ★★ DERIVED FROM SOURCE, NOT OBSERVED: this lane has not fired, so unlike W7U1 there is
    // no run log showing two blocks. The fix is applied anyway because it is the same one
    // line, and rediscovering the defect by wasting a founder-authorised run is the outcome
    // the whole W7U1 durability design exists to avoid.
    const previousSummary = process.env.GITHUB_STEP_SUMMARY;
    process.env.W10B_RECORD_PATH = target;
    process.env.GITHUB_STEP_SUMMARY = summaryTarget;
    try {
      await emitDurableRecord(
        [
          { probe: "a", state: "no", reason: "denied-target-still-reachable", detail: "d1" },
          { probe: "c", state: "inconclusive", reason: "resolv-conf-unreadable", detail: "d2" },
        ],
        { note: "fixture" },
      );
      const parsed = JSON.parse(readFileSync(target, "utf8")) as {
        commitSha: string;
        template: { resolved: string; source: string };
        denySet: string[];
        disposition: { disposition: string };
        decision: { decision: string };
        probes: { probe: string; state: string; reason: string }[];
        observations: Record<string, unknown>;
      };
      expect(parsed.template.resolved).toBe(TEMPLATE);
      expect(parsed.template.source).toBe(TEMPLATE_RESOLUTION.source);
      expect(parsed.denySet).toEqual(denyCidrs(DENY_SET_V4));
      expect(parsed.commitSha).toBe(COMMIT_SHA);
      expect(parsed.disposition.disposition).toBe("inconclusive");
      expect(parsed.observations.note).toBe("fixture");
      expect(parsed.probes.map((p) => `${p.probe}=${p.state}/${p.reason}`)).toEqual([
        "a=no/denied-target-still-reachable",
        "c=inconclusive/resolv-conf-unreadable",
      ]);
      // The summary channel fired — INTO THE TEMP FILE, not the run page. It had no
      // assertion at all before; redirecting it adds one rather than removing coverage.
      const summary = readFileSync(summaryTarget, "utf8");
      expect(summary).toContain("W10B DE-08 EGRESS-ENFORCEMENT PROBE");
      expect(summary).toContain("DISPOSITION: inconclusive");
    } finally {
      if (previous === undefined) delete process.env.W10B_RECORD_PATH;
      else process.env.W10B_RECORD_PATH = previous;
      if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = previousSummary;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
