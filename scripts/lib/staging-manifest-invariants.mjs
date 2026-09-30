// -----------------------------------------------------------------------------
// staging-manifest-invariants — pure static config-contract invariants for the
// DEP-006 staging deployment render (`docker-compose.staging.yml`).
//
//   evaluateStagingManifestInvariants(parsedCompose, options?) -> { violations: string[] }
//
// An empty `violations` array means the staging manifest satisfies the DEP-006
// acceptance contract (design §2, invariants 1–8). This module is PURE (no I/O):
// the runner `scripts/check-staging-manifest.mjs` parses the YAML + reads the env
// doc and feeds them here; the node:test corpus feeds hand-built objects (incl.
// deliberately-broken clones) to prove each check is non-vacuous (§2.8).
//
// It MIRRORS scripts/lib/d1-compose-invariants.mjs (same shape: exported EXPECTED_*
// pins + check* functions taking the parsed compose), but expresses a DEPLOYMENT-
// INTENT topology (external DB/object-store, two failure domains, a dedicated
// provider-control surface) rather than the hermetic D1 live-test stack.
//
// Load-bearing invariants:
//   §2.1 migration-first          — every CP + worker depends_on the migrate one-shot.
//   §2.5 provider-control boundary — E2B_API_KEY lives ONLY on the adapter-management
//        surface (on provider-ctl-net), injected (rotatable, not baked), and is ABSENT
//        from every control-plane / worker / migrate surface; CP + workers are NOT on
//        provider-ctl-net.
// -----------------------------------------------------------------------------

// --- topology pins ------------------------------------------------------------

export const MIGRATE_SERVICE = "migrate";
export const ADAPTER_MANAGER_SERVICE = "adapter-manager";
export const CONTROL_PLANE_SERVICES = ["control-plane", "control-plane-b"];
export const WORKER_SERVICES = ["worker-a1", "worker-a2", "worker-b1", "worker-b2"];

/** The EXACT staging service set (no embedded data/proxy/provider services — those
 * are EXTERNAL, expressed as x-external pointers, per D1). */
export const STAGING_SERVICES = [
  MIGRATE_SERVICE,
  ...CONTROL_PLANE_SERVICES,
  ...WORKER_SERVICES,
  ADAPTER_MANAGER_SERVICE,
];

// Services that are horizontally scaled (autoscaling-bounded, §2.7) — the app tiers
// plus the provider-control surface. The migrate one-shot is exempt.
export const SCALABLE_SERVICES = [...CONTROL_PLANE_SERVICES, ...WORKER_SERVICES, ADAPTER_MANAGER_SERVICE];
// Services that declare an N/N-1 rolling-update policy (§2.2): CP + workers.
export const ROLLOUT_SERVICES = [...CONTROL_PLANE_SERVICES, ...WORKER_SERVICES];
// One-shot run-to-completion jobs (exempt from long-running expectations; dependents
// must gate on `service_completed_successfully`).
export const ONE_SHOT_SERVICES = [MIGRATE_SERVICE];

// --- networks -----------------------------------------------------------------

export const CONTROL_NET = "control-net";
export const STORE_EGRESS_NET = "store-egress-net";
export const PROVIDER_CTL_NET = "provider-ctl-net";
export const STAGING_NETWORKS = [CONTROL_NET, STORE_EGRESS_NET, PROVIDER_CTL_NET];

/** The EXACT per-service network-attachment matrix.
 *  - control-net (internal mesh) — every app service + the adapter-management surface;
 *  - store-egress-net (egress) — the external DB/object-store reachers (CP + workers + migrate);
 *  - provider-ctl-net (egress) — ONLY the adapter-management surface (the provider-control boundary). */
export const EXPECTED_NETWORKS = {
  [MIGRATE_SERVICE]: [STORE_EGRESS_NET],
  "control-plane": [CONTROL_NET, STORE_EGRESS_NET],
  "control-plane-b": [CONTROL_NET, STORE_EGRESS_NET],
  "worker-a1": [CONTROL_NET, STORE_EGRESS_NET],
  "worker-a2": [CONTROL_NET, STORE_EGRESS_NET],
  "worker-b1": [CONTROL_NET, STORE_EGRESS_NET],
  "worker-b2": [CONTROL_NET, STORE_EGRESS_NET],
  [ADAPTER_MANAGER_SERVICE]: [CONTROL_NET, PROVIDER_CTL_NET],
};

