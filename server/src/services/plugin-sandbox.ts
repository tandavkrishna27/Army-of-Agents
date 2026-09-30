import path from "node:path";
import os from "node:os";
import type { PluginCapability, PluginTrustTier } from "@armyofagents/shared";

export interface SandboxOptions {
  pluginId: string;
  trustTier: PluginTrustTier;
  capabilities: PluginCapability[];
  /**
   * Absolute path to the plugin's resolved package directory (where the worker
   * entrypoint and the plugin's own `node_modules` live). When provided, the
   * sandbox scopes `--allow-fs-read` to this directory (plus the scratch dir and
   * the instance plugins root) instead of granting full host read (`*`).
   *
   * When omitted, fs-read falls back to the instance plugins root — still NOT
   * `*` — because the package dir could not be resolved by the caller.
   */
  packageDir?: string;
}

/** Instance-wide plugins root: `~/.aoa/plugins`. */
export function pluginsRootDir(): string {
  return path.join(os.homedir(), ".aoa", "plugins");
}

export function buildSandboxExecArgv(opts: SandboxOptions): string[] {
  const { pluginId, trustTier, capabilities, packageDir } = opts;

  if (trustTier === "core") {
    return [];
  }

  const scratchDir = pluginScratchDir(pluginId);
  // os.tmpdir() is needed for tsx's compile cache when workers are TypeScript.
  // Node v24+ requires separate --allow-fs-write flags per path (comma lists removed).
  const tmpDir = os.tmpdir();

  // fs-read scoping (was `--allow-fs-read=*`, full host read).
  //
  // We scope reads to the minimum set Node needs to BOOT and run the plugin
  // worker: the plugin's own package dir (worker entry + bundled deps), its
  // scratch dir, and the instance plugins root (`~/.aoa/plugins`) which holds
  // the hoisted `node_modules` that npm-installed plugins import and every
  // plugin's scratch subtree. The plugins root is a strict subset of the host
  // filesystem — it does NOT expose the host's source tree, secrets, or the
  // rest of the user's home directory.
  //
  // The plugins root is included unconditionally because Node resolves a
  // plugin's runtime dependencies from the hoisted `~/.aoa/plugins/node_modules`
  // tree; scoping reads to the package dir alone breaks module loading for
  // npm-installed plugins. If `packageDir` is unknown (caller could not resolve
  // it) we still fall back to the plugins root — never to `*`.
  const readDirs = new Set<string>([pluginsRootDir(), scratchDir]);
  if (packageDir) {
    readDirs.add(path.resolve(packageDir));
  }

  const args: string[] = [
    "--permission",
    ...Array.from(readDirs).map((dir) => `--allow-fs-read=${dir}`),
    `--allow-fs-write=${scratchDir}`,
    `--allow-fs-write=${tmpDir}`,
    "--allow-worker",    // plugins may use Worker threads internally
  ];

  // Node.js --permission model does not have a --allow-net flag (that's Deno).
  // Network egress is UNRESTRICTED in the Node permission model: raw
  // `node:https` / `node:net` / global `fetch` bypass the `http.outbound`
  // capability + SSRF guard, which only constrain the SDK `ctx.http.fetch`
  // helper. No trust tier provides a network-egress boundary; real egress
  // control requires OS-level isolation (network namespace / seccomp / proxy),
  // tracked as separate infra work. See decisions.md Decision #103.
  void capabilities;

  return args;
}

export function pluginScratchDir(pluginId: string): string {
  return path.join(os.homedir(), ".aoa", "plugins", pluginId, "scratch");
}
