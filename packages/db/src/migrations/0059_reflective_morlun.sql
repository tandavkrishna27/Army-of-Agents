ALTER TABLE "internal_agent_config" ALTER COLUMN "execution_mode" SET DEFAULT 'cli';
--> statement-breakpoint
-- Sprint 2A (Decision #91): backfill existing rows to CLI mode.
-- Heuristic D: if cli_tool is already set (user previously picked one), keep
-- it and flip mode to cli; else default cli_tool to 'claude_cli' and flip.
-- API-mode execution path is removed from agent-loop.ts in this same
-- migration's code change; rows left at 'api' would break chat without
-- this backfill.
UPDATE "internal_agent_config"
SET "execution_mode" = 'cli',
    "cli_tool" = COALESCE("cli_tool", 'claude_cli'),
    "updated_at" = NOW()
WHERE "execution_mode" = 'api';