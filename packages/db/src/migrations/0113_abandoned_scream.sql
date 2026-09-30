CREATE TABLE IF NOT EXISTS "goal_parents" (
	"goal_id" uuid NOT NULL,
	"parent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_parents_goal_id_parent_id_pk" PRIMARY KEY("goal_id","parent_id")
);
--> statement-breakpoint
ALTER TABLE "goal_parents" ADD CONSTRAINT "goal_parents_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_parents" ADD CONSTRAINT "goal_parents_parent_id_goals_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_parents_goal_idx" ON "goal_parents" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_parents_parent_idx" ON "goal_parents" USING btree ("parent_id");