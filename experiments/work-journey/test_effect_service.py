"""Actual loopback HTTP acceptance for the isolated effect fixture."""
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from urllib.parse import urlsplit

from effect_service import EffectService, MAX_BODY


class EffectServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(prefix="openbot-effects-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.service = EffectService(self.root)
        self.addCleanup(lambda: self.service.close())

    def request(self, method, path, payload=None, raw=None, headers=None):
        url = urlsplit(self.service.url)
        conn = http.client.HTTPConnection(url.hostname, url.port, timeout=10)
        body = raw if raw is not None else (json.dumps(payload).encode() if payload is not None else None)
        actual_headers = {"Content-Type": "application/json"}
        actual_headers.update(headers or {})
        try:
            conn.request(method, path, body=body, headers=actual_headers)
            response = conn.getresponse()
            data = response.read()
            result = data if response.getheader("Content-Type", "").startswith("text/csv") else json.loads(data)
            return response.status, result
        finally:
            conn.close()

    def post(self, action="write-1", task="task-1", intent=None):
        return self.request("POST", "/operations", {
            "actionId": action, "taskId": task,
            "intent": {"kind": "write", "row": 7, "value": "fixed"} if intent is None else intent,
        })

    def get(self, path):
        status, data = self.request("GET", path)
        self.assertEqual(status, 200)
        return data

    def test_http_model_read_write_and_exact_csv(self):
        self.assertTrue(self.service.url.startswith("http://127.0.0.1:"))
        self.assertEqual(self.get("/rows/task-1"), b"row,value\n7,old\n")
        for stage, result in (("plan", "plan"), ("decide", "decide"), ("final", "Row 7 verified")):
            status, record = self.post(f"model-{stage}", intent={"kind": "model", "stage": stage})
            self.assertEqual(status, 201)
            self.assertEqual(record["result"], result)
            self.assertEqual(record["actualTokens"], 3)
        self.assertEqual(self.post("read-before", intent={"kind": "read"})[1]["result"], "row 7: old")
        status, receipt = self.post()
        self.assertEqual(status, 201)
        self.assertEqual(receipt, {
            "actionId": "write-1", "taskId": "task-1",
            "intent": {"kind": "write", "row": 7, "value": "fixed"},
            "result": "applied", "actualTokens": 2,
        })
        self.assertEqual(self.get("/operations/write-1"), receipt)
        self.assertEqual(self.get("/rows/task-1"), b"row,value\n7,fixed\n")
        read = self.post("read-after", intent={"kind": "read"})[1]
        self.assertEqual((read["result"], read["actualTokens"]), ("row 7: fixed", 0))
        self.assertEqual(self.get("/stats/task-1"), {"attempts": 6, "writes": 1, "lookups": 1})

    def test_dropped_response_commits_before_restart_and_duplicate_is_counted(self):
        self.service.drop_write_response("task-1")
        with self.assertRaises(http.client.RemoteDisconnected):
            self.post()
        self.service.close()
        self.service = EffectService(self.root)
        self.assertEqual(self.get("/rows/task-1"), b"row,value\n7,fixed\n")
        receipt = self.get("/operations/write-1")
        self.assertEqual(receipt["result"], "applied")
        self.assertEqual(self.post()[0], 409)
        self.assertEqual(self.get("/stats/task-1"), {"attempts": 2, "writes": 1, "lookups": 1})
        self.assertEqual(self.post("write-2")[0], 201)
        self.assertEqual(self.get("/stats/task-1"), {"attempts": 3, "writes": 2, "lookups": 1})

    def test_fault_configuration_survives_restart(self):
        self.service.drop_write_response("task-1")
        self.service.close()
        self.service = EffectService(self.root)
        with self.assertRaises(http.client.RemoteDisconnected):
            self.post()
        self.assertEqual(self.get("/stats/task-1"), {"attempts": 1, "writes": 1, "lookups": 0})

    def test_tasks_and_counters_are_isolated(self):
        self.post()
        self.assertEqual(self.get("/rows/task-2"), b"row,value\n7,old\n")
        self.assertEqual(self.get("/stats/task-2"), {"attempts": 0, "writes": 0, "lookups": 0})
        self.assertEqual(self.post(task="task-2")[0], 409)
        self.assertEqual(self.get("/stats/task-2"), {"attempts": 1, "writes": 0, "lookups": 0})
        self.assertEqual(self.post("other-write", "task-2")[0], 201)
        self.get("/operations/other-write")
        self.assertEqual(self.get("/stats/task-1"), {"attempts": 1, "writes": 1, "lookups": 0})
        self.assertEqual(self.get("/stats/task-2"), {"attempts": 2, "writes": 1, "lookups": 1})

    def test_corrupted_projection_does_not_change_persisted_receipt(self):
        original = self.post()[1]
        self.service.corrupt_receipt("task-1")
        self.assertNotEqual(self.get("/operations/write-1")["intent"], original["intent"])
        with sqlite3.connect(self.root / "effects.sqlite3") as db:
            persisted = json.loads(db.execute("SELECT record FROM operations WHERE action_id = ?", ("write-1",)).fetchone()[0])
        self.assertEqual(persisted, original)
        self.assertEqual(self.get("/rows/task-1"), b"row,value\n7,fixed\n")
        self.service.close()
        self.service = EffectService(self.root)
        self.assertNotEqual(self.get("/operations/write-1")["intent"], original["intent"])
        self.assertEqual(self.get("/stats/task-1"), {"attempts": 1, "writes": 1, "lookups": 2})

    def test_concurrent_duplicates_are_all_visible_and_write_once(self):
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda _: self.post(), range(12)))
        self.assertEqual(sum(status == 201 for status, _ in results), 1)
        self.assertEqual(sum(status == 409 for status, _ in results), 11)
        self.assertEqual(self.get("/stats/task-1"), {"attempts": 12, "writes": 1, "lookups": 0})

    def test_unsupported_intents_and_extra_fields_fail_closed(self):
        intents = [
            {"kind": "write", "row": 8, "value": "fixed"},
            {"kind": "write", "row": 7.0, "value": "fixed"},
            {"kind": "write", "row": 7, "value": "elsewhere"},
            {"kind": "write", "row": 7, "value": "fixed", "path": "/tmp/target"},
            {"kind": "read", "target": "other"},
            {"kind": "model", "stage": "other"},
            {"kind": "model", "stage": []},
            {"kind": "shell", "command": "true"},
            [], None,
        ]
        for i, intent in enumerate(intents):
            with self.subTest(intent=intent):
                status, _ = self.request("POST", "/operations", {"actionId": f"bad-{i}", "taskId": "task-1", "intent": intent})
                self.assertEqual(status, 400)
        self.assertEqual(self.request("POST", "/operations", {
            "actionId": "extra", "taskId": "task-1", "intent": {"kind": "read"}, "extra": True,
        })[0], 400)
        self.assertEqual(self.get("/rows/task-1"), b"row,value\n7,old\n")
        self.assertEqual(self.get("/stats/task-1"), {"attempts": len(intents) + 1, "writes": 0, "lookups": 0})
        self.assertEqual(self.request("GET", "/operations/bad-0")[0], 404)

    def test_json_framing_size_and_ids_are_bounded(self):
        malformed = [b"{", b"[]", b"null", b"\xff", b'{"taskId":"task-1","taskId":"task-2"}', b'{"n":NaN}']
        for body in malformed:
            with self.subTest(body=body):
                self.assertEqual(self.request("POST", "/operations", raw=body)[0], 400)
        self.assertEqual(self.request("POST", "/operations", raw=b" " * (MAX_BODY + 1))[0], 400)
        self.assertEqual(self.request("POST", "/operations", raw=b"{}", headers={"Content-Type": "text/plain"})[0], 400)
        self.assertEqual(self.request("POST", "/operations", raw=b"{}", headers={"Transfer-Encoding": "chunked"})[0], 400)
        for task_id in ("../other", "", "x" * 129, "含中文", "bad\nline"):
            with self.subTest(task_id=task_id):
                self.assertEqual(self.post(task=task_id)[0], 400)
        for action_id in ("../other", "x" * 129, "含中文"):
            self.assertEqual(self.post(action=action_id)[0], 400)
        self.assertEqual(self.request("GET", "/rows/%2e%2e")[0], 400)
        self.assertEqual(self.request("GET", "/rows/" + "x" * 129)[0], 400)
        self.assertEqual(self.request("GET", "/rows/task-1?x=1")[0], 400)
        self.assertEqual(self.get("/stats/task-1"), {"attempts": 3, "writes": 0, "lookups": 0})

    def test_missing_receipt_does_not_increment_unrelated_lookups(self):
        self.assertEqual(self.request("GET", "/operations/missing")[0], 404)
        self.assertEqual(self.get("/stats/task-1"), {"attempts": 0, "writes": 0, "lookups": 0})
        self.service.close()
        self.service.close()


if __name__ == "__main__":
    unittest.main()
