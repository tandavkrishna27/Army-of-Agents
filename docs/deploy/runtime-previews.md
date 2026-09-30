---
title: Runtime Previews
summary: Open agent-created apps through AoA-owned preview URLs
---

AoA runtime previews let users inspect a live app or dev server created inside an execution workspace without opening the raw `localhost` URL directly.

The product URL is:

```text
/preview/services/:serviceId/*
```

The raw upstream URL, such as `http://localhost:5173/`, is a local debug target only. It is local to the machine running AoA and is not a shareable product link.

## What Runtime Previews Do

Runtime preview URLs:

- Resolve only registered `workspace_runtime_services` rows.
- Verify the current AoA actor can access the service's company/workspace.
- Proxy only allowed loopback upstreams in this phase: `localhost`, `127.0.0.1`, and `::1`.
- Strip AoA cookies and sensitive auth headers before forwarding traffic upstream.
- Strip upstream `Set-Cookie` headers and apply a CSP sandbox to preview responses so path-based previews cannot write AoA-origin cookies or run as trusted AoA UI.
- Strip AoA query auth tokens before forwarding HTTP or WebSocket preview traffic upstream.
- Support normal HTTP traffic and WebSocket/HMR upgrade traffic.
- Refuse stopped, unavailable, unhealthy, unsafe, or cross-company services.
- Refuse `local_process` services owned by another control-plane replica before
  probing or proxying their loopback URL. Only the recorded process owner can
  health-check, stop, or proxy that local service.

Runtime preview URLs do not create a public share link. Public and guest access require a separate sharing layer.

## Deployment Modes

### Local Trusted

Use this for a single operator on one machine.

- AoA usually runs on `localhost`.
- Preview URLs work in the AoA browser/viewer on the same machine.
- Raw local targets may be shown as "Local to AoA host" for debugging.
- External sharing is disabled because there is no authenticated team boundary.

### Authenticated Private

Use this for a team on a private network such as Tailscale, VPN, or LAN.

- Users open AoA through the private AoA URL.
- Users should open `/preview/services/:serviceId/*`, not raw `localhost`.
- AoA enforces company access before proxying.
- Raw local targets still point to the AoA host machine and should not be copied as team links.

### Authenticated Public

Use this for internet-facing AoA deployments.

- Login is required.
- Preview URLs remain AoA-owned and access controlled.
- Do not expose arbitrary agent ports directly to the internet.
- For stronger isolation, production deployments should plan a future subdomain preview layer.

## UI Rules

Workspace service cards and center viewer browser tabs should use `previewUrl` as the primary open action.

The raw service `url` may be shown only as a subtle debug detail:

```text
Local to AoA host http://localhost:5173/
```

If a runtime service has no `previewUrl`, the UI should not show the main Open action. The service can still show status, health, and local debug information when useful.

Preview-only services discovered from agent output can be opened, but AoA cannot start, stop, or restart them because the agent owns that process.

Configured runtime services can show start, stop, or restart controls only when the current actor has runtime-control permission.

## Operator Limits

This phase intentionally keeps the preview proxy narrow:

- No public guest links.
- No arbitrary external URL proxying.
- No desktop relay or tunnel.
- No wildcard preview subdomains.
- No Docker/cloud sandbox runtime.
- No full multi-node runtime scheduler.

Local runtime-service orchestration is single-owner. A shared database may
contain rows from multiple replicas, but replicas deliberately leave foreign
process rows untouched; cross-replica routing is deferred to the isolated
worker runtime. Do not run local runtime services on multiple control-plane
replicas, and keep `AOA_ALLOW_UNSANDBOXED_MULTITENANT` disabled in production
`cloud_auth` deployments.

If an app needs public review, use a deployment provider such as Vercel, Netlify, Render, Fly, GitHub Pages, or a future AoA external preview resource. Do not treat the local runtime preview URL as a public deployment URL.

## Production Direction

For enterprise or cloud deployments, the long-term model should be:

```text
runtime service / artifact / deployment URL
  -> preview resource
  -> authenticated preview route
  -> optional isolated preview subdomain
```

A subdomain model such as:

```text
https://<preview-id>.preview.<aoa-domain>
```

is better for cookie, storage, service worker, and origin isolation, but it requires wildcard DNS, TLS, routing, tenancy controls, and sandboxed runtime infrastructure.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| Service shows no Open action | No safe AoA `previewUrl` is available | Check that the runtime service has a reachable loopback URL and is not unhealthy |
| Preview returns unavailable | Service is stopped, unhealthy, or no longer reachable | Refresh runtime services, restart configured service, or rerun the agent |
| Works on the AoA host but not another device | User copied raw `localhost` instead of the AoA preview URL | Open AoA from the second device and use `/preview/services/:serviceId/*` |
| WebSocket/HMR does not connect | App assumes a different origin or hard-codes a websocket host | Prefer relative HMR config or configure the app for proxied access |
| App breaks under `/preview/services/...` | App assumes it is mounted at `/` or needs same-origin browser storage/API access blocked by the preview sandbox | Use a base path-aware app config or deploy the app to an external preview URL |

## Verification Checklist

Before shipping preview infrastructure changes:

```sh
pnpm test:run -- server/src/__tests__/preview-url.test.ts server/src/__tests__/preview-proxy.test.ts server/src/__tests__/preview-proxy-ws.test.ts
pnpm test:run -- ui/src/__tests__/ServicesSection.test.tsx ui/src/__tests__/WorkspacePreviewPanel.test.tsx ui/src/__tests__/WorkspaceView.test.tsx
pnpm -r typecheck
```

Manual UAT:

1. Start AoA locally.
2. Create or run a workspace service that emits a loopback preview URL.
3. Confirm the service card opens the center viewer through `/preview/services/:serviceId/`.
4. Confirm the viewer iframe uses the AoA preview URL.
5. Confirm the raw `localhost` URL is shown only as "Local to AoA host."
6. Stop or break the service and confirm the UI stops offering the main Open action.