// --- failure domains (D1 — two domains, 1 CP + 2 workers each) ----------------

// Real reverse-DNS label keys (NOT `x-`-prefixed): Docker Compose hoists ANY `x-`
// key — including inside a service `labels:` map — into a synthetic `#extensions`
// field, so an `x-`-prefixed label is DROPPED from the rendered container model and
// is unreadable by `docker compose config`. `com.aoa.*` keys are preserved verbatim.
export const FAILURE_DOMAIN_LABEL = "com.aoa.failure-domain";
export const SHARED_FAILURE_DOMAIN = "shared";
/** Each service's required failure-domain label. The 6 app services split 1 CP + 2
 * workers per domain; migrate + the provider-control surface are shared infra. */
export const EXPECTED_FAILURE_DOMAINS = {
  "control-plane": "domain-a",
  "worker-a1": "domain-a",
  "worker-a2": "domain-a",
  "control-plane-b": "domain-b",
  "worker-b1": "domain-b",
  "worker-b2": "domain-b",
  [MIGRATE_SERVICE]: SHARED_FAILURE_DOMAIN,
  [ADAPTER_MANAGER_SERVICE]: SHARED_FAILURE_DOMAIN,
};
export const EXPECTED_APP_DOMAINS = {
  "domain-a": ["control-plane", "worker-a1", "worker-a2"],
  "domain-b": ["control-plane-b", "worker-b1", "worker-b2"],
};

// --- rollout / autoscaling / drain pins ---------------------------------------

const VALID_DEPENDS_CONDITIONS = ["service_healthy", "service_completed_successfully"];
const VALID_ROLLOUT_ORDERS = ["start-first", "stop-first"];
// N/N-1: at most one replica may be version-skewed at a time, so parallelism is
// bounded to 1 (a mixed-version fleet stays interchangeable via the shared session
// signing key). max_failure_ratio must be present + bounded (no unbounded churn).
export const EXPECTED_ROLLOUT_PARALLELISM = 1;
export const MAX_ROLLOUT_FAILURE_RATIO = 0.25;

export const AUTOSCALE_MIN_LABEL = "com.aoa.autoscaling-min";
export const AUTOSCALE_MAX_LABEL = "com.aoa.autoscaling-max";
// No unbounded replica count — the max ceiling is explicit and finite.
export const AUTOSCALE_REPLICA_CEILING = 32;

export const DRAIN_HOOK_LABEL = "com.aoa.drain-hook";
// A bounded grace: long enough to relinquish an in-flight lease within the visibility
// timeout, short enough that the reaper (DEP-005) reclaims a stuck worker promptly.
export const MAX_STOP_GRACE_SECONDS = 600;

// --- provider-control + admission env pins ------------------------------------

export const PROVIDER_CONTROL_CRED_ENV = "E2B_API_KEY";
// A secrets/configs/volume reference NAMED for the provider-control credential (e2b, or
// an explicit provider-control token) smuggles it onto a non-adapter surface. Legit worker
// secrets (worker-enrollment-code, session-signing-key) do NOT match, so no over-rejection.
const PROVIDER_CONTROL_REF_RE = /e2b|provider[-_]?c(?:tl|ontrol)/i;
export const DISTRIBUTED_EXECUTION_ENABLED_ENV = "AOA_DISTRIBUTED_EXECUTION_ENABLED";
// A value that is a BARE `${VAR}` interpolation (or a /run/secrets mount path) is
// deploy-time injected = rotatable without an image rebuild. A literal is baked =
// forbidden. The bare-var form is required deliberately: a `${VAR:-fallback}` (or
// `:=`/`-`/`+`) default BAKES the fallback into the render whenever the deploy var is
// unset, so `${AOA_STAGING_E2B_API_KEY:-sk-real-key}` would resolve to the literal —
// a baked credential the loose `\$\{[^}]+\}` form would have accepted.
const INJECTION_VALUE_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const MOUNTED_SECRET_VALUE_RE = /^\/run\/secrets\//;
// Process-local / in-memory admission is a fail-open fallback the shared DEP-009
// limiter (worker_admission_rate_limits) explicitly forbids. Any env key naming a
// local/in-memory/in-process admission counter or a fallback is a contract violation.
const PROCESS_LOCAL_ADMISSION_ENV_RE =
  /ADMISSION.*(LOCAL|MEMORY|INPROC|IN_PROCESS|FALLBACK)|(LOCAL|MEMORY|INPROC|IN_PROCESS)_?ADMISSION|(RATE_LIMIT|RATELIMIT).*(LOCAL|MEMORY|INPROC|FALLBACK)/i;
