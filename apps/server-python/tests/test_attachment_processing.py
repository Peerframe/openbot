"""Actual released parser engines plus owned-PostgreSQL file authority/lifecycle checks."""
import asyncio
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import struct
import subprocess
import time
import zipfile

import httpx2
import psycopg
import pytest
from pydantic import ValidationError

from openbot_server.attachment_processing import (AttachmentProcessingService, NodeAttachmentParser,
    MAX_RESPONSE, MAX_TEXT, assert_bounded_image, parse_process_input)
from openbot_server.authority import AuthenticationRequired
from openbot_server.control_errors import ControlError
from openbot_server.owner_files import OwnerFiles
from test_automation_store import seed, synthetic_db

ROOT = Path(os.environ.get('OPENBOT_PARSER_TEST_ROOT', Path(__file__).resolve().parents[3]))
MODULES = ROOT / 'node_modules'


def parser(**kwargs):
    if not (MODULES / 'officeparser').is_dir() or not shutil.which('node'):
        pytest.skip('Requires the existing exact npm parser dependency installation')
    return NodeAttachmentParser(module_root=MODULES, **kwargs)


def office(extension='docx', *, entries=None):
    if entries is None:
        if extension == 'docx':
            entries = {'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
                'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>OpenBot document evidence</w:t></w:r></w:p></w:body></w:document>'}
        elif extension == 'xlsx':
            entries = {'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>',
                'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
                'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>OpenBot spreadsheet evidence</t></is></c></row></sheetData></worksheet>'}
        elif extension == 'pptx':
            entries = {'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>',
                'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>OpenBot slide evidence</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'}
        else:
            kind = {'odt':'text','ods':'spreadsheet','odp':'presentation'}[extension]
            paragraph = '<text:p>OpenBot ODF evidence</text:p>'
            body = (paragraph if extension == 'odt' else '<table:table table:name="Sheet"><table:table-row><table:table-cell office:value-type="string">'+paragraph+'</table:table-cell></table:table-row></table:table>'
                    if extension == 'ods' else '<draw:page draw:name="Slide"><draw:frame><draw:text-box>'+paragraph+'</draw:text-box></draw:frame></draw:page>')
            entries = {'mimetype': 'application/vnd.oasis.opendocument.'+kind,
                'content.xml': f'<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body><office:{kind}>{body}</office:{kind}></office:body></office:document-content>'}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in entries.items():
            archive.writestr(name,value)
    return stream.getvalue()


def png():
    # Same locally-authored canvas fixture as the existing TypeScript parser suite.
    script = "const {createCanvas}=require(process.argv[1]);const c=createCanvas(700,120);const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,700,120);x.fillStyle='black';x.font='48px sans-serif';x.fillText('OPENBOT 12345',20,80);process.stdout.write(c.toBuffer('image/png'));"
    return subprocess.run([shutil.which('node'), '-e', script, str(MODULES/'@napi-rs/canvas')], check=True, capture_output=True, timeout=10).stdout


@pytest.fixture
def storage(tmp_path):
    location = tmp_path / 'files'
    location.mkdir(mode=0o700)
    return OwnerFiles(location)


def test_input_rejects_extra_operation_null_or_excess_password_and_image_bombs():
    assert parse_process_input({'operation':'extract'}).password is None
    assert parse_process_input({'operation':'extract','password':''}).password == ''
    for value in ({'operation':'parse'}, {'operation':'ocr','password':None}, {'operation':'extract','password':'x'*257},
                  {'operation':'extract','path':'/private'}, {'operation':'extract','password':'🧪'*129}):
        with pytest.raises(ValidationError):
            parse_process_input(value)
    for width,height in ((16001,1),(4001,4000),(0,10)):
        with pytest.raises(ControlError) as error:
            assert_bounded_image(b'\x89PNG\r\n\x1a\n'+b'\0'*8+struct.pack('>II',width,height),'image/png')
        assert error.value.status == 413
    with pytest.raises(ControlError) as error:
        asyncio.run(parser().parse(b'bytes','unsupported',parse_process_input({'operation':'extract'})))
    assert error.value.code == 'attachment_parser_format_refused'


