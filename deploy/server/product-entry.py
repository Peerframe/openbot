"""Fixed container preflight/migration, then exec the existing Python product authority as PID1."""
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
PYTHON='/opt/openbot/venv/bin/python'
NODE='/usr/local/bin/node'


def environment(values):
    if values.get('OPENBOT_CONTROL_HOST','127.0.0.1') not in ('127.0.0.1','0.0.0.0'):
        raise ValueError('invalid_product_host')
    env={k:v for k,v in values.items() if k.startswith('OPENBOT_CONTROL_')
         or k in ('OPENBOT_OWNER_NAME','TAVILY_API_KEY')}
    env.update(PATH='/usr/local/bin:/usr/bin:/bin',LANG='C.UTF-8',PYTHONDONTWRITEBYTECODE='1',PYTHONUNBUFFERED='1')
    for key in tuple(env):
        if not env[key]:del env[key]
    if env.get('OPENBOT_CONTROL_AUTHORITY')!='product':raise ValueError('product_authority_required')
    port=env.get('OPENBOT_CONTROL_PORT','3001')
    if not port.isascii() or not port.isdigit() or not 1<=int(port)<=65535:raise ValueError('invalid_product_port')
    if env.get('OPENBOT_CONTROL_COOKIE_MODE','secure') not in ('secure','loopback'):raise ValueError('invalid_cookie_mode')
    if not env.get('OPENBOT_CONTROL_DATABASE_URL'):raise ValueError('explicit_database_required')
    from openbot_server.auth import OwnerAuthentication
    from openbot_server.auth_routes import validate_origins
    OwnerAuthentication(None,owner_name=env.get('OPENBOT_OWNER_NAME','Owner'),
        password=env.get('OPENBOT_CONTROL_OWNER_PASSWORD'),ttl_hours=int(env.get('OPENBOT_CONTROL_SESSION_TTL_HOURS','12')))
    validate_origins(tuple(x.strip() for x in env.get('OPENBOT_CONTROL_ALLOWED_ORIGINS','').split(',') if x.strip()))
    expected={'OPENBOT_CONTROL_OBJECT_ROOT':'/var/lib/openbot/objects',
        'OPENBOT_CONTROL_ARTIFACT_ROOT':'/var/lib/openbot/artifacts','OPENBOT_CONTROL_MODEL_DIRECTORY':'/var/lib/openbot/model',
        'OPENBOT_CONTROL_NODE_EXECUTABLE':NODE,'OPENBOT_CONTROL_NODE_MODULE_ROOT':str(ROOT/'node_modules'),
        'OPENBOT_CONTROL_WEB_ROOT':str(ROOT/'apps/web/dist')}
    if any(env.get(k)!=v for k,v in expected.items()):raise ValueError('fixed_product_paths_required')
    return env


def preflight(env):
    spec=importlib.util.spec_from_file_location('product_environment',ROOT/'apps/server-python/scripts/verify_environment.py')
    verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(verifier);verifier.verify(worker=True)
    for name in ('OBJECT_ROOT','ARTIFACT_ROOT','MODEL_DIRECTORY'):
        path=Path(env['OPENBOT_CONTROL_'+name]);info=path.lstat()
        if path.resolve()!=path or not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)!=0o700:
            raise ValueError('unsafe_product_directory')
    engine=env.get('OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH')
    if engine:
        from openbot_server.work_product_service import configuration
        configuration(engine)  # Local strict mTLS files only; connection belongs to the existing service.
    if env.get('OPENBOT_CONTROL_COMMAND_CONFIG_PATH') and not engine:raise ValueError('command_engine_required')
    subprocess.run([NODE,str(ROOT/'deploy/server/product-preflight.mjs')],env={'PATH':env['PATH']},
        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=20)


def main():
    os.umask(0o077)
    sys.path[:0]=[str(ROOT/'apps/server-python/src'),str(ROOT/'apps/agent-runtime-python/src')]
    try:
        env=environment(os.environ);preflight(env)
    except Exception:
        raise SystemExit('Python product preflight failed; no migration was started.') from None
    try:
        subprocess.run([NODE,str(ROOT/'deploy/server/product-migrate.mjs')],
            env={'PATH':env['PATH'],'OPENBOT_DATABASE_URL':env['OPENBOT_CONTROL_DATABASE_URL']},
            stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=60)
    except Exception:
        raise SystemExit('Python product migration failed; API was not started.') from None
    os.execve(PYTHON,[PYTHON,'-I','-B',str(ROOT/'apps/server-python/scripts/serve.py')],env)


if __name__=='__main__':main()