// The ONLY admission-limiter env keys the shared limiter reads. A second, different
// admission-limiter env key implies a second counter (also forbidden).
const SHARED_ADMISSION_ENV_ALLOW = new Set([
  "AOA_WORKER_POLL_RATE_LIMIT_MAX",
  "AOA_WORKER_POLL_RATE_LIMIT_WINDOW_MS",
]);
const ADMISSION_LIMITER_ENV_RE = /ADMISSION|RATE_?LIMIT/i;

// --- external-store pointer pins ----------------------------------------------

export const EXTERNAL_POINTER_KEY = "x-external";
export const EXPECTED_EXTERNAL_POINTERS = ["database", "object-store", "realtime", "admission-store"];
// Embedded data/proxy/provider services that MUST NOT appear (they are external).
const FORBIDDEN_EMBEDDED_SERVICES = ["postgres", "minio", "toxiproxy", "fake-provider"];

// --- image-ref pins -----------------------------------------------------------

const IMAGE_INJECTION_TOKENS = {
  "control-plane": "AOA_STAGING_CONTROL_PLANE_IMAGE",
  "control-plane-b": "AOA_STAGING_CONTROL_PLANE_IMAGE",
  [MIGRATE_SERVICE]: "AOA_STAGING_CONTROL_PLANE_IMAGE",
  "worker-a1": "AOA_STAGING_WORKER_IMAGE",
  "worker-a2": "AOA_STAGING_WORKER_IMAGE",
  "worker-b1": "AOA_STAGING_WORKER_IMAGE",
  "worker-b2": "AOA_STAGING_WORKER_IMAGE",
  [ADAPTER_MANAGER_SERVICE]: "AOA_STAGING_ADAPTER_MANAGER_IMAGE",
};

// --- shared helpers (mirrors d1-compose-invariants) ---------------------------

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function serviceNetworks(service) {
  const nets = service?.networks;
  if (nets === null || nets === undefined) return [];
  if (Array.isArray(nets)) return nets.map(String);
  if (typeof nets === "object") return Object.keys(nets);
  return [String(nets)];
}

/** Enumerate a service's environment as [key, value] pairs (object OR `K=V` list). */
function envEntries(service) {
  const env = service?.environment;
  if (env && typeof env === "object" && !Array.isArray(env)) return Object.entries(env);
  if (Array.isArray(env)) {
    return env.map((entry) => {
      const s = String(entry);
      const idx = s.indexOf("=");
      return idx === -1 ? [s, ""] : [s.slice(0, idx), s.slice(idx + 1)];
    });
  }
  return [];
}

function envValue(service, key) {
  for (const [k, v] of envEntries(service)) if (k === key) return v;
  return undefined;
}

function hasEnvKey(service, key) {
  return envEntries(service).some(([k]) => k === key);
}

/** A service's labels as a { key: value } map (labels may be a map OR a `K=V` list). */
function labelMap(service) {
  const labels = service?.labels;
  if (labels && typeof labels === "object" && !Array.isArray(labels)) return labels;
  if (Array.isArray(labels)) {
    const out = {};
    for (const entry of labels) {
      const s = String(entry);
      const idx = s.indexOf("=");
      if (idx === -1) out[s] = "";
      else out[s.slice(0, idx)] = s.slice(idx + 1);
    }
    return out;
  }
  return {};
}

function labelValue(service, key) {
  const map = labelMap(service);
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function setsEqual(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/** Parse a compose duration (`30s`, `2m`, `1m30s`, or bare seconds) to seconds. */
function parseDurationSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return NaN;
  const s = value.trim();
  if (s === "") return NaN;
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  const re = /(\d+)(h|m|s|ms)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = Number.parseInt(m[1], 10);
    if (m[2] === "h") total += n * 3600;
    else if (m[2] === "m") total += n * 60;
    else if (m[2] === "s") total += n;
    else if (m[2] === "ms") total += n / 1000;
  }
  return matched ? total : NaN;
}

/** Documented-env-key extractor: every backtick-wrapped ALL-CAPS token in the env
 * doc's variable/alias cells. Used by the runner to feed §2.6 the documented set. */
export function collectDocumentedEnvKeys(docText) {
  const keys = new Set();
  const re = /`([A-Z][A-Z0-9_]{2,})`/g;
  let m;
  while ((m = re.exec(docText)) !== null) keys.add(m[1]);
  return keys;
}

