"""Actual product CLI preflight; failures cannot expose operator configuration."""
import json
from pathlib import Path
import subprocess
import sys

import pytest
pytest.importorskip('temporalio', reason='optional Worker SDK profile')
from openbot_server.work_engine_client import read_owned_file, tls_config, validate_address

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/dispatch-work.py'


def config(tmp_path):
    files={}
    for name in ['ca','certificate','key']:
        path=tmp_path/(name+'.pem');path.write_bytes(b'synthetic preflight material');path.chmod(0o600)
        files[name]=str(path)
    files['server_name']='temporal.openbot.internal'
    return dict(database_url='postgres://synthetic-secret@unreachable.invalid/test',
                temporal_address='127.0.0.1:7233',namespace='default',queue='queue',tls=files)


def run(tmp_path, data, mode=0o600):
    path=tmp_path/'operator.json';path.write_text(json.dumps(data));path.chmod(mode)
    return subprocess.run([sys.executable,'-I',str(SCRIPT),'--config',str(path),'--check'],
                          capture_output=True,text=True,timeout=15)


def test_actual_cli_preflight_never_connects_or_prints_secrets(tmp_path):
    result=run(tmp_path,config(tmp_path))
    assert result.returncode==0 and json.loads(result.stdout)==dict(status='validated',networkCalls=0)
    assert result.stderr=='' and 'synthetic-secret' not in result.stdout


@pytest.mark.parametrize('fault',['permissions','missing_tls','plaintext','shared_key','limit','unknown','writable_ca','writable_certificate'])
def test_actual_cli_refuses_unsafe_configuration_without_raw_errors(tmp_path,fault):
    data=config(tmp_path);mode=0o600
    if fault=='permissions':mode=0o644
    if fault=='missing_tls':data.pop('tls')
    if fault=='plaintext':data['temporal_address']='http://localhost:7233'
    if fault=='shared_key':Path(data['tls']['key']).chmod(0o644)
    if fault.startswith('writable_'):Path(data['tls'][fault.removeprefix('writable_')]).chmod(0o622)
    if fault=='limit':data['limit']=False
    if fault=='unknown':data['yolo']=True
    result=run(tmp_path,data,mode)
    assert result.returncode==1
    assert json.loads(result.stdout)==dict(status='error',reason='dispatch_failed')
    assert result.stderr=='' and 'synthetic-secret' not in result.stdout


def test_tls_files_refuse_symlink_and_overlimit(tmp_path):
    path=tmp_path/'source';path.write_bytes(b'data');path.chmod(0o600)
    link=tmp_path/'link';link.symlink_to(path)
    with pytest.raises(OSError):read_owned_file(link,private=True)
    with pytest.raises(ValueError):read_owned_file(path,maximum=3)
    for address in ['127.0.0.1:0','host:70000','user@host:7233','host:7233/path','host:7233?x=1']:
        with pytest.raises(ValueError):validate_address(address)
    with pytest.raises(ValueError):tls_config(None)
