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

    def test_oci_copy_keeps_manifest_and_config_pins_separate(self):
        with TemporaryDirectory() as directory:
            p=Path(directory)/'image.tar';calls=[]
            def run(argv):calls.append(argv);p.write_bytes(b'fixture OCI archive');return b''
            identity={'manifest':packet.PYTHON_MANIFEST,'config':packet.PYTHON_CONFIG,'diffIds':[]}
            with patch.object(packet,'run',side_effect=run),patch.object(packet,'oci_identity',return_value=identity) as verify:
                value=packet.export_image(packet.PYTHON_IMAGE,p,packet.PYTHON_CONFIG,packet.PYTHON_MANIFEST)
            self.assertIn('docker://python@'+packet.PYTHON_MANIFEST,calls[0])
            self.assertIn('--preserve-digests',calls[0]);self.assertIn('--src-no-creds',calls[0])
            self.assertNotEqual(packet.PYTHON_CONFIG,packet.PYTHON_MANIFEST)
            verify.assert_called_once_with(p,packet.PYTHON_CONFIG,packet.PYTHON_MANIFEST)
            self.assertEqual(value['config'],packet.PYTHON_CONFIG)
            calls.clear()
            with patch.object(packet,'run',side_effect=run),patch.object(packet,'oci_identity',return_value=identity):
                packet.export_image(packet.CHROMIUM_IMAGE,p,packet.CHROMIUM_CONFIG)
            self.assertIn('docker://mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e',calls[0])
            calls.clear()
            with patch.object(packet,'run',side_effect=run),patch.object(packet,'oci_identity',return_value=identity):
                packet.export_image(packet.SQUID_TAG,p,daemon=True)
            self.assertIn('docker-daemon:'+packet.SQUID_TAG,calls[0])
            self.assertIn('--dest-oci-accept-uncompressed-layers',calls[0])
            self.assertIn('oci-archive:'+str(p)+':'+packet.SQUID_TAG,calls[0])
            self.assertNotIn('--preserve-digests',calls[0])

    def test_oci_metadata_pin_drift_and_platform_fail_closed(self):
        with TemporaryDirectory() as directory:
            p=Path(directory)/'image.tar'
            def write(architecture='amd64',corrupt=False):
                config=json.dumps({'architecture':architecture,'os':'linux','rootfs':{'diff_ids':[]}}).encode()
                cp={'digest':'sha256:'+hashlib.sha256(config).hexdigest(),'size':len(config)}
                manifest=json.dumps({'schemaVersion':2,'config':cp,'layers':[]}).encode()
                mp={'digest':'sha256:'+hashlib.sha256(manifest).hexdigest(),'size':len(manifest)}
                records={'index.json':json.dumps({'schemaVersion':2,'manifests':[mp]}).encode(),'blobs/sha256/'+mp['digest'][7:]:manifest,'blobs/sha256/'+cp['digest'][7:]:b'changed' if corrupt else config}
                with tarfile.open(p,'w') as t:
                    for name,data in records.items():
                        member=tarfile.TarInfo(name);member.size=len(data);t.addfile(member,io.BytesIO(data))
                return cp['digest'],mp['digest']
            cp,mp=write();self.assertEqual(packet.oci_identity(p,cp,mp)['manifest'],mp)
            with self.assertRaisesRegex(ValueError,'image_manifest_changed'):packet.oci_identity(p,cp,'sha256:'+('0'*64))
            with self.assertRaisesRegex(ValueError,'image_content_changed'):packet.oci_identity(p,'sha256:'+('0'*64),mp)
            cp,mp=write(corrupt=True)
            with self.assertRaisesRegex(ValueError,'oci_metadata_pin_changed'):packet.oci_identity(p,cp,mp)
            cp,mp=write(architecture='arm64')
            with self.assertRaisesRegex(ValueError,'image_platform_changed'):packet.oci_identity(p,cp,mp)

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