// --- individual checks --------------------------------------------------------

function checkServiceSet(services, v) {
  const present = new Set(Object.keys(services));
  const expected = new Set(STAGING_SERVICES);
  for (const name of expected) if (!present.has(name)) v.push(`missing required service '${name}'`);
  for (const name of present) {
    if (!expected.has(name)) {
      const embedded = FORBIDDEN_EMBEDDED_SERVICES.includes(name)
        ? " (data/proxy/provider stores are EXTERNAL — express them as x-external pointers, not embedded services)"
        : "";
      v.push(`unexpected service '${name}' (not part of the DEP-006 staging topology)${embedded}`);
    }
  }
}

function checkNetworkMatrix(services, v) {
  for (const [name, expected] of Object.entries(EXPECTED_NETWORKS)) {
    const service = services[name];
    if (!service) continue;
    const actual = serviceNetworks(service);
    if (!setsEqual(actual, expected)) {
      v.push(
        `service '${name}' network set {${[...new Set(actual)].sort().join(", ")}} != required {${[...expected].sort().join(", ")}}`,
      );
    }
  }
}

/** §2.5 (partial) + boundary: control-net internal; the egress nets declared + NOT
 * forced internal (the external stores + provider API need egress). */
function checkNetworksDeclared(compose, v) {
  const defs = compose?.networks;
  if (!defs || typeof defs !== "object") {
    v.push("top-level 'networks:' block is missing");
    return;
  }
  for (const net of STAGING_NETWORKS) {
    if (!(net in defs)) v.push(`network '${net}' is not declared at top level`);
  }
  const control = defs[CONTROL_NET];
  if (control && control.internal !== true) {
    v.push(`network '${CONTROL_NET}' must be 'internal: true' (the internal control mesh)`);
  }
  for (const egress of [STORE_EGRESS_NET, PROVIDER_CTL_NET]) {
    const def = defs[egress];
    if (def && def.internal === true) {
      v.push(`network '${egress}' must NOT be 'internal: true' (it is an egress surface to an external endpoint)`);
    }
  }
}

/** §2.1 — migration runs first: every CP + worker depends_on the migrate one-shot
 * with condition service_completed_successfully; migrate carries a migration DB URL. */
function checkMigrationFirst(services, v) {
  const migrate = services[MIGRATE_SERVICE];
  if (migrate && !hasEnvKey(migrate, "DATABASE_URL")) {
    v.push(`'${MIGRATE_SERVICE}' must set 'DATABASE_URL' (the privileged migration connection)`);
  }
  for (const name of [...CONTROL_PLANE_SERVICES, ...WORKER_SERVICES]) {
    const svc = services[name];
    if (!svc) continue;
    const deps = svc.depends_on;
    const dep = deps && !Array.isArray(deps) ? deps[MIGRATE_SERVICE] : undefined;
    if (!dep || dep.condition !== "service_completed_successfully") {
      v.push(`'${name}' must depends_on '${MIGRATE_SERVICE}' with condition 'service_completed_successfully' (migration runs first)`);
    }
  }
}

function checkDependsOn(services, v) {
  for (const [name, service] of Object.entries(services)) {
    const deps = service?.depends_on;
    if (deps === null || deps === undefined) continue;
    if (Array.isArray(deps)) {
      v.push(`service '${name}' uses short-form 'depends_on' (list); it must use the long form with 'condition:'`);
      continue;
    }
    if (typeof deps !== "object") {
      v.push(`service '${name}' has a malformed 'depends_on'`);
      continue;
    }
    for (const [dep, spec] of Object.entries(deps)) {
      const condition = spec?.condition;
      if (!VALID_DEPENDS_CONDITIONS.includes(condition)) {
        v.push(`service '${name}' depends_on '${dep}' with condition '${condition ?? "(none)"}'; expected one of ${VALID_DEPENDS_CONDITIONS.join("/")}`);
        continue;
      }
      if (ONE_SHOT_SERVICES.includes(dep) && condition !== "service_completed_successfully") {
        v.push(`service '${name}' depends_on one-shot job '${dep}' with '${condition}'; it must be 'service_completed_successfully'`);
      }
    }
  }
}

