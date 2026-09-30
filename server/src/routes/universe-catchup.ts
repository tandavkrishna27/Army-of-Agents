import {Router,type Request} from "express";
import type {Db} from "@armyofagents/db";
import type {UserRole} from "@armyofagents/shared";
import {unauthorized} from "../errors.js";
import {permissionService} from "../services/permissions.js";
import {universeCatchupService} from "../services/universe-catchup.js";
import {assertBoard,assertCompanyAccess} from "./authz.js";

function boardUser(req:Request){
  // rbac: paired-via-helper
  assertBoard(req);if(req.actor.type!=="board"||!req.actor.userId)throw unauthorized("Board authentication required");return req.actor.userId;}
function implicitFounder(req:Request){return req.actor.type==="board"&&(req.actor.source==="local_implicit"||req.actor.isInstanceAdmin===true);}

export function universeCatchupRoutes(db:Db,options:{service?:Pick<ReturnType<typeof universeCatchupService>,"get">}={}){
  const router=Router(),service=options.service??universeCatchupService(db),permissions=permissionService(db);
  router.get("/companies/:companyId/universe/conversations/:conversationId/snapshot",async(req,res)=>{
    const companyId=req.params.companyId as string;await assertCompanyAccess(db,req,companyId);
    const userId=boardUser(req);const role:UserRole=implicitFounder(req)?"founder":await permissions.getEffectiveRole(companyId,userId);
    res.setHeader("cache-control","no-store");
    res.json(await service.get({companyId,conversationId:req.params.conversationId as string,userId,role}));
  });
  return router;
}
