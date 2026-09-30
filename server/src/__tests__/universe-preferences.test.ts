import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UNIVERSE_PREFERENCES } from "@armyofagents/shared";
import { errorHandler } from "../middleware/index.js";
import { universePreferenceRoutes } from "../routes/universe-preferences.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "55555555-5555-5555-5555-555555555555";
const snapshot = {schemaVersion:1 as const,revision:0,overrides:{},effective:DEFAULT_UNIVERSE_PREFERENCES,unavailableFields:{}};
const service = vi.hoisted(() => ({get:vi.fn(),patch:vi.fn(),reset:vi.fn()}));
vi.mock("../services/universe-preferences.js", () => ({
  UniversePreferencesConflictError: class extends Error { constructor(readonly latest: unknown) { super("conflict"); } },
  universePreferencesService: () => service,
}));
function app(companyIds=[COMPANY_A]) {
  const value=express(); value.use(express.json()); value.use((req,_res,next)=>{(req as never as {actor:unknown}).actor={type:"board",userId:"user-1",source:"session",companyIds};next();});
  value.use("/api",universePreferenceRoutes({} as never)); value.use(errorHandler); return value;
}
describe("Universe preference routes",()=>{
  beforeEach(()=>{vi.clearAllMocks();service.get.mockResolvedValue(snapshot);service.patch.mockResolvedValue({...snapshot,revision:1});service.reset.mockResolvedValue({...snapshot,revision:2});});
  it("returns defaults without creating a row",async()=>{
    const response=await request(app()).get(`/api/companies/${COMPANY_A}/universe/preferences/me`);
    expect(response.status).toBe(200); expect(response.body.revision).toBe(0); expect(service.get).toHaveBeenCalledWith(COMPANY_A,"user-1");
  });
  it("rejects unknown and empty patches before mutation",async()=>{
    await request(app()).patch(`/api/companies/${COMPANY_A}/universe/preferences/me`).send({schemaVersion:1,baseRevision:0,patch:{future:true}}).expect(400);
    await request(app()).patch(`/api/companies/${COMPANY_A}/universe/preferences/me`).send({schemaVersion:1,baseRevision:0,patch:{}}).expect(400);
    expect(service.patch).not.toHaveBeenCalled();
  });
  it("passes only authenticated identity and denies another company",async()=>{
    await request(app()).patch(`/api/companies/${COMPANY_A}/universe/preferences/me`).send({schemaVersion:1,baseRevision:0,patch:{motion:"reduced"}}).expect(200);
    expect(service.patch).toHaveBeenCalledWith(COMPANY_A,"user-1",expect.objectContaining({patch:{motion:"reduced"}}));
    await request(app([COMPANY_B])).get(`/api/companies/${COMPANY_A}/universe/preferences/me`).expect(403);
  });
});
