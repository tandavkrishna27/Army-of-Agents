// @armyofagents/worker-networked-host — the CONTAINER composition root that supplies the
// per-run networked `makeRunProvider` factory (DEP-011 Slice 2b-ii).
//
// A LEAF consumer: it depends on `@armyofagents/worker-daemon` (the bootstrap + container host
// + the `MakeRunProvider` type + the `SandboxProvider` port) and `@armyofagents/provider-wire`
// (the `NetworkedProviderDriver` + the pinned capability version/audience). Nothing depends on
// it, so it cannot introduce a `pnpm -r build` cycle. Ships INERT: no image runs its bin yet
// (the image home + go-live are Slice 5).

export { PROVIDER_URL_ENV, resolveProviderUrl } from "./resolve-provider-url.js";
export type { ProviderUrlResolution } from "./resolve-provider-url.js";

export { NetworkedProviderCapabilityError, makeNetworkedRunProvider } from "./make-run-provider.js";
