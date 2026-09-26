"""Disposable loopback effect fixture; never a product authority or real provider.

The SQLite CSV blob and immutable operation receipt commit in one transaction.
A dropped response therefore has an observable effect without granting permission
for another POST. See docs/research/work-temporal-journey.md for reuse evidence.
"""
from __future__ import annotations

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import socket
import sqlite3
import threading
from typing import Iterator


MAX_BODY = 16 * 1024
_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z", re.ASCII)
_OLD_CSV = b"row,value\n7,old\n"
_FIXED_CSV = b"row,value\n7,fixed\n"


def _valid_id(value: object) -> bool:
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _valid_intent(intent: object) -> bool:
    if not isinstance(intent, dict):
        return False
    if intent == {"kind": "read"}:
        return True
    if set(intent) == {"kind", "stage"}:
        return intent["kind"] == "model" and intent["stage"] in ("plan", "decide", "final")
    return (
        set(intent) == {"kind", "row", "value"}
        and intent["kind"] == "write"
        and type(intent["row"]) is int
        and intent["row"] == 7
        and intent["value"] == "fixed"
    )


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError("non-finite JSON number")


class EffectService:
    """Start immediately on an ephemeral IPv4 loopback port, using only root.

    Reopening the same root preserves receipts, CSV bytes, counters and injected
    faults. Each valid-task POST increments attempts, including rejected intents
    and duplicate action IDs; unparseable requests cannot be assigned to a task.
    """

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.database = self.root / "effects.sqlite3"
        with self._connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS tasks (
                    task_id TEXT PRIMARY KEY,
                    csv BLOB NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    writes INTEGER NOT NULL DEFAULT 0,
                    lookups INTEGER NOT NULL DEFAULT 0,
                    drop_response INTEGER NOT NULL DEFAULT 0,
                    corrupt_receipt INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS operations (
                    action_id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL REFERENCES tasks(task_id),
                    record TEXT NOT NULL
                );
            """)
        self._closed = False
        self._server = _EffectHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.effect = self
        self.url = f"http://127.0.0.1:{self._server.server_port}"
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            kwargs={"poll_interval": 0.05},
            name="work-journey-effects",
            daemon=True,
        )
        self._thread.start()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.database, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        try:
            yield db
        except BaseException:
            if db.in_transaction:
                db.rollback()
            raise
        finally:
            db.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        # Separate request connections and an immediate writer lock serialize
        # duplicate checks, counters, receipt creation and fault consumption.
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()

    @staticmethod
    def _ensure_task(db: sqlite3.Connection, task_id: str) -> None:
        db.execute(
            "INSERT OR IGNORE INTO tasks(task_id, csv) VALUES (?, ?)",
            (task_id, _OLD_CSV),
        )

    def drop_write_response(self, task_id: str) -> None:
        """Drop this task's first write response after committing its effect."""
        if not _valid_id(task_id):
            raise ValueError("invalid task ID")
        with self._transaction() as db:
            self._ensure_task(db, task_id)
            if db.execute("SELECT writes FROM tasks WHERE task_id = ?", (task_id,)).fetchone()[0]:
                raise ValueError("the first write already happened")
            db.execute("UPDATE tasks SET drop_response = 1 WHERE task_id = ?", (task_id,))

    def corrupt_receipt(self, task_id: str, *, malformed_json: bool = False) -> None:
        """Corrupt only subsequent HTTP receipt projections, never stored facts."""
        if not _valid_id(task_id):
            raise ValueError("invalid task ID")
        with self._transaction() as db:
            self._ensure_task(db, task_id)
            db.execute("UPDATE tasks SET corrupt_receipt = ? WHERE task_id = ?", (2 if malformed_json else 1, task_id))

    def repair_receipt(self, task_id: str) -> None:
        """Repair the fake connector projection; never edit its independent recorded effect."""
        if not _valid_id(task_id):
            raise ValueError("invalid task ID")
        with self._transaction() as db:
            db.execute("UPDATE tasks SET corrupt_receipt = 0 WHERE task_id = ?", (task_id,))

    def _post(self, payload: object) -> tuple[int, dict, bool]:
        if not isinstance(payload, dict) or not _valid_id(payload.get("taskId")):
            return 400, {"error": "invalid task ID"}, False
        task_id = payload["taskId"]
        with self._transaction() as db:
            self._ensure_task(db, task_id)
            db.execute("UPDATE tasks SET attempts = attempts + 1 WHERE task_id = ?", (task_id,))
            if (
                set(payload) != {"actionId", "taskId", "intent"}
                or not _valid_id(payload.get("actionId"))
                or not _valid_intent(payload.get("intent"))
            ):
                return 400, {"error": "unsupported operation"}, False
            action_id, intent = payload["actionId"], payload["intent"]
            if db.execute("SELECT 1 FROM operations WHERE action_id = ?", (action_id,)).fetchone():
                return 409, {"error": "action ID already exists"}, False
            task = db.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
            drop = False
            if intent["kind"] == "model":
                result = "Row 7 verified" if intent["stage"] == "final" else intent["stage"]
                actual_tokens = 3
            elif intent["kind"] == "read":
                result = "row 7: fixed" if bytes(task["csv"]) == _FIXED_CSV else "row 7: old"
                actual_tokens = 0
            else:
                result, actual_tokens = "applied", 2
                drop = bool(task["drop_response"]) and task["writes"] == 0
                db.execute(
                    "UPDATE tasks SET csv = ?, writes = writes + 1, drop_response = 0 WHERE task_id = ?",
                    (_FIXED_CSV, task_id),
                )
            record = {
                "actionId": action_id,
                "taskId": task_id,
                "intent": intent,
                "result": result,
                "actualTokens": actual_tokens,
            }
            db.execute(
                "INSERT INTO operations(action_id, task_id, record) VALUES (?, ?, ?)",
                (action_id, task_id, json.dumps(record, separators=(",", ":"))),
            )
            return 201, record, drop

    def _get(self, resource: str, identifier: str) -> tuple[int, object]:
        with self._transaction() as db:
            if resource == "operations":
                row = db.execute(
                    "SELECT task_id, record FROM operations WHERE action_id = ?", (identifier,)
                ).fetchone()
                if row is None:
                    return 404, {"error": "operation not found"}
                db.execute("UPDATE tasks SET lookups = lookups + 1 WHERE task_id = ?", (row["task_id"],))
                corrupt = db.execute(
                    "SELECT corrupt_receipt FROM tasks WHERE task_id = ?", (row["task_id"],)
                ).fetchone()[0]
                record = json.loads(row["record"])
                if corrupt == 2:
                    return 200, b'{invalid-json'
                if corrupt:
                    record["intent"]["corrupted"] = True
                return 200, record
            self._ensure_task(db, identifier)
            row = db.execute("SELECT * FROM tasks WHERE task_id = ?", (identifier,)).fetchone()
            if resource == "rows":
                return 200, bytes(row["csv"])
            return 200, {key: row[key] for key in ("attempts", "writes", "lookups")}

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


class _EffectHTTPServer(ThreadingHTTPServer):
    # Cleanup waits for owned request threads; their socket read is bounded.
    daemon_threads = False
    request_queue_size = 32
    effect: EffectService


class _Handler(BaseHTTPRequestHandler):
    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, format: str, *args: object) -> None:
        # The fixture does not log request paths, IDs or user-supplied bodies.
        pass

    def _reply(self, status: int, payload: object) -> None:
        self.close_connection = True
        is_csv = isinstance(payload, bytes)
        body = payload if is_csv else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/csv; charset=utf-8" if is_csv else "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != "/operations":
            self._reply(404, {"error": "unknown route"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if (
            len(lengths) != 1
            or not re.fullmatch(r"[0-9]{1,6}", lengths[0])
            or int(lengths[0]) > MAX_BODY
            or self.headers.get("Transfer-Encoding") is not None
            or self.headers.get_content_type() != "application/json"
        ):
            self._reply(400, {"error": "invalid JSON body framing or size"})
            return
        try:
            body = self.rfile.read(int(lengths[0]))
            if len(body) != int(lengths[0]):
                raise ValueError("incomplete body")
            payload = json.loads(
                body.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_constant
            )
        except (ValueError, RecursionError, socket.timeout):
            self._reply(400, {"error": "invalid JSON body"})
            return
        try:
            status, record, drop = self.server.effect._post(payload)
        except sqlite3.Error:
            self._reply(503, {"error": "fixture database unavailable"})
            return
        if drop:
            # _post returned only after its transaction committed. Send neither
            # status nor body so clients observe an unknown outcome, not success.
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        self._reply(status, record)

    def do_GET(self) -> None:
        parts = self.path.split("/")
        if len(parts) != 3 or parts[1] not in ("operations", "rows", "stats"):
            self._reply(404, {"error": "unknown route"})
            return
        if not _valid_id(parts[2]):
            self._reply(400, {"error": "invalid path ID"})
            return
        try:
            status, payload = self.server.effect._get(parts[1], parts[2])
        except sqlite3.Error:
            self._reply(503, {"error": "fixture database unavailable"})
            return
        self._reply(status, payload)
