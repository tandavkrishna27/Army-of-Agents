# gVisor Worker Image — Hardened Sandbox Spec

> ## ⚠️ STATUS: SPEC ONLY — NOT YET VALIDATED ON HARDWARE
>
> This document is the **specification** for the AoA cloud worker image and its
> gVisor (`runsc`) sandbox profile. It records the *intended* hardened flag set
> and egress-firewall policy so that Task 2 (`buildDockerRunArgs` hardening) and
> Task 6 (`resolveGvisorSandboxTarget` defaults) have a single source of truth to
> encode against.
>
> **Nothing in this document has been executed or verified on a live host.** The
> live `runsc` validation spike and the egress-firewall proof are a **PENDING
> Gate-B / deployment step** that has **not** been run. Specifically:
>
> - **Checkpoint A** (runsc present without KVM/nested virt) — **UNRUN**
> - **Checkpoint B** (pinned `claude` + `codex` CLIs run under `runsc`) — **UNRUN**
> - **Checkpoint C** (one-shot run survives the full hardened flag set; memory/pids
>   limits do not starve Node) — **UNRUN**
> - **Checkpoint D** (metadata + RFC1918 + control-plane unreachable while the
>   provider API is reachable on the filtered `bridge`) — **UNRUN**
>
> Do not treat any flag, version, or reachability claim below as confirmed. This
> is the design contract to validate, not a validation report. The go/no-go gate
> for the cloud pool remains **open** until checkpoints A–D pass on a real
> Hetzner worker and this banner is replaced with a dated validation record.

---

## Purpose

A pooled multi-tenant run must execute untrusted agent code without giving it a
route to the host, to peer tenants, to cloud metadata, or to the control plane.
The self-hosted single-tenant path is unchanged and does **not** use any of this:
the hardening is opt-in and default-OFF at every layer.

Two independent layers provide the isolation:

1. **Process/kernel isolation** — the `runsc` (gVisor) runtime plus a hardened
   `docker run` flag set (this doc, "Hardened flag set" below). Encoded as
   opt-in defaults by `resolveGvisorSandboxTarget` and emitted by
   `buildDockerRunArgs` in `packages/adapter-utils/src/execution-target.ts`.
2. **Egress isolation** — a host firewall on the container bridge (this doc,
   "Egress firewall policy" below). This lives in the **worker image**, NOT in
   the app layer. The app layer does not and must not filter egress.

`--add-host host.docker.internal:host-gateway` — historically emitted
unconditionally by `buildDockerRunArgs` — is a route to the control-plane host
(an SSRF vector). Task 2 makes it **conditional**: it is emitted only when the
callback bridge is actually running AND the target explicitly opts in via
`allowHostGateway`. That removes ONE route; it is **not** egress filtering and
does not by itself make a `bridge`-networked pool safe.

---

## Base image contents

The golden worker image (`aoa/agent-base:latest`) must contain:

- **Node.js** (LTS matching the server runtime).
- **`claude` CLI** pinned to **`2.1.x`** and **`codex` CLI** pinned to
  **`0.145.x`** — the versions the codebase pins in
  `server/src/services/cli-auth-topology.ts` (cited from source; **not**
  hardware-verified here).
- A non-root `agent` user (`uid:gid = 1000:1000`) whose `$HOME` is
  `/home/agent`. The CLI config directory must live on a writable tmpfs/bind,
  never on the read-only root filesystem.
- `runsc` installed and registered with `dockerd` as a named runtime (see
  "runsc install" below).

### runsc install (to be run + version-recorded during the spike — UNRUN)

```bash
# gVisor install (no nested virtualization required)
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc
sudo runsc install     # registers the runsc runtime with dockerd
sudo systemctl restart docker
docker info | grep -A3 Runtimes   # expect: Runtimes: ... runsc
```

**runsc version:** _to be recorded from `runsc --version` during the spike —
currently UNKNOWN / UNRUN._

---

## Hardened flag set (the contract Task 2 encodes)

This is the exact flag set that a pooled gVisor run is intended to launch with.
Task 2's `buildDockerRunArgs` emits each of these behind the opt-in
`runtime`/`isolation`/`allowHostGateway` profile; Task 6's
`resolveGvisorSandboxTarget` supplies these as the gVisor defaults.

```bash
docker run --rm --runtime=runsc \
  --user 1000:1000 \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /home/agent:rw,nosuid,size=256m \
  --memory 2g --memory-swap 2g \
  --cpus 2 \
  --pids-limit 512 \
  --ipc private \
  --network none \
  -e HOME=/home/agent \
  aoa/agent-base:latest <command...>
```

Flag-by-flag rationale:

