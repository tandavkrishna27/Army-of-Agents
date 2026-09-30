import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { assertRole } from "../middleware/rbac.js";
import { assertCompanyAccess } from "./authz.js";
import { buildCommanderLoginService } from "../services/commander-login-runtime.js";
import { LoginChallengeConflictError, type CommanderLoginProvider } from "../services/commander-login.js";
import { loadConfig } from "../config.js";
import {
  providerSubscriptionCapability,
  resolveCliAuthTopology,
  detectProviderCli,
} from "../services/cli-auth-topology.js";

/**
 * Interactive CLI-login routes (Plan 3 / §6.2 Task 4). Founder-scoped: an
 * EXPLICIT board-actor check precedes assertRole (agents bypass assertRole —
 * Codex #10), then `assertRole("founder")`. `start` spawns `claude login` /
 * `codex login` and returns the verification URL for the founder to open; the
 * UI polls `status` and, on `completed`, re-runs the Commander probe.
 */
export function commanderLoginRoutes(db: Db): Router {
  const router = Router();
  const service = buildCommanderLoginService(db);

  async function gate(req: Request, res: Response, companyId: string): Promise<boolean> {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return false;
    }
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");
    return true;
  }

  async function capabilities() {
    const config = loadConfig();
    const topology = resolveCliAuthTopology({
      deploymentMode: config.deploymentMode,
      deploymentExposure: config.deploymentExposure,
    });
    const cli =
      process.env.NODE_ENV === "test"
        ? {
            openai: { cliInstalled: true, cliVersion: "0.145.0", cliVersionSupported: true },
            anthropic: { cliInstalled: true, cliVersion: "2.1.220", cliVersionSupported: true },
          }
        : {
            openai: await detectProviderCli("openai"),
            anthropic: await detectProviderCli("anthropic"),
          };
    const providerCapability = (provider: CommanderLoginProvider) => {
      const policy = providerSubscriptionCapability(provider, topology);
      const detected = cli[provider];
      if (!detected.cliInstalled) {
        return {
          ...policy,
          ...detected,
          enabled: false,
          reason: `${provider === "openai" ? "Codex" : "Claude"} CLI is not installed in the AOA runtime.`,
        };
      }
      if (!detected.cliVersionSupported) {
        return {
          ...policy,
          ...detected,
          enabled: false,
          reason: `Installed ${provider === "openai" ? "Codex" : "Claude"} version is unsupported by this AOA image. Rebuild with the pinned CLI version.`,
        };
      }
      return { ...policy, ...detected };
    };
    return {
      topology,
      providers: {
        openai: providerCapability("openai"),
        anthropic: providerCapability("anthropic"),
      },
    };
  }

  router.get(
    "/companies/:companyId/internal-agent/commander-login/capabilities",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      if (!(await gate(req, res, companyId))) return;
      try {
        res.json(await capabilities());
      } catch (error) {
        res.status(503).json({
          code: "invalid_cli_auth_topology",
          error: error instanceof Error ? error.message : "CLI authentication topology is invalid.",
        });
      }
    },
  );

  router.post(
    "/companies/:companyId/internal-agent/commander-login/start",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      if (!(await gate(req, res, companyId))) return;

      const provider = req.body?.provider as CommanderLoginProvider;
      if (provider !== "anthropic" && provider !== "openai") {
        res.status(400).json({ error: "provider must be 'anthropic' or 'openai'" });
        return;
      }

      try {
        const capability = (await capabilities()).providers[provider];
        if (!capability.enabled) {
          res.status(403).json({
            code: "subscription_auth_disabled",
            error: capability.reason,
            capability,
          });
          return;
        }
        const { challengeId, loginUrl, userCode, expiresAt } = await service.startChallenge({
          companyId,
          provider,
          startedByUserId: req.actor.userId!,
          executionTargetId: process.env.AOA_EXECUTION_TARGET_ID ?? "control-plane",
        });
        res.json({
          challengeId,
          loginUrl,
          mode: capability.mode,
          userCode,
          expiresAt,
        });
      } catch (err) {
        if (err instanceof LoginChallengeConflictError) {
          res.status(409).json({ error: err.message });
          return;
        }
        res.status(502).json({ error: "login could not start (no verification URL)" });
      }
    },
  );

  router.post(
    "/companies/:companyId/internal-agent/commander-login/:id/code",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      if (!(await gate(req, res, companyId))) return;

      const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
      if (!code) {
        res.status(400).json({ error: "code is required" });
        return;
      }
      if (code.length > 4096) {
        res.status(413).json({ error: "code is too long" });
        return;
      }

      // NB: never log `code` — it exchanges for a live credential.
      const result = service.submitCode(
        companyId,
        req.params.id as string,
        code,
        req.actor.userId,
      );
      if (result === "not-live") {
        res.status(404).json({
          error: "This sign-in session is no longer active. Start sign-in again.",
        });
        return;
      }
      if (result === "write-failed") {
        res.status(410).json({
          error: "The sign-in process has exited. Start sign-in again.",
        });
        return;
      }
      if (result === "unsupported") {
        res.status(409).json({
          error: "This provider completes sign-in in the browser and does not take a pasted code.",
        });
        return;
      }
      res.status(202).json({ ok: true });
    },
  );

  router.get(
    "/companies/:companyId/internal-agent/commander-login/:id",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      if (!(await gate(req, res, companyId))) return;
      // Company-scoped lookup (Codex P1) — another tenant's challenge id 404s
      // instead of leaking its status/loginUrl.
      const status = await service.getStatus(
        companyId,
        req.params.id as string,
        null,
        req.actor.userId,
      );
      if (!status) {
        res.status(404).json({ error: "challenge not found" });
        return;
      }
      res.json(status);
    },
  );

  router.post(
    "/companies/:companyId/internal-agent/commander-login/:id/cancel",
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      if (!(await gate(req, res, companyId))) return;
      // Company-scoped (Codex P1) — a cross-tenant cancel is a silent no-op,
      // never terminating another company's login child.
      await service.cancel(companyId, req.params.id as string, null, req.actor.userId);
      res.json({ ok: true });
    },
  );

  return router;
}
