// -----------------------------------------------------------------------------
// DEP-011 Slice 1 · packaging (§1.2.0) — RE-HOME shim.
//
// The owned-labels-capability primitive (schema + shared canonical + mint) was
// EXTRACTED to the leaf `@armyofagents/provider-capability` so the control-plane
// image can import the mint without dragging the worker daemon / e2b provider into
// its runtime closure. This module now RE-EXPORTS the leaf VERBATIM, so every
// existing `@armyofagents/provider-wire/capability` (and barrel) consumer keeps its
// import unchanged and the ONE shared `buildOwnedLabelsCapabilityCanonical` is
// preserved (mint and verify both resolve to the same function object — no drift).
// -----------------------------------------------------------------------------

export {
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  buildOwnedLabelsCapabilityCanonical,
  signOwnedLabelsCapability,
} from "@armyofagents/provider-capability";
export type {
  OwnedLabelsCapability,
  OwnedLabelsCapabilitySignedFields,
} from "@armyofagents/provider-capability";
