// Public surface of the provider-capability leaf (DEP-011 Slice 1 · packaging §1.2.0).
// The PURE owned-labels-capability primitive — schema + shared canonical + mint — with a
// node:crypto-only runtime closure, so the control-plane image can import the mint without
// dragging the worker daemon / e2b provider into its runtime.

export {
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  buildOwnedLabelsCapabilityCanonical,
  signOwnedLabelsCapability,
} from "./capability.js";
export type { OwnedLabelsCapability, OwnedLabelsCapabilitySignedFields } from "./capability.js";
