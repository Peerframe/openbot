"""Independent supplied-code counterexamples; no daemon/container/VPS operations.

Regression cases from independent review; all operations use scripted boundaries.
"""
from contextlib import contextmanager
import errno
import os
from pathlib import Path
import stat
import sys
import unittest
from unittest import mock

SOURCE=Path(__file__).resolve().parent
sys.path.insert(0,str(SOURCE))
import sandbox
import test_sandbox as fixture


@contextmanager
def case():
    value=fixture.SandboxTest(methodName='runTest')
    value.setUp()
    try:yield value
    finally:
        value.tearDown()
        value.doCleanups()


class IndependentReview(unittest.TestCase):
    def test_conflicting_tmpfs_options_must_refuse_before_start(self):
        for suffix in (',exec',',dev',',suid',',size=1g'):
            with self.subTest(suffix=suffix),case() as f:
                prepared=f.prepare()
                options=f'rw,nosuid,nodev,noexec,size={prepared.spec.limits.tmp_mib}m'+suffix
                commander,boundary=f.build(stored_hostconfig={'Tmpfs':{'/tmp':options}})
                with self.assertRaises(sandbox.ExecutionError):
                    receipt=boundary.create(prepared)
                    boundary.start_once(receipt)
                self.assertEqual(commander.docker_started_containers,0)

    def test_admitted_fractional_cpu_round_trips_create_readback(self):
        with case() as f:
            commander,boundary=f.build()
            prepared=f.prepare(limits=sandbox.Limits(cpus=0.123456789))
            try:receipt=boundary.create(prepared)
            except sandbox.ExecutionError as error:
                self.fail('admitted CPU 0.123456789 serialized as '+fixture._option(commander.create_argv(),'--cpus')+
                          '; faithful stored NanoCpus rejected: '+str(error))
            boundary.start_once(receipt)
            self.assertEqual(commander.docker_started_containers,1)

    def test_cpu_requires_finite_exact_nanocpu_representation(self):
        for value in (float('nan'),float('inf'),float('-inf'),0.0000000001):
            with self.subTest(value=value):
                with self.assertRaises(sandbox.InvalidAction):
                    sandbox.Limits(cpus=value).validate()

    def test_directory_fsync_failure_does_not_issue_or_reopen_create(self):
        with case() as f:
            commander,boundary=f.build();prepared=f.prepare()
            actual=sandbox.os.fsync
            def fail_directory(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode):raise OSError(errno.EIO,'synthetic directory sync failure')
                actual(fd)
            with mock.patch.object(sandbox.os,'fsync',side_effect=fail_directory):
                with self.assertRaises(OSError):boundary.create(prepared)
            self.assertEqual(commander.docker_created_containers,0)
            with self.assertRaises(sandbox.CreateAlreadyReserved):boundary.create(prepared)
            self.assertEqual(commander.docker_created_containers,0)

    def test_directory_fsync_failure_does_not_issue_or_reopen_start(self):
        with case() as f:
            commander,boundary=f.build();prepared=f.prepare();receipt=boundary.create(prepared)
            actual=sandbox.os.fsync
            def fail_directory(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode):raise OSError(errno.EIO,'synthetic directory sync failure')
                actual(fd)
            with mock.patch.object(sandbox.os,'fsync',side_effect=fail_directory):
                with self.assertRaises(OSError):boundary.start_once(receipt)
            self.assertEqual(commander.docker_started_containers,0)
            with self.assertRaises(sandbox.AlreadyStarted):boundary.start_once(receipt)
            self.assertEqual(commander.docker_started_containers,0)

    def test_reserved_start_on_created_object_is_not_retried_by_recovery(self):
        with case() as f:
            commander,boundary=f.build();prepared=f.prepare();receipt=boundary.create(prepared)
            f.ledger.reserve_start(action_id=receipt['action_id'],action_epoch=receipt['action_epoch'],
                container_id=receipt['container_id'],container_name=receipt['container_name'],intent_digest=receipt['intent_digest'])
            recovered=boundary.recover(receipt['action_id'],receipt['action_epoch'])
            self.assertEqual(recovered['decision'],'do_not_start')
            self.assertEqual(commander.docker_started_containers,0)
            with self.assertRaises(sandbox.AlreadyStarted):boundary.start_once(receipt)

    def test_collection_refuses_hardlink_and_counts_zero_size_entry_bound(self):
        with case() as f:
            commander,boundary=f.build();prepared=f.prepare();receipt=boundary.create(prepared)
            external=f.work_root/'fixture-external';external.write_bytes(b'not output')
            os.link(external,prepared.spec.output_dir/'shared')
            with self.assertRaises(sandbox.ExecutionError):boundary.collect_output(prepared,receipt)
            (prepared.spec.output_dir/'shared').unlink()
            for index in range(4097):(prepared.spec.output_dir/str(index)).touch()
            with self.assertRaisesRegex(sandbox.ExecutionError,'entry count'):
                boundary.collect_output(prepared,receipt)
            self.assertFalse(any(e['event']=='output_collected' for e in f.ledger.read()))


if __name__=='__main__':unittest.main(verbosity=2)
