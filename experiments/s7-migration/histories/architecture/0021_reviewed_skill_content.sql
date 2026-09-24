ALTER TABLE skills ADD COLUMN skill_markdown text;
--> statement-breakpoint
ALTER TABLE skills ADD COLUMN content_sha256 text;
--> statement-breakpoint
ALTER TABLE skills ADD CONSTRAINT skills_document_bounded CHECK ((skill_markdown IS NULL AND content_sha256 IS NULL) OR (skill_markdown IS NOT NULL AND octet_length(skill_markdown) BETWEEN 1 AND 12288 AND content_sha256 IS NOT NULL AND content_sha256 ~ '^[a-f0-9]{64}$'));
--> statement-breakpoint
ALTER TABLE employee_skills ADD COLUMN reviewed_content_sha256 text;
--> statement-breakpoint
ALTER TABLE employee_skills ADD COLUMN revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE employee_skills ADD CONSTRAINT employee_skills_revision_valid CHECK (revision >= 1);
--> statement-breakpoint
ALTER TABLE employee_skills ADD CONSTRAINT employee_skills_review_digest_valid CHECK (reviewed_content_sha256 IS NULL OR reviewed_content_sha256 ~ '^[a-f0-9]{64}$');
