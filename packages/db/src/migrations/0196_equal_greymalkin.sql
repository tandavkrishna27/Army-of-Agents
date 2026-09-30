ALTER TABLE "execution_targets" DROP CONSTRAINT "execution_targets_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "execution_targets" ADD CONSTRAINT "execution_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;