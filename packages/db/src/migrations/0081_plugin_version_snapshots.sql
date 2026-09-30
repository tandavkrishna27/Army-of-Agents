CREATE TABLE IF NOT EXISTS "plugin_version_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plugin_id" uuid NOT NULL REFERENCES "plugins"("id") ON DELETE CASCADE,
  "version" text NOT NULL,
  "package_name" text NOT NULL,
  "manifest_json" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "pvs_plugin_created_idx" ON "plugin_version_snapshots"("plugin_id","created_at");
