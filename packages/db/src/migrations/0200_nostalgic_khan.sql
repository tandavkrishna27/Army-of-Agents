ALTER TABLE "workspace_runtime_services" ADD COLUMN "process_owner_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_runtime_services_provider_owner_status_idx" ON "workspace_runtime_services" USING btree ("provider","process_owner_id","status");--> statement-breakpoint
-- Adapter-managed runtime IDs are now company-namespaced. Retire the old
-- global-ID rows before the new server reports fresh identities; otherwise old
-- previews remain active/proxyable and collide with the new rows in the API.
UPDATE "task_outputs"
SET "status" = 'stopped',
    "health_status" = 'unknown',
    "url" = NULL,
    "updated_at" = now()
WHERE "runtime_service_id" IN (
  SELECT "id"
  FROM "workspace_runtime_services"
  WHERE "provider" = 'adapter_managed'
);--> statement-breakpoint
DELETE FROM "workspace_runtime_services"
WHERE "provider" = 'adapter_managed';