/** §2.2 — N/N-1 rollout: CP + workers declare a bounded rolling-update policy. */
function checkRolloutPolicy(services, v) {
  for (const name of ROLLOUT_SERVICES) {
    const svc = services[name];
    if (!svc) continue;
    const uc = svc.deploy?.update_config;
    if (!uc || typeof uc !== "object") {
      v.push(`'${name}' must declare a rolling-update policy ('deploy.update_config') for N/N-1 rollout`);
      continue;
    }
    const p = uc.parallelism;
    if (typeof p !== "number" || !Number.isInteger(p) || p !== EXPECTED_ROLLOUT_PARALLELISM) {
      v.push(`'${name}' rolling-update 'parallelism' must be ${EXPECTED_ROLLOUT_PARALLELISM} (N/N-1: at most one version-skewed replica); got ${JSON.stringify(p)}`);
    }
    if (!VALID_ROLLOUT_ORDERS.includes(uc.order)) {
      v.push(`'${name}' rolling-update 'order' must be one of ${VALID_ROLLOUT_ORDERS.join("/")} (bounded surge/unavailability); got ${JSON.stringify(uc.order)}`);
    }
    const ratio = uc.max_failure_ratio;
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > MAX_ROLLOUT_FAILURE_RATIO) {
      v.push(`'${name}' rolling-update 'max_failure_ratio' must be a bounded fraction in [0, ${MAX_ROLLOUT_FAILURE_RATIO}]; got ${JSON.stringify(ratio)}`);
    }
  }
}

/** §2.3 — workers drain: bounded stop_grace_period + a documented drain hook + stop_signal. */
function checkWorkerDrain(services, v) {
  for (const name of WORKER_SERVICES) {
    const svc = services[name];
    if (!svc) continue;
    const grace = svc.stop_grace_period;
    if (grace === undefined || grace === null || String(grace).trim() === "") {
      v.push(`worker '${name}' must set 'stop_grace_period' (a bounded drain window before termination)`);
    } else {
      const secs = parseDurationSeconds(grace);
      if (!Number.isFinite(secs) || secs <= 0 || secs > MAX_STOP_GRACE_SECONDS) {
        v.push(`worker '${name}' 'stop_grace_period' must parse to a bounded (0, ${MAX_STOP_GRACE_SECONDS}s] duration; got ${JSON.stringify(grace)}`);
      }
    }
    const hook = labelValue(svc, DRAIN_HOOK_LABEL);
    if (hook === undefined || String(hook).trim() === "") {
      v.push(`worker '${name}' must declare a documented drain hook label '${DRAIN_HOOK_LABEL}' (stop polling; relinquish in-flight leases within the visibility timeout)`);
    }
    if (svc.stop_signal === undefined || String(svc.stop_signal).trim() === "") {
      v.push(`worker '${name}' must set 'stop_signal' so the drain hook receives a graceful termination signal`);
    }
  }
}

/** §2.4 — shared admission cannot fall back to process memory: CPs enable distributed
 * execution (the shared limiter path); NO process-local admission env on any service;
 * NO second admission-limiter env (only the shared DEP-009 keys allowed). */
function checkSharedAdmission(services, v) {
  for (const name of CONTROL_PLANE_SERVICES) {
    const svc = services[name];
    if (!svc) continue;
    const flag = envValue(svc, DISTRIBUTED_EXECUTION_ENABLED_ENV);
    if (String(flag) !== "true") {
      v.push(`'${name}' must set '${DISTRIBUTED_EXECUTION_ENABLED_ENV}=true' (the fail-closed shared admission limiter is only wired on the distributed path); got ${JSON.stringify(flag)}`);
    }
  }
  for (const [name, svc] of Object.entries(services)) {
    for (const [key] of envEntries(svc)) {
      if (PROCESS_LOCAL_ADMISSION_ENV_RE.test(key)) {
        v.push(`ADMISSION VIOLATION: service '${name}' declares process-local / in-memory admission env '${key}' (shared admission must never fall back to process memory)`);
        continue;
      }
      if (ADMISSION_LIMITER_ENV_RE.test(key) && !SHARED_ADMISSION_ENV_ALLOW.has(key)) {
        v.push(`ADMISSION VIOLATION: service '${name}' declares admission-limiter env '${key}' that is not the shared DEP-009 counter (no second admission counter)`);
      }
    }
  }
}

