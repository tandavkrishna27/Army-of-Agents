import { describe, expect, it } from "vitest";
import {
  USER_ENTITY_FOLLOW_TYPES,
  createUserEntityFollowSchema,
} from "../user-entity-follows.js";

describe("user entity follow contract", () => {
  it("accepts only V1 task, project, and goal references", () => {
    expect(USER_ENTITY_FOLLOW_TYPES).toEqual(["task", "project", "goal"]);
    const entityId = "5b095ab8-92ea-41f5-8289-3f1cf38b851f";
    for (const entityType of USER_ENTITY_FOLLOW_TYPES) {
      expect(createUserEntityFollowSchema.parse({ entityType, entityId })).toEqual({
        entityType,
        entityId,
      });
    }
    expect(() => createUserEntityFollowSchema.parse({ entityType: "artifact", entityId })).toThrow();
    expect(() => createUserEntityFollowSchema.parse({ entityType: "task", entityId: "not-a-uuid" })).toThrow();
  });
});
