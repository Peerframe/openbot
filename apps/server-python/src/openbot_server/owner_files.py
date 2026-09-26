"""Existing attachment layout, scoped metadata and immutable bytes under one control-owned lock."""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
from uuid import uuid4

from .control_errors import ControlError
from .models import iso_timestamp

MAX_BYTES = 10*1024*1024
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', re.I | re.ASCII)
TEXT_EXTENSIONS = set('txt md markdown csv tsv json jsonl yaml yml xml html css js jsx ts tsx mjs cjs py go rs java c cpp cxx h hpp swift kt kts sh bash zsh sql toml ini conf log r rb php vue svelte diff patch tex rst ipynb srt'.split())
OFFICE = dict(docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx='application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt='application/vnd.oasis.opendocument.text',ods='application/vnd.oasis.opendocument.spreadsheet',
    odp='application/vnd.oasis.opendocument.presentation')
MEDIA = set(OFFICE.values()) | set('text/plain image/png image/jpeg application/pdf audio/mpeg audio/wav audio/mp4 audio/webm video/mp4 video/webm'.split())


def valid_name(name):
    if (type(name) is not str or not 1 <= len(name) <= 160 or not name[0].isalnum()
            or any(not (c.isalnum() or c in ' ._()-') for c in name)):
        raise ControlError(400, 'invalid_attachment_name')
    return name


def validate_attachment(name, data):
    valid_name(name)
    if not data or len(data)>MAX_BYTES:
        raise ControlError(413, 'attachment_size_limit')
    ext = name.rsplit('.',1)[-1].lower()
    if ext in TEXT_EXTENSIONS:
        if len(data)>256*1024: raise ControlError(413,'text_attachment_size_limit')
        try:
            if '\0' in data.decode('utf-8'): raise ValueError()
        except (UnicodeError,ValueError): raise ControlError(415,'attachment_utf8_required') from None
        return 'text/plain'
    if ext in ('png','jpg','jpeg'):
        if len(data)>5*1024*1024: raise ControlError(413,'image_attachment_size_limit')
        if ext=='png' and data.startswith(b'\x89PNG\r\n\x1a\n'): return 'image/png'
        if ext!='png' and data.startswith(b'\xff\xd8\xff') and data.endswith(b'\xff\xd9'): return 'image/jpeg'
    elif ext=='pdf' and re.match(rb'%PDF-[12]\.\d',data[:8]) and b'%%EOF' in data[-1024:]: return 'application/pdf'
    elif ext in OFFICE and data.startswith(b'PK\x03\x04'): return OFFICE[ext]
    elif ext=='wav' and data.startswith(b'RIFF') and data[8:12]==b'WAVE': return 'audio/wav'
    elif ext=='mp3' and (data.startswith(b'ID3') or len(data)>1 and data[0]==255 and data[1]&224==224): return 'audio/mpeg'
    elif ext in ('mp4','m4a') and data[4:8]==b'ftyp': return 'audio/mp4' if ext=='m4a' else 'video/mp4'
    elif ext=='webm' and data.startswith(b'\x1aE\xdf\xa3'): return 'video/webm'
    raise ControlError(415,'attachment_format_refused')