/** §2.5 — provider-control credential confined + absent. */
function checkProviderControlBoundary(services, v) {
  // (a) provider-ctl-net members are EXACTLY {adapter-manager}.
  for (const [name, svc] of Object.entries(services)) {
    if (name === ADAPTER_MANAGER_SERVICE) continue;
    if (serviceNetworks(svc).includes(PROVIDER_CTL_NET)) {
      v.push(`PROVIDER-CONTROL VIOLATION: service '${name}' must NOT be attached to '${PROVIDER_CTL_NET}' (only '${ADAPTER_MANAGER_SERVICE}' reaches the provider control surface)`);
    }
  }
  const adapter = services[ADAPTER_MANAGER_SERVICE];
  if (adapter && !serviceNetworks(adapter).includes(PROVIDER_CTL_NET)) {
    v.push(`'${ADAPTER_MANAGER_SERVICE}' must be attached to '${PROVIDER_CTL_NET}' (the provider-control surface)`);
  }
  // (b) E2B_API_KEY present ONLY on the adapter-management surface, and injected (rotatable).
  // The absence guarantee spans EVERY credential-delivery channel, not just `environment:`
  // — env_file / secrets / configs / a mount / command / entrypoint would each smuggle the
  // credential onto a non-adapter surface while an environment-only scan passed green.
  for (const [name, svc] of Object.entries(services)) {
    if (name === ADAPTER_MANAGER_SERVICE) continue;
    if (hasEnvKey(svc, PROVIDER_CONTROL_CRED_ENV)) {
      v.push(`PROVIDER-CONTROL VIOLATION: service '${name}' declares '${PROVIDER_CONTROL_CRED_ENV}' in 'environment' (the provider-control credential must be ABSENT from every control-plane / worker / migrate surface)`);
    }
    // env_file is opaque (its contents cannot be statically verified), so it is FORBIDDEN
    // on non-adapter surfaces — it could carry the credential undetectably.
    if (svc?.env_file !== undefined && asArray(svc.env_file).length > 0) {
      v.push(`PROVIDER-CONTROL VIOLATION: service '${name}' declares 'env_file' (opaque credential channel forbidden on non-adapter surfaces — the provider-control credential could be smuggled in)`);
    }
    // A secrets / configs entry (or a volume mount) NAMED for the provider-control credential
    // routes it onto a non-adapter surface. Legit worker secrets (e.g. worker-enrollment-code)
    // do NOT match the token pattern, so this does not over-reject.
    for (const channel of ["secrets", "configs", "volumes"]) {
      for (const entry of asArray(svc?.[channel])) {
        const ref = typeof entry === "object" && entry !== null
          ? String(entry.source ?? entry.target ?? JSON.stringify(entry))
          : String(entry);
        if (PROVIDER_CONTROL_REF_RE.test(ref)) {
          v.push(`PROVIDER-CONTROL VIOLATION: service '${name}' '${channel}' references the provider-control credential ('${ref}') — it must live ONLY on the adapter-management surface`);
        }
      }
    }
    // The credential token appearing in command/entrypoint is an inline-injection vector.
    for (const field of ["command", "entrypoint"]) {
      const joined = asArray(svc?.[field]).map(String).join(" ") + " " + (typeof svc?.[field] === "string" ? svc[field] : "");
      if (joined.includes(PROVIDER_CONTROL_CRED_ENV) || /\bE2B_/.test(joined)) {
        v.push(`PROVIDER-CONTROL VIOLATION: service '${name}' names the provider-control credential in '${field}' (inline-injection vector on a non-adapter surface)`);
      }
    }
  }
  if (adapter) {
    if (!hasEnvKey(adapter, PROVIDER_CONTROL_CRED_ENV)) {
      v.push(`'${ADAPTER_MANAGER_SERVICE}' must inject '${PROVIDER_CONTROL_CRED_ENV}' (the provider-control credential lives ONLY on the adapter-management surface)`);
    } else {
      const val = String(envValue(adapter, PROVIDER_CONTROL_CRED_ENV) ?? "");
      if (!INJECTION_VALUE_RE.test(val) && !MOUNTED_SECRET_VALUE_RE.test(val)) {
        v.push(`PROVIDER-CONTROL VIOLATION: '${ADAPTER_MANAGER_SERVICE}' '${PROVIDER_CONTROL_CRED_ENV}' must be an injected value (\${VAR} interpolation or a /run/secrets mount) so it is rotatable without an image rebuild — a baked literal is forbidden; got ${JSON.stringify(val)}`);
      }
    }
  }
}

