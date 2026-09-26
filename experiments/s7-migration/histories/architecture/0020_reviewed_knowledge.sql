ALTER TABLE employee_memories ADD COLUMN model_use_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE employee_memories ADD CONSTRAINT employee_memories_model_use_safe CHECK (NOT model_use_enabled OR (kind <> 'secret-reference' AND sensitivity IN ('public', 'internal')));
--> statement-breakpoint
CREATE TABLE knowledge_proposals (
 id text PRIMARY KEY,
 bot_id text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
 source_run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 kind text NOT NULL,
 title text NOT NULL,
 content text NOT NULL,
 status text NOT NULL DEFAULT 'pending',
 memory_id text,
 reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT knowledge_proposals_kind_valid CHECK (kind IN ('semantic','episodic','procedural')),
 CONSTRAINT knowledge_proposals_status_valid CHECK (status IN ('pending','accepted','rejected')),
 CONSTRAINT knowledge_proposals_pending_bounded CHECK (status <> 'pending' OR (length(btrim(title)) BETWEEN 1 AND 160 AND length(btrim(content)) BETWEEN 1 AND 2000 AND octet_length(content) <= 8000)),
 CONSTRAINT knowledge_proposals_review_valid CHECK ((status = 'pending' AND reviewed_at IS NULL AND memory_id IS NULL) OR (status = 'accepted' AND reviewed_at IS NOT NULL AND memory_id IS NOT NULL) OR (status = 'rejected' AND reviewed_at IS NOT NULL AND memory_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX knowledge_proposals_run_idx ON knowledge_proposals(source_run_id);
--> statement-breakpoint
CREATE INDEX knowledge_proposals_bot_status_idx ON knowledge_proposals(bot_id,status,created_at);