| Flag | Purpose |
|------|---------|
| `--runtime=runsc` | Run under gVisor's user-space kernel, not the host kernel. |
| `--user 1000:1000` | Never run as root inside the container. |
| `--cap-drop=ALL` | Drop every Linux capability. |
| `--security-opt no-new-privileges` | Block setuid/privilege escalation. |
| `--security-opt seccomp=<path>` | Optional pinned seccomp profile (when a profile is shipped in the image). |
| `--read-only` | Root filesystem is immutable. |
| `--tmpfs /tmp:rw,noexec,nosuid,size=64m` | Writable, non-exec scratch. |
| `--tmpfs /home/agent:rw,nosuid,size=256m` | Writable `$HOME` for CLI config/state (required because root is read-only). |
| `--memory 2g --memory-swap 2g` | Hard memory cap, swap disabled (equal values). |
| `--cpus 2` | CPU quota. |
| `--pids-limit 512` | Fork-bomb guard. |
| `--ipc private` | No shared IPC namespace with host or peers. |
| `--network none` | **Default egress posture** — no network at all. |

`--network none` is the **safe default**. It is sufficient for runs that do not
need the provider API (e.g. a fully offline task). Runs that need the provider
API must switch to a **filtered** `bridge` (below) — and only then.

### Checkpoint-C write test (UNRUN)

```bash
docker run --rm --runtime=runsc \
  --user 1000:1000 --cap-drop=ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /home/agent:rw,nosuid,size=256m \
  --memory 2g --memory-swap 2g --cpus 2 --pids-limit 512 --ipc private \
  --network none \
  -e HOME=/home/agent \
  aoa/agent-base:latest bash -lc 'node -e "require(\"fs\").writeFileSync(process.env.HOME+\"/x\",\"ok\");console.log(\"write-ok\")"'
# expect: write-ok  (proves --read-only + tmpfs $HOME works)
```

---

## Egress firewall policy (M7 — HARD worker-image deliverable, PENDING)

`--network none` alone does not solve egress: a pooled run that needs the
provider API forces the operator onto `bridge`, and **plain `bridge` filters
nothing** — the container can reach `169.254.169.254` (cloud metadata), all of
RFC1918, and the control-plane host. Making `--add-host` conditional (Task 2)
removes ONE route; it is NOT egress filtering.

Therefore the worker image MUST apply a host firewall on the container bridge
(nftables/iptables on the `DOCKER-USER` chain, or an explicit egress proxy),
applied at boot, that:

- **DENY** RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local
  `169.254.0.0/16` (incl. `169.254.169.254` metadata), and the control-plane
  CIDR(s).
- **ALLOW** only the provider API hosts + package registries from the allowlist
  (default-deny otherwise, enforced via the egress proxy's allowlist).

```bash
# DOCKER-USER egress lockdown (applied on the worker image at boot)
iptables -I DOCKER-USER -d 169.254.0.0/16 -j DROP
iptables -I DOCKER-USER -d 10.0.0.0/8      -j DROP
iptables -I DOCKER-USER -d 172.16.0.0/12   -j DROP
iptables -I DOCKER-USER -d 192.168.0.0/16  -j DROP
iptables -I DOCKER-USER -d "$AOA_CONTROL_PLANE_CIDR" -j DROP
# ALLOW provider/registry hosts is enforced via the egress proxy's allowlist;
# default-deny everything else.
```

### Allowlist (provider API + package registries)

The egress proxy allowlist should include (at minimum) the provider API hosts
for the pinned CLIs plus the package registries the image needs at run time.
The concrete host list is finalized during the spike; the policy is
default-deny with an explicit allow for:

- Anthropic API host(s) used by the `claude` CLI.
- OpenAI API host(s) used by the `codex` CLI.
- npm registry (and any other registry the base image resolves against).

### Checkpoint-D proof (UNRUN)

Re-run the checkpoint-C container on the **filtered** `bridge` and assert:

- `claude -p "say hi"` succeeds (provider egress ALLOWED), AND
- `curl -sS --max-time 3 http://169.254.169.254/` times out / is refused
  (metadata DENIED).

**GO/NO-GO checkpoint D:** metadata + RFC1918 + control-plane are unreachable
while the provider API is reachable. Until this firewall ships and this proof
passes, a cloud pool on `bridge` is **unshippable** — this spec makes **no**
egress-protection claim for `bridge` without it.

---

## Residual (state it plainly)

- `--network none` is the **safe default**.
- `bridge` is permitted for a pooled run **ONLY** with the worker-image egress
  firewall applied and checkpoint D passing.
- The **app layer does NOT filter egress** — the **worker image does**.
- Making `--add-host` conditional (Task 2) closes the host-gateway SSRF route; it
  is not a substitute for the egress firewall.

## Fallback

If checkpoint B fails for an adapter (a pinned CLI dies on an unimplemented
gVisor syscall), route that adapter to **E2B** on the pool and record the
specific syscall gap here. This does not block the other adapters.