/**
 * DEP-010 — dispatch stays OFF by default on every worker surface.
 *
 * The shipped composition is inert (no provider constructed; the flag defaults off), and NO
 * staging worker may carry the switches that would turn it on. Spans `environment` AND
 * `command`/`entrypoint` — parity with checkProviderControlBoundary, because a value delivered
 * inline is a value delivered. NOTE: CONTAINER-only (the staging compose). The desktop lane has
 * no equivalent deployment-surface guard, and after Sprint 3 removes the structural gate that
 * gap is the whole exposure (DEP-010 design §4.2 item 2).
 */
// ★ Blocker B added `AOA_WORKER_PROVIDER_URL` to this list, and the reason it was NOT here
// before is the reason it must be here now.
//
// It is the CONTAINER analogue of the desktop `AOA_WORKER_SANDBOX_PROVIDER`: set it, and
// `worker-networked-host` builds a per-run `makeRunProvider` factory that dials the
// adapter-manager over the gated provider wire. Until Blocker B, leaving it unbanned was safe
// for a STRUCTURAL reason — no shipped image contained a bin that reads it, so the variable was
// inert config no matter who set it. Blocker B puts that bin in the worker image. The variable
// stops being inert, and the non-ban stops being safe.
//
// `docker-compose.d1.yml` ALREADY sets it on both workers, pointed at a real `fake-provider`
// service on the net (`scripts/d1-dispatch-expectation.json` declares it present-and-dead).
// That is why this matters and is not theoretical: after Blocker B, D1 is ONE `command:` line
// away from a fabricating provider. This list guards STAGING; the D1 declaration file carries
// the matching clause for the D1 harness, and `checkDispatchDefaultOff` below spans
// `environment` AND `command`/`entrypoint`, so the inline-injection route is covered too.
export const DISPATCH_SWITCH_ENVS = [
  "AOA_WORKER_DISPATCH_ENABLED",
  "AOA_WORKER_SANDBOX_PROVIDER",
  "AOA_WORKER_PROVIDER_URL",
];

function checkDispatchDefaultOff(services, v) {
  for (const name of WORKER_SERVICES) {
    const svc = services[name];
    if (!svc) continue;
    for (const key of DISPATCH_SWITCH_ENVS) {
      if (hasEnvKey(svc, key)) {
        v.push(`DISPATCH-DEFAULT VIOLATION: worker '${name}' declares '${key}' in 'environment' — dispatch stays OFF by default; no staging worker may set the switches that turn it on (DEP-010)`);
      }
      // Inline-injection vector — the same command/entrypoint join idiom as the provider-control
      // boundary above.
      for (const field of ["command", "entrypoint"]) {
        const joined = asArray(svc?.[field]).map(String).join(" ") + " " + (typeof svc?.[field] === "string" ? svc[field] : "");
        if (joined.includes(key)) {
          v.push(`DISPATCH-DEFAULT VIOLATION: worker '${name}' names '${key}' in '${field}' (inline-injection vector) — dispatch stays OFF by default (DEP-010)`);
        }
      }
    }
  }
}

/** §2.6 — all mutable configuration documented (runner supplies the documented set). */
function checkEnvDocumented(services, documentedEnvKeys, v) {
  for (const [name, svc] of Object.entries(services)) {
    for (const [key] of envEntries(svc)) {
      if (!documentedEnvKeys.has(key)) {
        v.push(`service '${name}' env key '${key}' is not documented in docs/deploy/environment-variables.md`);
      }
    }
  }
}

/** §2.7 — autoscaling limits bounded: explicit min/max, 1 <= min <= max <= ceiling. */
function checkAutoscalingBounded(services, v) {
  for (const name of SCALABLE_SERVICES) {
    const svc = services[name];
    if (!svc) continue;
    const rawMin = labelValue(svc, AUTOSCALE_MIN_LABEL);
    const rawMax = labelValue(svc, AUTOSCALE_MAX_LABEL);
    if (rawMin === undefined || rawMax === undefined) {
      v.push(`'${name}' must declare bounded autoscaling labels '${AUTOSCALE_MIN_LABEL}'/'${AUTOSCALE_MAX_LABEL}' (no unbounded replica count)`);
      continue;
    }
    const min = Number(rawMin);
    const max = Number(rawMax);
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      v.push(`'${name}' autoscaling bounds must be integers; got min=${JSON.stringify(rawMin)} max=${JSON.stringify(rawMax)}`);
      continue;
    }
    if (min < 1) v.push(`'${name}' autoscaling min must be >= 1; got ${min}`);
    if (max < min) v.push(`'${name}' autoscaling max (${max}) must be >= min (${min})`);
    if (max > AUTOSCALE_REPLICA_CEILING) {
      v.push(`'${name}' autoscaling max (${max}) exceeds the bounded ceiling ${AUTOSCALE_REPLICA_CEILING} (no unbounded replica count)`);
    }
  }
}

