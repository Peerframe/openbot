"""Read one channel's latest runs without transferring unbounded stored text."""
_TEXT_COLUMNS = ("id", "parent_run_id", "root_run_id", "delegated_by_bot_id", "channel_id", "bot_id",
                 "source_message_id", "node_id", "execution_profile", "instruction", "title", "status",
                 "result_summary", "error_message", "error_code", "work_task_id")
_COLUMNS = ",".join((*_TEXT_COLUMNS, "model_usage", "model_selection", "created_at", "updated_at"))
_BYTE_SIZE = " + ".join(f"coalesce(octet_length({name})::bigint,0)" for name in _TEXT_COLUMNS)
_BOUNDED_TEXT = ", ".join(f"CASE WHEN s.byte_count<=4194304 THEN s.{name} ELSE NULL END AS {name}" for name in _TEXT_COLUMNS)
RUN_QUERY = (
    f"WITH recent AS MATERIALIZED (SELECT {_COLUMNS} FROM runs_work_projection WHERE channel_id=%s "
    "ORDER BY created_at DESC,id COLLATE \"C\" DESC LIMIT 50), "
    f"sized AS (SELECT recent.*,sum({_BYTE_SIZE}+coalesce(octet_length(model_usage::text)::bigint,0)+coalesce(octet_length(model_selection::text)::bigint,0)) "
    "OVER () AS byte_count FROM recent) "
    f"SELECT true AS channel_exists,s.created_at,s.updated_at,s.byte_count>4194304 AS oversized,{_BOUNDED_TEXT}, "
    "CASE WHEN s.byte_count<=4194304 THEN s.model_selection ELSE NULL END AS model_selection, "
    "CASE WHEN s.byte_count<=4194304 THEN s.model_usage ELSE NULL END AS model_usage "
    "FROM channels c LEFT JOIN sized s ON true WHERE c.id=%s "
    "ORDER BY s.created_at DESC,s.id COLLATE \"C\" DESC"
)


async def read_run_records(connection, identities):
    """Already-authorized identities; bounded text transfer and final JSON, never a scope grant."""
    import json
    from .database import StoreUnavailable
    from .task_models import project_run

    if len(identities) > 1001 or len(set(identities)) != len(identities):
        raise StoreUnavailable("run_projection_limit")
    cursor = await connection.execute(
        f"WITH selected AS MATERIALIZED (SELECT {_COLUMNS} FROM runs_work_projection WHERE id=ANY(%s)), "
        f"sized AS (SELECT selected.*,sum({_BYTE_SIZE}+coalesce(octet_length(model_usage::text)::bigint,0)+coalesce(octet_length(model_selection::text)::bigint,0)) "
        "OVER () AS byte_count FROM selected) "
        f"SELECT {_BOUNDED_TEXT},s.created_at,s.updated_at,s.byte_count>4194304 AS oversized, "
        "CASE WHEN s.byte_count<=4194304 THEN s.model_selection ELSE NULL END AS model_selection, "
        "CASE WHEN s.byte_count<=4194304 THEN s.model_usage ELSE NULL END AS model_usage FROM sized s",
        (list(identities),))
    rows = await cursor.fetchall()
    if any(row["oversized"] for row in rows):
        raise StoreUnavailable("run_projection_limit")
    result = {row["id"]: project_run(row) for row in rows}
    if len(json.dumps([r.model_dump(mode="json",exclude_none=True) for r in result.values()],
                      ensure_ascii=False).encode("utf-8")) > 4194304:
        raise StoreUnavailable("run_projection_limit")
    return result
