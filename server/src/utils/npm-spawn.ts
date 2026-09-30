import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecNpmOptions {
  cwd?: string;
  timeoutMs?: number;
}

// On Windows, Node ≥ 18.20.2 / 20.12.2 / 21.7.2 refuses to spawn `.cmd` files
// without `shell: true` (CVE-2024-27980), and `shell: true` would re-introduce
// shell injection on user-controlled package specs. Spawning `node.exe` with
// the bundled `npm-cli.js` is a real `.exe` + a JS file: no shell, no EINVAL,
// no injection. Falls back to `npm` if `npm-cli.js` is not at the expected
// location next to `process.execPath` (e.g. some non-default Node installs).
export async function execNpm(args: string[], opts: ExecNpmOptions = {}): Promise<void> {
  const timeout = opts.timeoutMs ?? 120_000;
  if (process.platform === "win32") {
    const npmCli = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (existsSync(npmCli)) {
      await execFileAsync(process.execPath, [npmCli, ...args], { cwd: opts.cwd, timeout });
      return;
    }
  }
  await execFileAsync("npm", args, { cwd: opts.cwd, timeout });
}