@pytest.mark.parametrize('extension',['docx','xlsx','pptx','odt','ods','odp'])
def test_released_office_parser_extracts_actual_containers(extension):
    result = asyncio.run(parser().parse(office(extension),extension,parse_process_input({'operation':'extract'})))
    assert 'OpenBot' in result['text'] and not result['truncated']


def test_pdf_password_script_action_and_scanned_pdf_remain_distinct():
    async def check():
        worker = parser()
        fixture = ROOT/'tests/oracles/legacy-server/src/__fixtures__/attachments'
        action = await worker.parse((fixture/'script-action.pdf').read_bytes(),'pdf',parse_process_input({'operation':'extract'}))
        assert 'OpenBot action PDF evidence' in action['text'] and 'OPENBOT_PDF_ACTION' not in action['text']
        encrypted = (fixture/'encrypted.pdf').read_bytes()
        result = await worker.parse(encrypted,'pdf',parse_process_input({'operation':'extract','password':'openbot-test-password'}))
        assert 'OpenBot encrypted PDF evidence' in result['text']
        with pytest.raises(ControlError) as error:
            await worker.parse(encrypted,'pdf',parse_process_input({'operation':'extract','password':'incorrect'}))
        assert error.value.code == 'pdf_password_required'
        blank = await worker.parse((fixture/'image-only.pdf').read_bytes(),'pdf',parse_process_input({'operation':'extract'}))
        assert not blank['text'].strip()
    asyncio.run(check())


def test_real_offline_ocr_uses_bundled_languages():
    result = asyncio.run(parser().parse(png(),'png',parse_process_input({'operation':'ocr'})))
    assert '12345' in result['text']


