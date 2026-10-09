"""Packet integrity and admission tests; no Linux runtime, sudo, provider or remote credentials."""
import asyncio
import io
import hashlib
import tarfile
import json
from pathlib import Path
import sys
import unittest
import stat
from types import SimpleNamespace
from unittest.mock import AsyncMock,patch
from tempfile import TemporaryDirectory

import p4_native_ci as packet
import product_command_native_host as host
import product_command_remote as remote
from test_product_command_remote import finished,BINDING,staged,pem,ROUTE,TIMING


class NativePacketTests(unittest.TestCase):
    def test_ci_parent_is_sealed_without_recursing_or_relaxing_native_checks(self):
        before=SimpleNamespace(st_mode=stat.S_IFDIR|0o777,st_uid=1001,st_gid=1001,st_dev=1,st_ino=2)
        after=SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0,st_gid=0,st_dev=1,st_ino=2)
        with patch.object(packet.sys,'platform','linux'),patch.object(packet.os,'geteuid',return_value=0),patch.dict(packet.os.environ,{'GITHUB_ACTIONS':'true'}):
            with patch.object(Path,'lstat',side_effect=[before,after]),patch.object(packet.os,'chown') as owner,patch.object(Path,'chmod') as mode:
                result=packet.seal_fixture_parent()
            owner.assert_called_once_with(Path('/opt'),0,0);mode.assert_called_once_with(0o755)
            self.assertEqual(result,dict(path='/opt',before=dict(uid=1001,gid=1001,mode='0o777'),after=dict(uid=0,gid=0,mode='0o755'),inodeUnchanged=True))
            before.st_mode=stat.S_IFLNK|0o777
            with patch.object(Path,'lstat',return_value=before),patch.object(packet.os,'chown') as owner:
                with self.assertRaisesRegex(ValueError,'parent_directory_required'):packet.seal_fixture_parent()
                owner.assert_not_called()
        with self.assertRaisesRegex(ValueError,'disposable_linux_ci_only'):packet.seal_fixture_parent()

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

    def test_native_failure_record_excludes_values_and_locals(self):
        for error in (RuntimeError('unsafe_directory'),ValueError('obenr_privateToken secret private.pem')):
            record=host.failure_record(error)
            self.assertEqual(set(record),{'errorType','code','locations'})
            self.assertEqual(record['code'],'unsafe_directory' if isinstance(error,RuntimeError) else 'fixture_failed')
            self.assertNotIn('private',json.dumps(record))
        try:exec(compile('raise RuntimeError("unsafe_file")',str(host.BASE/'case/source/protected_io.py'),'exec'))
        except RuntimeError as error:record=host.failure_record(error)
        # Module-scope frames are excluded; public named functions retain only their location.
        self.assertEqual(record['locations'],[])
        namespace={}
        exec(compile('def fixture():\n raise RuntimeError("unsafe_file")',str(host.BASE/'case/source/protected_io.py'),'exec'),namespace)
        try:namespace['fixture']()
        except RuntimeError as error:record=host.failure_record(error)
        self.assertEqual(record['locations'],[dict(file='case/source/protected_io.py',function='fixture',line=2)])

    def test_root_and_remote_discovery_are_not_implicit(self):
        with self.assertRaisesRegex(ValueError,'disposable_linux_ci_only'):
            packet.prepare(*(Path('/unused') for _ in range(6)))
        with self.assertRaisesRegex(ValueError,'root_ci_packet_required'):host.root_mode('stage')


class NativeDiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_runner_host_binds_actual_server_port_without_a_proxy(self):
        with TemporaryDirectory() as directory:
            root=Path(directory);configuration=root/'configuration.json'
            configuration.write_text(json.dumps({'version':1,'program':str(host.PROGRAM)}))
            with patch.object(host.sys,'platform','linux'):controller=host.NativeHost(configuration,root)
            bundle=root/'node.cjs';bundle.write_bytes(b'public fixture module');key=pem()
            with patch.object(controller,'once',AsyncMock()) as once:
                with self.assertRaisesRegex(ValueError,'owned_native_server_port_required'):await controller.stage(ROUTE,TIMING,key,bundle)
                once.assert_not_awaited()
            controller.port=12345;response=staged(key);response['serverUrl']='ws://127.0.0.1:12345/ws/nodes'
            with patch.object(controller,'once',AsyncMock(return_value=response)) as once,patch.object(host.asyncio,'start_server') as proxy,patch.object(host.socket,'socket') as sockets:
                self.assertEqual(await controller.stage(ROUTE,TIMING,key,bundle),key)
                self.assertEqual(once.call_args.args[1]['serverPort'],12345)
                proxy.assert_not_called()
                sockets.return_value.bind.assert_called_once_with(('127.0.0.1',12345))
            controller.release_server_port()
            sockets.return_value.close.assert_called_once()
            with patch.object(controller,'spawn',AsyncMock()) as spawn:
                with self.assertRaisesRegex(ValueError,'native_server_port_changed'):await controller.start('obenr_'+('a'*43),12346)
                spawn.assert_not_awaited()

    async def test_stage_and_preready_failures_keep_only_public_diagnostic_in_artifact(self):
        for operation in ('stage','run'):
            with TemporaryDirectory() as directory:
                root=Path(directory);configuration=root/'configuration.json'
                configuration.write_text(json.dumps({'version':1,'program':str(host.PROGRAM)}))
                with patch.object(host.sys,'platform','linux'):controller=host.NativeHost(configuration,root)
                controller.port=12345
                diagnostic={'nativeFixtureFailure':{'errorType':'RuntimeError','code':'unsafe_directory','locations':[]}}
                private=b'synthetic private key, arguments and enrollment'
                script='import sys\nsys.stdout.write('+repr(json.dumps(diagnostic)+'\n')+')\nsys.stderr.write('+repr(private.decode())+')\nraise SystemExit(1)'
                child=await asyncio.create_subprocess_exec(sys.executable,'-c',script,
                    stdin=asyncio.subprocess.DEVNULL,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
                with patch.object(controller,'spawn',AsyncMock(return_value=child)) as spawn,patch('builtins.print') as emit:
                    with self.assertRaises(ValueError):
                        if operation=='stage':await controller.once(operation,{})
                        else:await controller.start('obenr_'+('a'*43),12345)
                spawn.assert_awaited_once()
                self.assertEqual(json.loads((root/('native-'+operation+'.failure.json')).read_text()),diagnostic)
                self.assertEqual(json.loads(emit.call_args.args[0]),diagnostic)
                self.assertNotIn('private',emit.call_args.args[0])
                self.assertEqual((root/('native-'+operation+'.stderr-private')).read_bytes(),private)


if __name__=='__main__':unittest.main()
