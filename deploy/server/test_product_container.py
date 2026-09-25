"""No Docker/DB/provider execution: validate the fixed entry and migration/exec ordering."""
import importlib.util
from pathlib import Path
import subprocess
import sys

import pytest

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('product_container_entry',HERE/'product-entry.py')
entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)


def values():
    return {'OPENBOT_CONTROL_AUTHORITY':'product','OPENBOT_CONTROL_DATABASE_URL':'postgresql://synthetic/unused',
        'OPENBOT_CONTROL_OWNER_PASSWORD':'synthetic-container-owner-password','OPENBOT_CONTROL_COOKIE_MODE':'loopback',
        'OPENBOT_CONTROL_ALLOWED_ORIGINS':'http://localhost:3001','OPENBOT_CONTROL_OBJECT_ROOT':'/var/lib/openbot/objects',
        'OPENBOT_CONTROL_ARTIFACT_ROOT':'/var/lib/openbot/artifacts','OPENBOT_CONTROL_MODEL_DIRECTORY':'/var/lib/openbot/model',
        'OPENBOT_CONTROL_NODE_EXECUTABLE':entry.NODE,'OPENBOT_CONTROL_NODE_MODULE_ROOT':str(entry.ROOT/'node_modules'),
        'OPENBOT_CONTROL_WEB_ROOT':str(entry.ROOT/'apps/web/dist')}


@pytest.mark.parametrize('change',[{'OPENBOT_CONTROL_AUTHORITY':'read-only'},{'OPENBOT_CONTROL_DATABASE_URL':''},
    {'OPENBOT_CONTROL_HOST':''},{'OPENBOT_CONTROL_HOST':'localhost'},{'OPENBOT_CONTROL_HOST':'::'},
    {'OPENBOT_CONTROL_OWNER_PASSWORD':''},{'OPENBOT_CONTROL_OWNER_PASSWORD':'short'},
    {'OPENBOT_CONTROL_ALLOWED_ORIGINS':'*'},{'OPENBOT_CONTROL_ALLOWED_ORIGINS':'https://example.invalid/path'},
    {'OPENBOT_CONTROL_COOKIE_MODE':'auto'},{'OPENBOT_CONTROL_PORT':'0'},{'OPENBOT_CONTROL_SESSION_TTL_HOURS':'169'},
    {'OPENBOT_CONTROL_NODE_EXECUTABLE':'/tmp/untrusted-node'}])
def test_bad_configuration_never_reaches_migration_or_exec(monkeypatch,change):
    monkeypatch.setattr(entry.os,'environ',{**values(),**change})
    monkeypatch.setattr(entry,'preflight',lambda env:pytest.fail('No environment preflight after invalid inputs'))
    monkeypatch.setattr(entry.subprocess,'run',lambda *a,**k:pytest.fail('No migration'))
    monkeypatch.setattr(entry.os,'execve',lambda *a:pytest.fail('No Server exec'))
    monkeypatch.setattr(sys,'path',sys.path.copy())
    with pytest.raises(SystemExit,match='preflight failed; no migration'):entry.main()


def test_explicit_env_has_no_ambient_proxy_python_or_model_fallback():
    env=entry.environment({**values(),'HTTPS_PROXY':'private-proxy','PYTHONPATH':'untrusted','OPENAI_API_KEY':'ambient-key',
        'OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH':'','OPENBOT_CONTROL_COMMAND_CONFIG_PATH':''})
    assert all(key not in env for key in ('HTTPS_PROXY','PYTHONPATH','OPENAI_API_KEY',
        'OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH','OPENBOT_CONTROL_COMMAND_CONFIG_PATH'))
    assert env['OPENBOT_CONTROL_COOKIE_MODE']=='loopback'


def test_preflight_failure_is_sanitized_and_does_not_migrate(monkeypatch):
    monkeypatch.setattr(entry.os,'environ',values());monkeypatch.setattr(sys,'path',sys.path.copy())
    def fail(env):raise ValueError('private-input-token')
    monkeypatch.setattr(entry,'preflight',fail)
    monkeypatch.setattr(entry.subprocess,'run',lambda *a,**k:pytest.fail('No migration'))
    with pytest.raises(SystemExit) as error:entry.main()
    assert str(error.value)=='Python product preflight failed; no migration was started.'


def test_original_migrator_then_exec_has_separate_minimal_environments(monkeypatch):
    calls=[];monkeypatch.setattr(entry.os,'environ',values());monkeypatch.setattr(sys,'path',sys.path.copy())
    monkeypatch.setattr(entry,'preflight',lambda env:calls.append('preflight'))
    def run(args,**kw):
        assert calls==['preflight'];calls.append('migrate')
        assert args==[entry.NODE,str(entry.ROOT/'deploy/server/product-migrate.mjs')]
        assert set(kw['env'])=={'PATH','OPENBOT_DATABASE_URL'} and kw['timeout']==60
        assert kw['stdin']==kw['stdout']==kw['stderr']==subprocess.DEVNULL
    def execute(executable,args,env):
        assert calls==['preflight','migrate'];calls.append('exec')
        assert executable==entry.PYTHON and args==[entry.PYTHON,'-I','-B',str(entry.ROOT/'apps/server-python/scripts/serve.py')]
        assert env['OPENBOT_CONTROL_AUTHORITY']=='product' and 'OPENBOT_DATABASE_URL' not in env
    monkeypatch.setattr(entry.subprocess,'run',run);monkeypatch.setattr(entry.os,'execve',execute)
    entry.main();assert calls==['preflight','migrate','exec']


def test_migration_failure_cannot_exec_or_disclose_private_details(monkeypatch):
    monkeypatch.setattr(entry.os,'environ',values());monkeypatch.setattr(sys,'path',sys.path.copy())
    monkeypatch.setattr(entry,'preflight',lambda env:None)
    def fail(*a,**kw):raise OSError('private-dsn')
    monkeypatch.setattr(entry.subprocess,'run',fail)
    monkeypatch.setattr(entry.os,'execve',lambda *a:pytest.fail('No fallback API'))
    with pytest.raises(SystemExit) as error:entry.main()
    assert str(error.value)=='Python product migration failed; API was not started.'
