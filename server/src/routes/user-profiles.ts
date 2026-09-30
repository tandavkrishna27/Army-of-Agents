import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@armyofagents/db";
import { humanSocialLinkSchema } from "@armyofagents/shared";
import {
  getUserProfile,
  upsertUserProfile,
  type UserProfileInput,
} from "../services/user-profiles.js";

/** Own global profile (Stage C / C1-C3). Board-scoped, self-only. */
export function userProfileRoutes(db: Db): Router {
  const router = Router();

  router.get("/user-profile", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    res.json({ profile: await getUserProfile(db, actor.userId) });
  });

  router.patch("/user-profile", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: UserProfileInput = {};
    if (typeof body.displayName === "string" || body.displayName === null) {
      input.displayName = body.displayName;
    }
    if (typeof body.avatarUrl === "string" || body.avatarUrl === null) {
      input.avatarUrl = body.avatarUrl;
    }
    if (typeof body.title === "string" || body.title === null) input.title = body.title;
    if (typeof body.bio === "string" || body.bio === null) input.bio = body.bio;
    if (typeof body.timezone === "string" || body.timezone === null) input.timezone = body.timezone;
    // Per-item validation with the shared schema (N4 follow-up): the old
    // Array.isArray-only check let a malformed link (e.g. "https://not a url")
    // be stored, only to be silently dropped later by
    // materializeCompanyProfileFromGlobal — the user was told "saved" while the
    // link vanished. Reject malformed links up front so the client surfaces the
    // 400 instead. Defense-in-depth: the client validates with the same schema.
    if (body.socialLinks !== undefined) {
      const parsed = z.array(humanSocialLinkSchema).safeParse(body.socialLinks);
      if (!parsed.success) {
        res.status(400).json({ error: "Validation error", details: parsed.error.errors });
        return;
      }
      input.socialLinks = parsed.data;
    }

    const profile = await upsertUserProfile(db, actor.userId, input);
    res.json({ profile });
  });

  return router;
}