class OwnerFiles:
    def __init__(self, directory):
        self.root = Path(directory)
        if not self.root.is_absolute(): raise ValueError('absolute_attachment_root_required')
        self._lock = asyncio.Lock()

    def _directory(self):
        fd = os.open(self.root, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode)&0o077:
            os.close(fd); raise ControlError(503,'private_attachment_root_required')
        return fd

    @asynccontextmanager
    async def lock(self):
        async with asyncio.timeout(15), self._lock:
            directory = self._directory()
            fd = None
            try:
                fd = os.open('.authority.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=directory)
                while True:
                    try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); break
                    except BlockingIOError: await asyncio.sleep(.05)
                yield
            finally:
                if fd is not None: os.close(fd)
                os.close(directory)

    @staticmethod
    def _name(name):
        base, dot, extension = name.partition('.')
        if not dot or not UUID.fullmatch(base) or extension not in ('json','bin','text.json'):
            raise ControlError(400,'invalid_attachment_identity')

    def _read(self, name, maximum):
        self._name(name)
        directory = self._directory()
        try:
            fd = os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=directory)
            with os.fdopen(fd,'rb') as stream:
                info=os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size>maximum:
                    raise ControlError(503,'invalid_attachment_file')
                data=stream.read(maximum+1)
                if len(data)>maximum: raise ControlError(503,'attachment_file_limit')
                return data
        finally: os.close(directory)

    def _write(self, name, data):
        self._name(name)
        directory=self._directory(); temporary='.pending-'+secrets.token_hex(16)
        try:
            fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=directory)
            with os.fdopen(fd,'wb') as stream:
                stream.write(data);stream.flush();os.fsync(stream.fileno())
            os.rename(temporary,name,src_dir_fd=directory,dst_dir_fd=directory);os.fsync(directory)
        finally:
            try: os.unlink(temporary,dir_fd=directory)
            except FileNotFoundError: pass
            os.close(directory)

    def _remove(self,name):
        self._name(name)
        directory=self._directory()
        try:
            try: os.unlink(name,dir_fd=directory)
            except FileNotFoundError: pass
            os.fsync(directory)
        finally: os.close(directory)

    def metadata(self,channel_id,identity):
        return self._metadata(channel_id,identity)

    def owner_metadata(self,identity):
        return self._metadata(None,identity,owner=True)

    def _metadata(self,channel_id,identity,*,owner=False):
        if ((not owner and (type(channel_id) is not str or not UUID.fullmatch(channel_id)))
                or type(identity) is not str or not UUID.fullmatch(identity)): raise ControlError(404,'attachment_not_found')
        try:
            value=json.loads(self._read(identity+'.json',4096))
            required={'id','name','mediaType','sizeBytes','sha256','createdAt'} | ({'scopeKind','ownerId'} if owner else {'channelId'})
            if (type(value) is not dict or not required<=set(value) or set(value)-required-{'deletedAt','processing'}
                    or value['id']!=identity or (value.get('scopeKind')!='owner' or value.get('ownerId')!='owner' if owner else value['channelId']!=channel_id)
                    or value['mediaType'] not in MEDIA
                    or type(value['sizeBytes']) is not int or not 0<value['sizeBytes']<=MAX_BYTES
                    or not re.fullmatch('[a-f0-9]{64}',value['sha256'])): raise ValueError()
            valid_name(value['name'])
            datetime.fromisoformat(value['createdAt'])
            return value
        except Exception: raise ControlError(404,'attachment_not_found') from None

    def read(self,channel_id,identity):
        return self._read_scoped(channel_id,identity)

    def owner_read(self,identity):
        return self._read_scoped(None,identity,owner=True)

    def _read_scoped(self,channel_id,identity,*,owner=False):
        value=self._metadata(channel_id,identity,owner=owner)
        try:
            data=self._read(identity+'.bin',MAX_BYTES)
            if (len(data)!=value['sizeBytes'] or hashlib.sha256(data).hexdigest()!=value['sha256']
                    or validate_attachment(value['name'],data)!=value['mediaType']): raise ValueError()
            return value,data
        except Exception: raise ControlError(404,'attachment_integrity') from None

    def list(self,channel_id):
        return self._list_scoped(channel_id)

    def owner_list(self):
        return self._list_scoped(None,owner=True)

    def _list_scoped(self,channel_id,*,owner=False):
        directory=self._directory()
        try: names=os.listdir(directory)
        finally: os.close(directory)
        identities=[n[:-5] for n in names if n.endswith('.json') and UUID.fullmatch(n[:-5])]
        if len(identities)>1024: raise ControlError(503,'attachment_count_limit')
        result=[]
        for identity in identities:
            try: result.append(self._metadata(channel_id,identity,owner=owner))
            except ControlError: pass
        return sorted(result,key=lambda x:x['createdAt'],reverse=True)

    def persist(self,channel_id,name,data):
        return self._persist_scoped(channel_id,name,data)

    def owner_persist(self,name,data):
        return self._persist_scoped(None,name,data,owner=True)

    def _persist_scoped(self,channel_id,name,data,*,owner=False):
        if not owner and (type(channel_id) is not str or not UUID.fullmatch(channel_id)): raise ControlError(400,'invalid_channel')
        media=validate_attachment(name,data)
        directory=self._directory()
        try:
            names=[n for n in os.listdir(directory) if n.endswith('.bin') and UUID.fullmatch(n[:-4])]
            sizes=[os.stat(n,dir_fd=directory,follow_symlinks=False).st_size for n in names]
        finally: os.close(directory)
        if len(names)>=1024 or sum(sizes)+len(data)>256*1024*1024: raise ControlError(413,'attachment_quota')
        identity=str(uuid4())
        scope=dict(scopeKind='owner',ownerId='owner') if owner else dict(channelId=channel_id)
        value=dict(id=identity,**scope,name=name,mediaType=media,sizeBytes=len(data),
            sha256=hashlib.sha256(data).hexdigest(),createdAt=iso_timestamp(datetime.now(timezone.utc)))
        self._write(identity+'.bin',data)
        try: self._write(identity+'.json',json.dumps(value,ensure_ascii=False).encode())
        except BaseException:
            self._remove(identity+'.bin');raise
        return value

    def set_deleted(self,channel_id,identity,deleted):
        return self._set_deleted(channel_id,identity,deleted)

    def owner_set_deleted(self,identity,deleted):
        return self._set_deleted(None,identity,deleted,owner=True)

    def _set_deleted(self,channel_id,identity,deleted,*,owner=False):
        value=self._metadata(channel_id,identity,owner=owner)
        if deleted: value.setdefault('deletedAt',iso_timestamp(datetime.now(timezone.utc)))
        else: value.pop('deletedAt',None)
        self._write(identity+'.json',json.dumps(value,ensure_ascii=False).encode())
        return value

    def validate_references(self,channel_id,identities):
        return self._validate_references(channel_id,identities)

    def owner_validate_references(self,identities):
        return self._validate_references(None,identities,owner=True)

    def _validate_references(self,channel_id,identities,*,owner=False):
        if len(identities)>8 or len(set(identities))!=len(identities): raise ControlError(400,'invalid_attachment_references')
        total=0
        for identity in identities:
            item,_=self._read_scoped(channel_id,identity,owner=owner)
            if item.get('deletedAt'): raise ControlError(400,'deleted_attachment')
            total+=item['sizeBytes']
            if total>20*1024*1024: raise ControlError(413,'task_attachment_limit')
            if item.get('processing'):
                derived=json.loads(self._read(identity+'.text.json',2*1024*1024))
                if derived.get('sha256')!=item['sha256'] or not derived.get('text','').strip():
                    raise ControlError(404,'processed_attachment_unavailable')