/** D1 structural — the two failure domains split 1 CP + 2 workers each. */
function checkFailureDomains(services, v) {
  for (const [name, expected] of Object.entries(EXPECTED_FAILURE_DOMAINS)) {
    const svc = services[name];
    if (!svc) continue;
    const actual = labelValue(svc, FAILURE_DOMAIN_LABEL);
    if (actual !== expected) {
      v.push(`service '${name}' failure-domain label '${FAILURE_DOMAIN_LABEL}' is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }
  for (const [domain, members] of Object.entries(EXPECTED_APP_DOMAINS)) {
    const actualMembers = Object.keys(services).filter(
      (name) => EXPECTED_FAILURE_DOMAINS[name] !== undefined && labelValue(services[name], FAILURE_DOMAIN_LABEL) === domain,
    );
    if (!setsEqual(actualMembers, members)) {
      v.push(`failure domain '${domain}' members {${actualMembers.sort().join(", ")}} != required {${[...members].sort().join(", ")}} (each domain: 1 control-plane + 2 workers)`);
    }
  }
}

/** D1 — external DB/object-store/realtime/admission are x-external injected pointers. */
function checkExternalPointers(compose, v) {
  const ext = compose?.[EXTERNAL_POINTER_KEY];
  if (!ext || typeof ext !== "object" || Array.isArray(ext)) {
    v.push(`top-level '${EXTERNAL_POINTER_KEY}:' must declare the external store pointers {${EXPECTED_EXTERNAL_POINTERS.join(", ")}}`);
    return;
  }
  for (const key of EXPECTED_EXTERNAL_POINTERS) {
    if (!(key in ext)) {
      v.push(`'${EXTERNAL_POINTER_KEY}' is missing the '${key}' endpoint pointer`);
      continue;
    }
    const val = String(ext[key] ?? "");
    if (!INJECTION_VALUE_RE.test(val)) {
      v.push(`'${EXTERNAL_POINTER_KEY}.${key}' must be an injected \${VAR} endpoint pointer (external, not an embedded service); got ${JSON.stringify(val)}`);
    }
  }
}

/** control-plane / worker / adapter images injected from admitted-digest env vars. */
function checkAdmittedImageRefs(services, v) {
  for (const [name, token] of Object.entries(IMAGE_INJECTION_TOKENS)) {
    const svc = services[name];
    if (!svc) continue;
    const img = svc.image;
    // The image must BEGIN with the injection interpolation `${TOKEN}` or
    // `${TOKEN:-default}` — a bare `includes(token)` would accept a fully hardcoded
    // attacker ref that merely embeds the token as a path component
    // (e.g. `ghcr.io/evil/AOA_STAGING_WORKER_IMAGE@sha256:…`).
    const injected = typeof img === "string" &&
      new RegExp(`^\\$\\{${token}(:-[^}]*)?\\}`).test(img);
    if (!injected) {
      v.push(`service '${name}' 'image' must be injected via \${${token}} (an admitted digest), not hardcoded`);
    }
  }
}

/**
 * @param {any} compose parsed docker-compose.staging.yml
 * @param {{ documentedEnvKeys?: Set<string> }} [options]
 * @returns {{ violations: string[] }}
 */
export function evaluateStagingManifestInvariants(compose, options = {}) {
  const v = [];
  const services = compose?.services;
  if (!services || typeof services !== "object") {
    return { violations: ["compose has no 'services' block"] };
  }

  checkServiceSet(services, v);
  checkNetworkMatrix(services, v);
  checkNetworksDeclared(compose, v);
  checkMigrationFirst(services, v);
  checkDependsOn(services, v);
  checkRolloutPolicy(services, v);
  checkWorkerDrain(services, v);
  checkSharedAdmission(services, v);
  checkProviderControlBoundary(services, v);
  checkDispatchDefaultOff(services, v);
  checkAutoscalingBounded(services, v);
  checkFailureDomains(services, v);
  checkExternalPointers(compose, v);
  checkAdmittedImageRefs(services, v);

  if (options.documentedEnvKeys !== undefined) {
    checkEnvDocumented(services, options.documentedEnvKeys, v);
  }

  return { violations: v };
}
