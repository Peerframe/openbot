"""Owned product HTTP/process helpers, independent of legacy engine experiment packages."""
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener

REPO=Path(__file__).resolve().parents[2]
CLEAN_ENV={key:os.environ[key] for key in ('PATH','HOME','TMPDIR','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG') if key in os.environ}


class Process:
    def __init__(self,command,directory,env):
        self.directory=directory;directory.mkdir(parents=True,exist_ok=True)
        self.log=(directory/'process.log').open('w')
        self.process=subprocess.Popen(command,env=env,cwd=REPO,stdout=self.log,
            stderr=subprocess.STDOUT,start_new_session=True)
    def alive(self):
        if self.process.poll() is not None:raise AssertionError('Fixture exited: '+self.diagnostic())
    def diagnostic(self):return (self.directory/'process.log').read_text()[-6000:]
    def kill(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid,signal.SIGKILL);self.process.wait(timeout=5)
        self.log.close()


class API:
    def __init__(self,directory,dsn,artifacts):
        self.directory=directory/'api'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        self.url=f'http://127.0.0.1:{port}'
        self.password=secrets.token_hex(24)
        self.opener=build_opener(HTTPCookieProcessor(CookieJar()))
        self.env={**CLEAN_ENV,'PYTHONDONTWRITEBYTECODE':'1','OPENBOT_CONTROL_DATABASE_URL':dsn,
            'OPENBOT_CONTROL_COOKIE_MODE':'loopback','OPENBOT_CONTROL_PORT':str(port),
            'OPENBOT_CONTROL_OWNER_PASSWORD':self.password,'OPENBOT_CONTROL_ARTIFACT_ROOT':str(artifacts)}
        self.child=None
    def call(self,path,body=None,*,expected=200,raw=False):
        request=Request(self.url+path,None if body is None else json.dumps(body).encode(),
            {'Content-Type':'application/json','Origin':self.url})
        try:response=self.opener.open(request,timeout=5)
        except HTTPError as error:response=error
        with response:
            content=response.read()
            if response.status!=expected:raise AssertionError((path,response.status,content[:500]))
            if raw:
                assert response.headers['X-Content-Type-Options']=='nosniff'
                assert response.headers['Content-Disposition'].startswith('attachment;')
                return content
            return json.loads(content) if content else None
    def snapshot(self,task_id):return self.call('/api/v1/tasks/'+task_id)
    def close(self):
        if self.child:self.child.kill()
