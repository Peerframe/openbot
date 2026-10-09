"""Packet integrity and admission tests; no Linux runtime, sudo, provider or remote credentials."""
import asyncio
import io
import hashlib
import tarfile
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from tempfile import TemporaryDirectory

import p4_native_ci as packet
import product_command_native_host as host
import product_command_remote as remote
from test_product_command_remote import finished,BINDING


class NativePacketTests(unittest.TestCase):
    def test_source_rebinding_requires_one_reviewed_literal(self):
        self.assertEqual(packet.replace_exact('pin=original','original','measured'),'pin=measured')
        for value in ('absent','original original'):
            with self.assertRaisesRegex(ValueError,'source_shape_changed'):packet.replace_exact(value,'original','measured')

    def test_official_top_level_directory_is_not_a_runtime_binary(self):
        with TemporaryDirectory() as directory:
            p=Path(directory)/'archive.tar';content=b'pinned executable'
            with tarfile.open(p,'w') as t:
                folder=tarfile.TarInfo('docker');folder.type=tarfile.DIRTYPE;t.addfile(folder)
                member=tarfile.TarInfo('docker/docker');member.size=len(content);t.addfile(member,io.BytesIO(content))
            expected={'docker':hashlib.sha256(content).hexdigest()}
            self.assertEqual(list(packet.pinned_members(p,expected,'docker/')),[('docker',content)])
            with tarfile.open(p,'w') as t:
                link=tarfile.TarInfo('docker/docker');link.type=tarfile.SYMTYPE;link.linkname='/not-selected';t.addfile(link)
            with self.assertRaisesRegex(ValueError,'binary_archive_type_changed'):list(packet.pinned_members(p,expected,'docker/'))

    def test_download_rejects_content_and_size_drift(self):
        with TemporaryDirectory() as directory:
            for i,(data,size) in enumerate(((b'evil',4),(b'one',4),(b'oversize',4))):
                with patch.object(packet,'urlopen',return_value=io.BytesIO(data)):
                    with self.assertRaises(ValueError):packet.download(Path(directory)/str(i),('https://fixture.invalid','0'*64,size))

    def test_dynamic_baseline_retains_all_native_binding_and_cleanup_gates(self):
        value=finished();value['before']['containerCount']=value['after']['containerCount']=3
        self.assertEqual(remote.finished_evidence(value,BINDING,container_count=3),value)
        with self.assertRaises(ValueError):remote.finished_evidence(value,BINDING)
        value['after']['containerCount']=4
        with self.assertRaises(ValueError):remote.finished_evidence(value,BINDING,container_count=3)
        for count in (True,-1,'3'):
            with self.assertRaises(ValueError):remote.finished_evidence(finished(),BINDING,container_count=count)

    def test_ci_config_does_not_select_an_arbitrary_root_program(self):
        with TemporaryDirectory() as directory:
            p=Path(directory)/'fixture.json'
            for value in ({'version':1,'program':'/bin/sh'},{'version':True,'program':str(host.PROGRAM)},{'version':1,'program':str(host.PROGRAM),'extra':True}):
                p.write_text(json.dumps(value))
                with self.assertRaisesRegex(ValueError,'explicit_native_ci'):host.NativeHost(p,Path(directory))

    def test_worker_venv_prefix_survives_an_interpreter_symlink(self):
        with TemporaryDirectory() as directory:
            root=Path(directory);(root/'bin').mkdir();(root/'pyvenv.cfg').write_text('fixture venv')
            site=root/'lib/python3.12/site-packages';site.mkdir(parents=True)
            worker=root/'bin/python';worker.symlink_to(sys.executable)
            self.assertEqual(packet.worker_site(worker),site)
            with self.assertRaisesRegex(ValueError,'explicit_worker_venv'):packet.worker_site(worker.resolve())

    def test_root_and_remote_discovery_are_not_implicit(self):
        with self.assertRaisesRegex(ValueError,'disposable_linux_ci_only'):
            packet.prepare(*(Path('/unused') for _ in range(6)))
        with self.assertRaisesRegex(ValueError,'root_ci_packet_required'):host.root_mode('stage')


if __name__=='__main__':unittest.main()
