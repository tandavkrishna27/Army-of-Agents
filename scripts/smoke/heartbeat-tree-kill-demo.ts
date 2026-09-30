// scripts/smoke/heartbeat-tree-kill-demo.ts
//
// Standalone visual smoke for the Issue #96 fix. Run by hand from repo root:
//
//   pnpm --filter @armyofagents/server exec -- tsx ../scripts/smoke/heartbeat-tree-kill-demo.ts
//
// What it does:
//   1. Spawn a small parent script (bash on POSIX, cmd on Windows).
//   2. The parent spawns a long-running child and prints PIDs.
//   3. We wait 2s for the tree to be alive.
//   4. We call signalRunningProcess() to kill the parent's group.
//   5. We poll for 5s, reporting which PIDs died and which survived.
//   6. Best-effort cleanup at the end.
//
// On POSIX: parent + child should both die within ~1s of the signal.
// On Windows: parent dies; child becomes an orphan (known limitation).

import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveProcessGroupId,
  signalRunningProcess,
} from "../../packages/adapter-utils/src/server-utils.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`platform: ${process.platform}`);
  console.log(`node:     ${process.version}`);
  console.log("");

  const dir = await mkdtemp(join(tmpdir(), "aoa-tree-kill-demo-"));
  const onPosix = process.platform !== "win32";

  const fixtureName = onPosix ? "spawn-child.sh" : "spawn-child.cmd";
  const fixturePath = join(dir, fixtureName);
  const childPidFile = join(dir, "child.pid");

  if (onPosix) {
    await writeFile(
      fixturePath,
      [
        "#!/bin/bash",
        "set -e",
        "sleep 60 &",
        'echo "$!" > "' + childPidFile + '"',
        "wait",
      ].join("\n"),
      { mode: 0o755 },
    );
  } else {
    // On Windows, use PowerShell to start ping with Start-Process -PassThru
    // so we get its PID directly, then wait for it to exit.
    await writeFile(
      fixturePath,
      [
        "@echo off",
        "powershell -NoProfile -Command \"$p = Start-Process -FilePath 'ping.exe' -ArgumentList '-n','60','127.0.0.1' -PassThru -WindowStyle Hidden; $p.Id | Out-File -FilePath '" +
          childPidFile.replace(/\\/g, "\\\\") +
          "' -Encoding ASCII; $p.WaitForExit()\"",
      ].join("\r\n"),
    );
  }

  const child = onPosix
    ? spawn("/bin/bash", [fixturePath], { detached: true, stdio: "ignore" })
    : spawn("cmd.exe", ["/c", fixturePath], { stdio: "ignore" });

  console.log(`spawned parent: pid=${child.pid}`);

  const processGroupId = resolveProcessGroupId(child);
  console.log(`processGroupId: ${processGroupId}`);
  console.log("");

  // Wait for the child PID to be written.
  console.log("waiting up to 5s for grandchild PID file...");
  const grandchildPid = await new Promise<number | null>((resolve) => {
    const deadline = Date.now() + 5000;
    const tick = async () => {
      if (Date.now() > deadline) return resolve(null);
      try {
        const { readFile } = await import("node:fs/promises");
        const raw = (await readFile(childPidFile, "utf-8")).trim();
        const pid = Number.parseInt(raw, 10);
        if (Number.isInteger(pid) && pid > 0) return resolve(pid);
      } catch {
        // not yet
      }
      setTimeout(tick, 100);
    };
    tick();
  });

  if (grandchildPid === null) {
    console.error("ERROR: grandchild PID file never appeared");
    process.exit(1);
  }
  console.log(`grandchild pid: ${grandchildPid}`);
  console.log("");

  console.log(`parent alive:     ${isAlive(child.pid!)}`);
  console.log(`grandchild alive: ${isAlive(grandchildPid)}`);
  console.log("");

  console.log("calling signalRunningProcess(SIGTERM)...");
  signalRunningProcess({ child, processGroupId }, "SIGTERM");
  console.log("");

  // Poll for 5s, log progress.
  const POLL_MS = 250;
  const POLL_DEADLINE = Date.now() + 5000;
  while (Date.now() < POLL_DEADLINE) {
    const parentAlive = child.pid ? isAlive(child.pid) : false;
    const grandchildAlive = isAlive(grandchildPid);
    if (!parentAlive && !grandchildAlive) {
      console.log("[OK] both parent and grandchild are dead");
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Final report.
  console.log("");
  console.log("=== final state ===");
  console.log(`parent (${child.pid}):     ${isAlive(child.pid!) ? "ALIVE (LEAK)" : "DEAD [OK]"}`);
  console.log(`grandchild (${grandchildPid}): ${isAlive(grandchildPid) ? "ALIVE (LEAK)" : "DEAD [OK]"}`);
  console.log("");

  if (!onPosix && isAlive(grandchildPid)) {
    console.log("Windows note: grandchild leak is the documented limitation.");
    console.log("    signalRunningProcess uses child.kill on Windows (no process-group");
    console.log("    semantics). To kill the tree, AoA would need taskkill /T /F.");
  }

  // Best-effort cleanup.
  try {
    if (child.pid && isAlive(child.pid)) {
      if (onPosix) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    }
    if (isAlive(grandchildPid)) {
      process.kill(grandchildPid, "SIGKILL");
    }
  } catch {
    // ignore
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
