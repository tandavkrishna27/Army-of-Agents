// -----------------------------------------------------------------------------
// d1-evidence-bundle — pure DEP-004 failure-evidence assembler (dependency-free).
//
// `buildEvidenceBundle(inputs) -> {sections:{logs,events,dbState,objectManifests}, manifest}`
//
// When the D1 merge-train (docker-compose.d1.yml + a bounded E6F subset) fails,
// CI must RETAIN the distributed evidence: per-service logs, the worker event
// stream, a control-plane DB-state dump, and the object-store (MinIO) manifests.
// This lib assembles those four sections into one self-describing bundle whose
// `manifest` indexes each section with a presence flag, an item/byte count, and a
// SHA-256 over the canonical section bytes. `scripts/collect-d1-evidence.mjs`
// wraps it for the merge-train's `actions/upload-artifact` step.
//
// Fail-closed shape guarantees: buildEvidenceBundle ALWAYS emits all four section
// keys (an absent input becomes an empty section marked `present:false`) — a
// failure that produced no object writes must still carry an objectManifests
// section, never silently drop it. validateEvidenceBundle detects any structural
// hole (a section or its manifest entry removed after the fact).
// -----------------------------------------------------------------------------

import { createHash } from "node:crypto";

/** The four sections every retained failure bundle must carry. */
export const REQUIRED_SECTIONS = Object.freeze(["logs", "events", "dbState", "objectManifests"]);

const BUNDLE_SCHEMA = "aoa-d1-evidence-bundle/v1";

/** Stable JSON (sorted keys) so a section's SHA-256 is deterministic. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function sha256Hex(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Count of a section's items: arrays by length, objects by key count, else 0. */
function sectionCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

/** Is a section input non-empty (i.e. real evidence was collected)? */
function sectionPresent(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") return value.length > 0;
  return true;
}

/** Normalize an input section to its canonical stored form (never undefined). */
function normalizeSection(name, raw) {
  if (name === "dbState") {
    return raw == null ? {} : raw;
  }
  // logs / events / objectManifests are arrays.
  return Array.isArray(raw) ? raw : [];
}

/**
 * Assemble the four-section failure-evidence bundle + its manifest.
 * @param {object} inputs collector output: { runId, reason, generatedAt,
 *   logs, events, dbState, objectManifests }
 */
export function buildEvidenceBundle(inputs = {}) {
  const {
    runId = null,
    reason = null,
    generatedAt = new Date(0).toISOString(),
  } = inputs || {};

  const sections = {};
  const manifestSections = [];
  for (const name of REQUIRED_SECTIONS) {
    const normalized = normalizeSection(name, inputs ? inputs[name] : undefined);
    sections[name] = normalized;
    const present = sectionPresent(inputs ? inputs[name] : undefined);
    const canonical = stableStringify(normalized);
    manifestSections.push({
      name,
      present,
      count: sectionCount(normalized),
      bytes: Buffer.byteLength(canonical, "utf8"),
      sha256: sha256Hex(canonical),
    });
  }

  return {
    sections,
    manifest: {
      schema: BUNDLE_SCHEMA,
      runId,
      reason,
      generatedAt,
      sections: manifestSections,
    },
  };
}

/**
 * Validate a bundle's structural completeness. Returns a list of violations
 * (empty ⇒ complete). This is the fail-closed check the retention proof runs:
 * a section (or its manifest entry) removed after assembly is detected.
 */
export function validateEvidenceBundle(bundle) {
  const violations = [];
  if (bundle == null || typeof bundle !== "object") {
    return ["evidence bundle is missing or not an object"];
  }
  if (bundle.sections == null || typeof bundle.sections !== "object") {
    violations.push("evidence bundle is missing its `sections` map");
  }
  if (bundle.manifest == null || typeof bundle.manifest !== "object") {
    violations.push("evidence bundle is missing its `manifest`");
  }
  const manifestNames = new Set(
    bundle.manifest && Array.isArray(bundle.manifest.sections)
      ? bundle.manifest.sections.map((s) => s && s.name)
      : [],
  );
  for (const name of REQUIRED_SECTIONS) {
    if (!bundle.sections || !(name in bundle.sections)) {
      violations.push(`evidence bundle is missing the required "${name}" section`);
    }
    if (!manifestNames.has(name)) {
      violations.push(`evidence bundle manifest does not index the required "${name}" section`);
    }
  }
  return violations;
}
