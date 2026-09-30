// packages/worker-networked-host/src/bin/networked-host.ts
//
// DEP-011 Slice 2b-ii — the CONTAINER networked-provider boot root.
//
// The outside composition root for a container worker that dispatches through the gated
// adapter-manager wire. It reuses `worker-daemon`'s `runContainerHost` custody path (the
// `file_record` state-dir probe + the `FileRecordStore` wiring) via that host's injectable
// `bootstrap` seam, wrapping it to add the per-run `makeRunProvider` factory — WITHOUT
// worker-daemon ever importing a provider (E4-D01: the daemon defines the `SandboxProvider`
// port and implements it zero times, and the networked driver lives out here too).
//
// ★ SHIPS INERT (DEP-011 §2b). Nothing runs this bin: no image CMD points at it, no staging
// service sets `AOA_WORKER_PROVIDER_URL`, and the container-worker dispatch flag stays OFF (the
// image home + the go-live flag flip are Slice 5). The default boot (URL unset) resolves to
// `{kind:"none"}` and boots exactly as the inert `container-host` default — refusing
// `no_provider`. This file NAMES `bootstrapWorkerDaemon` (the boot-roots scan key) inside the
// url-path injector; the boot-roots guard reads the shipped default off `resolve-provider-url.ts`.

import process from "node:process";
import { pathToFileURL } from "node:url";

import { bootstrapWorkerDaemon, runContainerHost } from "@armyofagents/worker-daemon";

import { makeNetworkedRunProvider } from "../make-run-provider.js";
import { resolveProviderUrl } from "../resolve-provider-url.js";

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const resolution = resolveProviderUrl(process.env);
  // When a URL is set, wrap the container host's bootstrap seam to inject the per-run factory.
  // When it is unset ({kind:"none"}), boot with the default bootstrap — inert `no_provider`,
  // byte-identical to the shipped `container-host` default.
  runContainerHost(
    resolution.kind === "url"
      ? {
          env: process.env,
          proc: process,
          bootstrap: (d) =>
            bootstrapWorkerDaemon({ ...d, makeRunProvider: makeNetworkedRunProvider(resolution.url) }),
        }
      : { env: process.env, proc: process },
  )
    .then((result) => {
      if (!result.ok) process.exit(1);
    })
    .catch((err: unknown) => {
      // Mirror the container host's last-line redaction is unnecessary here (this file reads no
      // enrolment ticket), but a bare stack must still not escape unlogged.
      const detail = err instanceof Error && err.stack ? err.stack : String(err);
      console.error(detail);
      process.exit(1);
    });
}
