/**
 * E0-F013 Decision 3.2 (slice 2) — the COARSE source key for the tenant-less
 * upgrade-denial bound must be the request's real CLIENT IP, resolved under the
 * configured trust-proxy policy EXACTLY as Express `req.ip` is, and NEVER the
 * proxy's socket address.
 *
 * ★ THE DEFECT (Codex P2). The WS upgrade runs on the raw Node `req`, and the
 * source key was `req.socket.remoteAddress`. Behind Cloudflare/ALB/nginx that is
 * the PROXY's address — identical for every client — so every WS denial from
 * every caller collapsed into ONE per-surface bucket and a single prober consumed
 * the whole per-source allowance for everyone. This proves the source key now
 * follows the trusted-proxy client IP, while an UNTRUSTED `X-Forwarded-For` is
 * ignored (else an attacker could forge the key and evade the per-source cap).
 */
import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import { upgradeSourceKey } from "../realtime/live-events-ws.js";

/** Minimal raw-request stub: only the fields `proxy-addr`/`forwarded` read. */
function req(opts: {
  socket?: string;
  xff?: string;
}): IncomingMessage {
  return {
    headers: opts.xff ? { "x-forwarded-for": opts.xff } : {},
    socket: opts.socket ? { remoteAddress: opts.socket } : undefined,
  } as unknown as IncomingMessage;
}

describe("upgradeSourceKey — trust-proxy-aware client IP (E0-F013 Decision 3.2 / Codex P2)", () => {
  it("★ NO TRUSTED PROXY (false): keys on the socket address and IGNORES a spoofed X-Forwarded-For", () => {
    // The attacker sets X-Forwarded-For to forge a fresh source key. With no
    // trusted proxy configured it MUST be ignored — the key stays the socket IP.
    expect(
      upgradeSourceKey(req({ socket: "198.51.100.9", xff: "1.2.3.4" }), false),
    ).toBe("198.51.100.9");
  });

  it("★ DEFAULT (unset/undefined trustProxy) behaves like `false` — spoofed XFF ignored", () => {
    expect(
      upgradeSourceKey(req({ socket: "198.51.100.9", xff: "1.2.3.4" }), undefined),
    ).toBe("198.51.100.9");
  });

  it("★ TRUST PROXY = true: keys on the X-Forwarded-For CLIENT, not the proxy socket address", () => {
    // Socket is the proxy; XFF carries the original client. Under trust=true we
    // must return the client (leftmost), not the proxy — that is the whole fix.
    expect(
      upgradeSourceKey(
        req({ socket: "10.0.0.9", xff: "203.0.113.7, 10.0.0.9" }),
        true,
      ),
    ).toBe("203.0.113.7");
  });

  it("★ TWO CLIENTS behind the SAME proxy get DISTINCT keys (they no longer collapse into one bucket)", () => {
    const proxy = "10.0.0.9";
    const a = upgradeSourceKey(req({ socket: proxy, xff: `203.0.113.7, ${proxy}` }), true);
    const b = upgradeSourceKey(req({ socket: proxy, xff: `203.0.113.8, ${proxy}` }), true);
    expect(a).toBe("203.0.113.7");
    expect(b).toBe("203.0.113.8");
    expect(a).not.toBe(b); // the per-source cap is now actually per-source
  });

  it("★ HOP COUNT (trust 1 hop): forged LEFT X-Forwarded-For entries are NOT trusted", () => {
    // Only the hop nearest the socket is trusted. An attacker prepending
    // `6.6.6.6` cannot rotate the key past the real edge address.
    expect(
      upgradeSourceKey(
        req({ socket: "10.0.0.9", xff: "6.6.6.6, 203.0.113.7" }),
        1,
      ),
    ).toBe("203.0.113.7");
  });

  it("CIDR trust list: resolves the first address outside the trusted subnets", () => {
    expect(
      upgradeSourceKey(
        req({ socket: "10.0.0.9", xff: "203.0.113.7, 10.0.0.5" }),
        ["10.0.0.0/8"],
      ),
    ).toBe("203.0.113.7");
  });

  it("no socket and no header → null (shares the strongest single per-surface bucket)", () => {
    // `forwarded` throws when neither req.socket nor req.connection exists; the
    // resolver must swallow that and fall back — the deny path must never break.
    expect(upgradeSourceKey(req({}), false)).toBeNull();
    expect(upgradeSourceKey(req({}), true)).toBeNull();
  });

  it("a malformed trust-proxy CIDR never throws — it falls back to the socket address", () => {
    // Defensive: a bad trust setting must not turn a refusal into a 500 or defeat
    // the bound. proxy-addr's compile throws on an invalid CIDR; we swallow it.
    expect(
      upgradeSourceKey(req({ socket: "198.51.100.9", xff: "1.2.3.4" }), [
        "not-a-cidr",
      ]),
    ).toBe("198.51.100.9");
  });
});
