INSERT INTO "employee_evolution_events" (
  "id",
  "bot_id",
  "type",
  "title",
  "summary",
  "source",
  "evidence",
  "created_at"
)
SELECT
  md5('openbot:employee-created:' || "bots"."id"),
  "bots"."id",
  'created',
  'Employee created',
  "bots"."name" || ' was created with the ' || "bots"."role" || ' role.',
  'manual',
  '[]'::jsonb,
  "bots"."created_at"
FROM "bots"
WHERE NOT EXISTS (
  SELECT 1
  FROM "employee_evolution_events"
  WHERE
    "employee_evolution_events"."bot_id" = "bots"."id"
    AND "employee_evolution_events"."type" = 'created'
);
