ALTER TABLE "internal_agent_config" ADD COLUMN "crew_autonomy_level" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- D18 dial-split backfill (Decision #109 addendum, T2.10).
--
-- `ADD COLUMN ... DEFAULT 1` stamps EVERY existing row with 1, which would
-- silently move any company that had deliberately set Manual (0) or Drive (2)
-- on the old shared dial. Copy the stored shared value across so no live
-- company's effective agent-execution behaviour changes on migration: the
-- crew/heartbeat/Adjutant readers now read `crew_autonomy_level`, and on the
-- day of the split it holds exactly what those readers read yesterday.
--
-- Values are copied verbatim (no clamp). Legacy rows above the canonical 0..2
-- scale are clamped on the next boot by `reconcileAutonomyScale`, which covers
-- both columns; every consumer compares (>= 1 / >= 2 / === 0) so an
-- out-of-range value behaves identically before and after that clamp.
UPDATE "internal_agent_config" SET "crew_autonomy_level" = "autonomy_level";
