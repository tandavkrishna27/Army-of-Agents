import { Router } from "express";
import type { Db } from "@armyofagents/db";
import type { CurrentUserProfile } from "@armyofagents/shared";
import { updateCurrentUserProfileSchema } from "@armyofagents/shared";
import { unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { userProfileService } from "../services/index.js";
import type { UserProfileRecord } from "../services/user-profile.js";
import { canManageInstanceSettings } from "./authz.js";

// In local_trusted deployments the actor is a synthetic "local-board" user that
// has no row in the `user` table, so DB lookup would 401. Return a fixed
// profile for that case; persistence (PATCH) still requires a real user.
function localImplicitProfile(userId: string): UserProfileRecord {
  return {
    id: userId,
    email: null,
    displayName: "Local Board",
    avatarUrl: null,
  };
}

export function authProfileRoutes(db: Db) {
  const router = Router();
  const service = userProfileService(db);

  async function loadActingUser(userId: string, source: string | undefined) {
    if (source === "local_implicit") return localImplicitProfile(userId);
    return service.load(userId);
  }

  router.get("/auth/get-session", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const user = await loadActingUser(req.actor.userId, req.actor.source);
    res.json({
      session: {
        id: `aoa:${req.actor.source ?? "none"}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user: {
        id: user.id,
        email: user.email,
        name: user.displayName,
      },
    });
  });

  router.get("/auth/profile", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const mayManageInstanceSettings = canManageInstanceSettings(req);
    const profile: CurrentUserProfile = {
      ...(await loadActingUser(req.actor.userId, req.actor.source)),
      // Same source of truth as assertCanManageInstanceSettings — the auth
      // middleware computed this from instance_user_roles.
      canManageInstanceSettings: mayManageInstanceSettings,
      isInstanceAdmin: mayManageInstanceSettings,
    };
    res.json(profile);
  });

  router.patch(
    "/auth/profile",
    validate(updateCurrentUserProfileSchema),
    async (req, res) => {
      if (req.actor.type !== "board" || !req.actor.userId) {
        throw unauthorized("Board authentication required");
      }
      if (req.actor.source === "local_implicit") {
        throw unauthorized("Cannot edit profile for the local board user");
      }

      // Include the flag here too — the UI writes the PATCH response into the
      // profile query cache (Me.tsx setQueryData), so dropping it would make
      // an admin's instance-Settings chrome disappear after a profile save.
      const mayManageInstanceSettings = canManageInstanceSettings(req);
      const profile: CurrentUserProfile = {
        ...(await service.update(req.actor.userId, req.body)),
        canManageInstanceSettings: mayManageInstanceSettings,
        isInstanceAdmin: mayManageInstanceSettings,
      };
      res.json(profile);
    },
  );

  return router;
}
