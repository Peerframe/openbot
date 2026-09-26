"""Single-writer encrypted plugin store, compatible with the retained Node envelope."""
import asyncio
import base64
from contextlib import contextmanager, asynccontextmanager
import hmac
import json
import os
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .model_settings import _atomic_write, _open_directory, _read_file, _check_file, _identity
from .control_errors import ControlError
from .plugin_inputs import PluginError, State, bounded, clone, parse

if os.name == 'posix':
    import fcntl

_LIMIT = 3*1024*1024
_AAD = b'openbot.plugins/v1'


@asynccontextmanager
async def internal_guard():
    yield


class FilePluginStore:
    """Serialize every read/write, and hide publications until the authority guard commits.

    Existing TS writers do not honor this lease: composition must select only one Server.
    A pending journal restores the previous state after a crash or failed Owner commit.
    """
    def __init__(self, path):
        self.path = Path(path)
        self._lock = asyncio.Lock()
        self._name = self.path.name
        self._key_name = self._name+'.key'
        self._journal = '.'+self._name+'.pending'
        self._lock_name = '.'+self._name+'.lock'
        try:
            with self._lease(create=True) as root:
                key = _read_file(root,self._key_name,32)
                if key is None:
                    if _read_file(root,self._name,_LIMIT) is not None or _read_file(root,self._journal,5*1024*1024) is not None:
                        raise PluginError('unavailable')
                    key = os.urandom(32)
                    _atomic_write(root,self._key_name,key)
                if len(key)!=32: raise PluginError('unavailable')
                self._key=key
                self._recover(root)
                self._load(root)
        except Exception:
            raise PluginError('unavailable') from None

    @contextmanager
    def _lease(self, create=False):
        root = lock = None
        try:
            root = _open_directory(self.path.parent,create=create)
            identity = _identity(os.fstat(root))
            if hasattr(self,'_identity') and self._identity != identity: raise PluginError('unavailable')
            self._identity=identity
            lock = os.open(self._lock_name,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,0o600,dir_fd=root)
            _check_file(os.fstat(lock),0)
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            if _identity(os.stat(self._lock_name,dir_fd=root,follow_symlinks=False)) != _identity(os.fstat(lock)):
                raise PluginError('unavailable')
            yield root
        finally:
            if lock is not None: os.close(lock)
            if root is not None: os.close(root)

    def _decrypt(self, encoded):
        envelope=json.loads(encoded)
        if set(envelope)!={'version','nonce','tag','ciphertext'} or type(envelope['version']) is not int or envelope['version']!=1:
            raise ValueError()
        nonce,tag,cipher=(base64.b64decode(envelope[k],validate=True) for k in ('nonce','tag','ciphertext'))
        if len(nonce)!=12 or len(tag)!=16: raise ValueError()
        plain=AESGCM(self._key).decrypt(nonce,cipher+tag,_AAD)
        if len(plain)>2*1024*1024: raise ValueError()
        return parse(State,json.loads(plain),2*1024*1024)

    def _encrypt(self,state):
        plain=bounded(parse(State,state,2*1024*1024),2*1024*1024)
        nonce=os.urandom(12)
        encrypted=AESGCM(self._key).encrypt(nonce,plain,_AAD)
        return bounded({'version':1,'nonce':base64.b64encode(nonce).decode(),
                        'tag':base64.b64encode(encrypted[-16:]).decode(),
                        'ciphertext':base64.b64encode(encrypted[:-16]).decode()},_LIMIT)

    def _load(self,root):
        key=_read_file(root,self._key_name,32)
        if key is None or not hmac.compare_digest(key,self._key): raise PluginError('unavailable')
        encoded=_read_file(root,self._name,_LIMIT)
        return self._decrypt(encoded) if encoded is not None else {'plugins':[],'audit':[]}

    def _restore(self,root,previous):
        if previous is not None: _atomic_write(root,self._name,previous)
        else:
            try: os.unlink(self._name,dir_fd=root)
            except FileNotFoundError: pass
        os.unlink(self._journal,dir_fd=root)
        os.fsync(root)

    def _recover(self,root):
        encoded=_read_file(root,self._journal,5*1024*1024)
        if encoded is None: return
        journal=json.loads(encoded)
        if set(journal)!={'version','previous'} or journal['version']!=1: raise ValueError()
        previous=base64.b64decode(journal['previous'],validate=True) if journal['previous'] is not None else None
        if previous is not None:
            if len(previous)>_LIMIT: raise ValueError()
            self._decrypt(previous)
        _read_file(root,self._name,_LIMIT)
        self._restore(root,previous)

    async def read(self):
        async with self._lock:
            try:
                with self._lease() as root:
                    self._recover(root)
                    return clone(self._load(root))
            except Exception:
                raise PluginError('unavailable') from None

    async def transaction(self, change, *, authority=internal_guard):
        async with self._lock:
            try:
                with self._lease() as root:
                    self._recover(root)
                    written=False
                    previous=None
                    try:
                        async with authority():
                            state=self._load(root)
                            result=change(state)
                            if hasattr(result,'__await__'): result=await result
                            encoded=self._encrypt(state)
                            previous=_read_file(root,self._name,_LIMIT)
                            _atomic_write(root,self._journal,bounded({'version':1,'previous':base64.b64encode(previous).decode() if previous is not None else None},5*1024*1024))
                            written=True
                            _atomic_write(root,self._name,encoded)
                        os.unlink(self._journal,dir_fd=root)
                        os.fsync(root)
                        written=False
                        return clone(result)
                    except BaseException:
                        if written: self._restore(root,previous)
                        raise
            except ControlError as error:
                if isinstance(error,PluginError):raise
                raise PluginError('unavailable') from None
            except (OSError,ValueError,TypeError):
                raise PluginError('unavailable') from None
