-- Existing workspaces start unselected; only a new create/import or explicit Owner write selects.
CREATE TABLE workspace_settings (
  workspace_id text PRIMARY KEY CHECK (workspace_id = 'workspace'),
  primary_bot_id text REFERENCES bots(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 2147483647)
);
--> statement-breakpoint
INSERT INTO workspace_settings(workspace_id) VALUES ('workspace');
