"""Scripted timing/ACK-loss counterexamples; no native Linux deadline claim."""
from contextlib import contextmanager
import unittest

import sandbox
import test_sandbox as fixture


@contextmanager
def case(**kwargs):
    value = fixture.SandboxTest(methodName="runTest")
    value.setUp()
    try:
        commander, boundary = value.build(**kwargs)
        now = [100.0]
        boundary.clock = lambda: now[0]
        yield value, commander, boundary, now
    finally:
        value.tearDown()
        value.doCleanups()


class DeadlineRecoveryTest(unittest.TestCase):
    def test_create_and_start_reply_delay_share_original_budget(self):
        with case() as (f, commander, boundary, now):
            prepared = f.prepare(limits=sandbox.Limits(wall_seconds=10))
            def delay(_commander, argv):
                if argv[0] == "create":
                    now[0] += 3
                if argv[0] == "start":
                    now[0] += 4
            commander.on_command = delay
            result = sandbox.run_action(boundary, prepared)
            self.assertEqual(result["observation"]["outcome"], "exited")
            self.assertEqual([n for verb, n in commander.timeouts if verb == "wait"], [3.0])
            self.assertEqual(commander.verbs().count("start"), 1)

    def test_prearmed_native_deadline_includes_preparation_time(self):
        with case() as (f, commander, boundary, now):
            prepared = f.prepare(limits=sandbox.Limits(wall_seconds=10))
            now[0] = 106.0
            sandbox.run_action(boundary, prepared, deadline_monotonic=110.0)
            self.assertEqual([n for verb, n in commander.timeouts if verb == "wait"], [4.0])

    def test_expired_reply_skips_initial_wait_and_attempts_cleanup_only(self):
        with case(exit_code=137) as (f, commander, boundary, now):
            prepared = f.prepare(limits=sandbox.Limits(wall_seconds=5))
            def delay(_commander, argv):
                if argv[0] == "start":
                    now[0] += 8
            commander.on_command = delay
            sandbox.run_action(boundary, prepared)
            self.assertEqual([n for verb, n in commander.timeouts if verb == "wait"], [30.0])
            verbs = commander.verbs()
            self.assertLess(verbs.index("kill"), verbs.index("wait"))
            self.assertEqual(verbs.count("start"), 1)
            expired = [e for e in f.ledger.read() if e["event"] == "wall_deadline_exceeded"]
            self.assertEqual(expired[0]["detail"]["wall_seconds"], 5)

    def test_expired_after_create_does_not_send_start(self):
        with case() as (f, commander, boundary, now):
            prepared = f.prepare(limits=sandbox.Limits(wall_seconds=5))
            def delay(_commander, argv):
                if argv[0] == "create":
                    now[0] += 5
            commander.on_command = delay
            with self.assertRaisesRegex(sandbox.ExecutionError, "elapsed before start"):
                sandbox.run_action(boundary, prepared)
            self.assertEqual(commander.docker_created_containers, 1)
            self.assertNotIn("start", commander.verbs())
            self.assertEqual(f.ledger.counters("action-001", 1).start_attempts, 0)

    def test_expired_before_create_contacts_no_daemon(self):
        with case() as (f, commander, boundary, now):
            prepared = f.prepare()
            with self.assertRaisesRegex(sandbox.ExecutionError, "elapsed before create"):
                sandbox.run_action(boundary, prepared, deadline_monotonic=100.0)
            self.assertEqual(commander.trace, [])
            self.assertEqual(f.ledger.read(), [])

    def test_direct_wait_requires_original_deadline_without_daemon_call(self):
        with case() as (f, commander, boundary, now):
            prepared = f.prepare()
            record = boundary.create(prepared)
            before = list(commander.trace)
            with self.assertRaises(TypeError):
                boundary.wait_for_exit(prepared, record)
            self.assertEqual(commander.trace, before)

    def test_invalid_deadline_is_refused_before_create_or_wait(self):
        bad_values = (True, "110", float("nan"), float("inf"), -1, 10**1000)
        for bad in bad_values:
            with self.subTest(value=repr(bad)[:30]), case() as (f, commander, boundary, now):
                prepared = f.prepare()
                with self.assertRaises(sandbox.InvalidAction):
                    sandbox.run_action(boundary, prepared, deadline_monotonic=bad)
                self.assertEqual(commander.trace, [])
                record = boundary.create(prepared)
                before = list(commander.trace)
                with self.assertRaises(sandbox.InvalidAction):
                    boundary.wait_for_exit(prepared, record, deadline_monotonic=bad)
                self.assertEqual(commander.trace, before)

    def test_supplied_deadline_cannot_expand_digest_bound_wait(self):
        with case() as (f, commander, boundary, now):
            prepared = f.prepare(limits=sandbox.Limits(wall_seconds=3))
            record = boundary.create(prepared)
            boundary.start_once(record)
            boundary.wait_for_exit(prepared, record, deadline_monotonic=1000.0)
            self.assertEqual([n for verb, n in commander.timeouts if verb == "wait"], [3.0])

    def test_reserved_start_still_created_is_unknown_and_recovery_does_not_mutate(self):
        with case() as (f, commander, boundary, now):
            prepared = f.prepare()
            record = boundary.create(prepared)
            f.ledger.reserve_start(action_id=record["action_id"], action_epoch=record["action_epoch"],
                container_id=record["container_id"], container_name=record["container_name"],
                intent_digest=record["intent_digest"])
            before = f.ledger.path.read_bytes()
            # A new boundary has no in-memory start/clock facts; durable reservation is sufficient.
            recovered = sandbox.CommandSandbox(cli=boundary.cli, work_root=f.work_root,
                ledger=sandbox.EventLedger(f.ledger.path))
            observed = recovered.recover("action-001", 1)
            self.assertEqual(observed["outcome"], "unknown")
            self.assertEqual(observed["decision"], "do_not_start")
            self.assertIn("queued", observed["reason"])
            self.assertEqual(before, f.ledger.path.read_bytes())
            with self.assertRaises(sandbox.AlreadyStarted):
                recovered.start_once(record)
            self.assertEqual(commander.verbs().count("start"), 0)

    def test_delayed_start_after_created_inspect_never_gets_second_start(self):
        with case() as (f, commander, boundary, now):
            prepared = f.prepare()
            record = boundary.create(prepared)
            f.ledger.reserve_start(action_id=record["action_id"], action_epoch=record["action_epoch"],
                container_id=record["container_id"], container_name=record["container_name"],
                intent_digest=record["intent_digest"])
            first = boundary.recover("action-001", 1)
            self.assertEqual(first["outcome"], "unknown")
            # Only the scripted daemon state advances, modeling the already-consumed request.
            commander.containers[record["container_name"]]["State"]["Status"] = "running"
            self.assertEqual(boundary.recover("action-001", 1)["outcome"], "running")
            with self.assertRaises(sandbox.AlreadyStarted):
                boundary.start_once(record)
            self.assertNotIn("start", commander.verbs())

    def test_created_without_attempt_is_only_an_observation_not_a_fence(self):
        with case() as (f, commander, boundary, now):
            prepared = f.prepare()
            record = boundary.create(prepared)
            observed = boundary.recover("action-001", 1)
            self.assertEqual(observed["outcome"], "created_not_started")
            self.assertEqual(observed["decision"], "do_not_start")
            self.assertIn("not a fence", observed["reason"])
            self.assertNotIn("never started", observed["reason"])
            # A separate authorized caller can race this old observation. Recovery cannot fence it.
            boundary.start_once(record)
            self.assertEqual(boundary.recover("action-001", 1)["outcome"], "running")
            self.assertEqual(commander.verbs().count("start"), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