def test_malformed_zip_entry_bomb_text_ceiling_timeout_and_running_cancellation():
    async def check():
        worker = parser()
        for content in (b'PK\x03\x04broken',office(entries={f'entry-{i}.xml':'<data>bounded</data>' for i in range(2001)})):
            with pytest.raises(ControlError) as error:
                await worker.parse(content,'docx',parse_process_input({'operation':'extract'}))
            assert error.value.code == 'attachment_parsing_failed'
        large = office(entries={'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+('A'*(MAX_TEXT+1))+'</w:t></w:r></w:p></w:body></w:document>'})
        result = await worker.parse(large,'docx',parse_process_input({'operation':'extract'}))
        assert len(result['text']) == MAX_TEXT and result['truncated']
        with pytest.raises(ControlError) as error:
            await parser(timeout_seconds=.001).parse(office(),'docx',parse_process_input({'operation':'extract'}))
        assert error.value.code == 'attachment_processing_timed_out'
        cancel = asyncio.Event()
        job = asyncio.create_task(worker.parse(office(),'docx',parse_process_input({'operation':'extract'}),cancelled=cancel))
        await asyncio.sleep(.02)
        cancel.set()
        with pytest.raises(ControlError) as error:
            await job
        assert error.value.code == 'attachment_processing_cancelled'
    asyncio.run(check())


def test_service_persists_exact_layout_and_scope_over_real_owner_transactions(seed,storage):
    original_bytes = office()
    item = storage.persist(seed['channel'],'evidence.docx',original_bytes)
    service = AttachmentProcessingService(seed['dsn'],files=storage,parser=parser())
    ready = asyncio.run(service.process(seed['token'],seed['channel'],item['id'],{'operation':'extract'}))
    assert ready['processing']['operation'] == 'extract' and ready['processing']['characters'] > 0
    derived = json.loads(storage._read(item['id']+'.text.json',MAX_RESPONSE))
    assert derived['sha256'] == item['sha256'] and 'OpenBot document evidence' in derived['text']
    assert storage.read(seed['channel'],item['id'])[1] == original_bytes
    with pytest.raises(AuthenticationRequired):
        asyncio.run(service.process(None,seed['channel'],item['id'],{'operation':'extract'}))
    with pytest.raises(ControlError) as error:
        asyncio.run(service.process(seed['token'],seed['channelId'],item['id'],{'operation':'extract'}))
    assert error.value.status == 404


def test_plain_text_deleted_files_and_scan_are_not_false_extraction_success(seed,storage):
    service = AttachmentProcessingService(seed['dsn'],files=storage,parser=parser())
    text = storage.persist(seed['channel'],'readme.txt',b'Read without extraction')
    with pytest.raises(ControlError) as error:
        asyncio.run(service.process(seed['token'],seed['channel'],text['id'],{'operation':'extract'}))
    assert error.value.code == 'document_extraction_not_required'
    scan = storage.persist(seed['channel'],'scan.pdf',(ROOT/'tests/oracles/legacy-server/src/__fixtures__/attachments/image-only.pdf').read_bytes())
    with pytest.raises(ControlError) as error:
        asyncio.run(service.process(seed['token'],seed['channel'],scan['id'],{'operation':'extract'}))
    assert error.value.code == 'no_readable_pdf_text'
    assert 'processing' not in storage.metadata(seed['channel'],scan['id'])
    storage.set_deleted(seed['channel'],scan['id'],True)
    with pytest.raises(ControlError) as error:
        asyncio.run(service.process(seed['token'],seed['channel'],scan['id'],{'operation':'extract'}))
    assert error.value.code == 'restore_attachment_before_processing'


class DelayedParser:
    def __init__(self):
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def parse(self,*args,**kwargs):
        self.entered.set()
        await self.release.wait()
        return {'text':'Controlled lifecycle result','truncated':False}


def test_concurrency_and_deleted_during_processing_never_commit(seed,storage):
    async def check():
        engine = DelayedParser()
        item = storage.persist(seed['channel'],'evidence.docx',office())
        service = AttachmentProcessingService(seed['dsn'],files=storage,parser=engine)
        first = asyncio.create_task(service.process(seed['token'],seed['channel'],item['id'],{'operation':'extract'}))
        await engine.entered.wait()
        second = asyncio.create_task(service.process(seed['token'],seed['channel'],item['id'],{'operation':'extract'}))
        await asyncio.sleep(.02)
        with pytest.raises(ControlError) as error:
            await service.process(seed['token'],seed['channel'],item['id'],{'operation':'extract'})
        assert error.value.code == 'attachment_processing_busy'
        async with storage.lock():
            storage.set_deleted(seed['channel'],item['id'],True)
        engine.release.set()
        result = await asyncio.gather(first,second,return_exceptions=True)
        assert all(isinstance(error,ControlError) and error.code == 'attachment_changed_or_deleted' for error in result)
        assert 'processing' not in storage.metadata(seed['channel'],item['id']) and service._active == 0
    asyncio.run(check())


class Settings:
    def __init__(self, before=None, **overrides):
        self.before=before
        self.value={'provider':'openai','apiKey':'synthetic-not-a-real-secret','agentEnabled':True,
                    'agentEnabledAt':'2026-09-24T00:00:00Z',**overrides}
    async def active(self):
        if self.before:
            self.before()
        return self.value


def test_transcription_official_sdk_only_on_explicit_enabled_action_and_bounded_result(seed,storage):
    calls=[]
    def respond(request):
        calls.append(request)
        assert str(request.url) == 'https://api.openai.com/v1/audio/transcriptions'
        assert request.headers['authorization'] == 'Bearer synthetic-not-a-real-secret'
        assert b'whisper-1' in request.content and b'ID3synthetic' in request.content
        return httpx2.Response(200,json={'text':'Owner requested transcription'},request=request)
    item=storage.persist(seed['channel'],'speech.mp3',b'ID3synthetic')
    service=AttachmentProcessingService(seed['dsn'],files=storage,settings=Settings(),transport=httpx2.MockTransport(respond))
    assert calls == []
    result=asyncio.run(service.process(seed['token'],seed['channel'],item['id'],{'operation':'transcribe'}))
    assert result['processing']['operation'] == 'transcribe' and len(calls) == 1
    assert json.loads(storage._read(item['id']+'.text.json',MAX_RESPONSE))['text'] == 'Owner requested transcription'
    for settings in (None,Settings(agentEnabled=False),Settings(provider='anthropic'),Settings(baseUrl='https://example.invalid/v1')):
        refused=AttachmentProcessingService(seed['dsn'],files=storage,settings=settings,transport=httpx2.MockTransport(respond))
        with pytest.raises(ControlError):
            asyncio.run(refused.process(seed['token'],seed['channel'],item['id'],{'operation':'transcribe'}))
    assert len(calls) == 1


def test_revoked_owner_after_settings_load_prevents_any_provider_transfer(seed,storage):
    token=secrets.token_urlsafe(32)
    digest=hashlib.sha256(token.encode()).hexdigest()
    with psycopg.connect(seed['dsn']) as db:
        db.execute("INSERT INTO auth_sessions(id,token_digest,expires_at) VALUES (%s,%s,now()+interval '1 hour')",(digest,digest))
    def revoke():
        with psycopg.connect(seed['dsn']) as db:
            db.execute('UPDATE auth_sessions SET revoked_at=now() WHERE token_digest=%s',(digest,))
    calls=[]
    item=storage.persist(seed['channel'],'speech.mp3',b'ID3synthetic')
    service=AttachmentProcessingService(seed['dsn'],files=storage,settings=Settings(before=revoke),transport=httpx2.MockTransport(lambda request:calls.append(request)))
    try:
        with pytest.raises(AuthenticationRequired):
            asyncio.run(service.process(token,seed['channel'],item['id'],{'operation':'transcribe'}))
        assert calls == []
    finally:
        with psycopg.connect(seed['dsn']) as db:
            db.execute('DELETE FROM auth_sessions WHERE token_digest=%s',(digest,))


@pytest.mark.parametrize('kind',['oversize','redirect','empty','malformed'])
def test_transcription_failures_are_bounded_and_never_save_derived(seed,storage,kind):
    def respond(request):
        if kind=='oversize': return httpx2.Response(200,content=b'x'*(MAX_RESPONSE+1),request=request)
        if kind=='redirect': return httpx2.Response(302,headers={'location':'https://example.invalid'},request=request)
        if kind=='empty': return httpx2.Response(200,json={'text':' \n\t'},request=request)
        return httpx2.Response(200,json={'text':None},request=request)
    item=storage.persist(seed['channel'],'speech.mp3',b'ID3synthetic')
    service=AttachmentProcessingService(seed['dsn'],files=storage,settings=Settings(),transport=httpx2.MockTransport(respond))
    with pytest.raises(ControlError) as error:
        asyncio.run(service.process(seed['token'],seed['channel'],item['id'],{'operation':'transcribe'}))
    if kind == 'oversize':
        assert error.value.status == 413
    assert 'processing' not in storage.metadata(seed['channel'],item['id'])
    assert not (storage.root/(item['id']+'.text.json')).exists()


def test_task_cancellation_reaps_actual_child_and_does_not_inherit_secrets(monkeypatch):
    import openbot_server.attachment_processing as module
    original = module.PipeProcess
    children = []
    class ObservedProcess(original):
        def __init__(self,*args,**kwargs):
            assert kwargs['env'] == {'LANG':'C.UTF-8'}
            assert '--permission' in args[1]
            super().__init__(*args,**kwargs)
            children.append(self)
    monkeypatch.setattr(module,'PipeProcess',ObservedProcess)
    monkeypatch.setenv('OPENBOT_DATABASE_URL','synthetic-must-not-be-inherited')
    async def check():
        pending = asyncio.create_task(parser().parse(office(),'docx',parse_process_input({'operation':'extract'})))
        while not children:
            await asyncio.sleep(.001)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert children[0].returncode is not None
        with pytest.raises(ProcessLookupError):
            os.kill(children[0].pid,0)
    asyncio.run(check())


def test_fixed_network_preload_is_inherited_by_nested_parser_worker(tmp_path):
    import openbot_server.attachment_processing as module
    worker = "const {parentPort}=require('node:worker_threads');try {require('node:net').connect(9,'127.0.0.1');parentPort.postMessage('FAILED');}catch(error){parentPort.postMessage(error.message)}"
    worker_path = tmp_path/'network-guard.cjs'
    worker_path.write_text(worker)
    program = "const {Worker}=require('node:worker_threads');const worker=new Worker("+json.dumps(str(worker_path))+");worker.once('message',value=>{process.stdout.write(value);worker.terminate()});"
    result = subprocess.run([shutil.which('node'),'--import',str(module.PARSER_WORKER),'-e',program],
                            capture_output=True,timeout=10,check=True,env={'LANG':'C.UTF-8'})
    assert result.stdout == b'parser_network_refused'


def test_expiry_at_final_file_commit_restores_metadata_and_existing_derived_text(seed,storage,monkeypatch):
    token=secrets.token_urlsafe(32)
    digest=hashlib.sha256(token.encode()).hexdigest()
    with psycopg.connect(seed['dsn']) as db:
        db.execute("INSERT INTO auth_sessions(id,token_digest,expires_at) VALUES (%s,%s,now()+interval '1 hour')",(digest,digest))
    item=storage.persist(seed['channel'],'evidence.docx',office())
    prior_text=json.dumps({'text':'Previous valid derived text','sha256':item['sha256'],'operation':'extract','truncated':False,
                           'processedAt':'2026-09-24T00:00:00.000Z'}).encode()
    prior_metadata=storage._read(item['id']+'.json',4096)
    storage._write(item['id']+'.text.json',prior_text)
    write=storage._write
    armed=True
    def delayed_write(name,data):
        nonlocal armed
        write(name,data)
        if armed and name == item['id']+'.json':
            armed=False
            time.sleep(.4)
    monkeypatch.setattr(storage,'_write',delayed_write)
    class ExpiringParser:
        async def parse(self,*args,**kwargs):
            with psycopg.connect(seed['dsn']) as db:
                db.execute("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE token_digest=%s",(digest,))
            return {'text':'This result must not survive expiry','truncated':False}
    try:
        service=AttachmentProcessingService(seed['dsn'],files=storage,parser=ExpiringParser())
        with pytest.raises(AuthenticationRequired):
            asyncio.run(service.process(token,seed['channel'],item['id'],{'operation':'extract'}))
        assert not armed
        assert storage._read(item['id']+'.json',4096) == prior_metadata
        assert storage._read(item['id']+'.text.json',MAX_RESPONSE) == prior_text
    finally:
        with psycopg.connect(seed['dsn']) as db:
            db.execute('DELETE FROM auth_sessions WHERE token_digest=%s',(digest,))


def test_cancellation_during_settings_load_prevents_media_transfer(seed,storage):
    event=asyncio.Event()
    calls=[]
    item=storage.persist(seed['channel'],'speech.mp3',b'ID3synthetic')
    service=AttachmentProcessingService(seed['dsn'],files=storage,settings=Settings(before=event.set),
        transport=httpx2.MockTransport(lambda request:calls.append(request)))
    with pytest.raises(ControlError) as error:
        asyncio.run(service.process(seed['token'],seed['channel'],item['id'],{'operation':'transcribe'},cancelled=event))
    assert error.value.code == 'attachment_processing_cancelled' and calls == []


def test_cancellation_while_waiting_for_save_lock_does_not_publish(seed,storage):
    item=storage.persist(seed['channel'],'evidence.docx',office())
    event=asyncio.Event()
    service=AttachmentProcessingService(seed['dsn'],files=storage)
    async def check():
        async with storage.lock():
            save=asyncio.create_task(service._save(seed['token'],seed['channel'],item['id'],{
                'text':'Cancelled output','sha256':item['sha256'],'operation':'extract','truncated':False,
                'processedAt':'2026-09-24T00:00:00.000Z'},cancelled=event))
            await asyncio.sleep(.02)
            event.set()
        with pytest.raises(ControlError) as error:
            await save
        assert error.value.code == 'attachment_processing_cancelled'
        assert 'processing' not in storage.metadata(seed['channel'],item['id'])
        assert not (storage.root/(item['id']+'.text.json')).exists()
    asyncio.run(check())
