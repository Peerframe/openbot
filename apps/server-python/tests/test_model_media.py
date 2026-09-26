"""Actual pinned SDK encoders over synthetic HTTP; no provider credentials or network."""
import asyncio
import base64
from dataclasses import replace
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import pytest
pytest.importorskip('pydantic_ai', reason='Optional Worker SDK profile is required')
import httpx2
from pydantic_ai.messages import BinaryContent, ModelRequest, UserPromptPart
from openbot_agent_runtime.contracts import ModelStepRequest
from openbot_server.model_connections_inputs import ResolvedModelConnection
from openbot_server.model_connections_port import ModelConnectionPort
from openbot_server.model_media import (MediaItem, PreparedModelMedia, adapt_wire, media_reference,
                                       MAX_RAW_BYTES, BASE_WIRE_BYTES)
from openbot_server.product_model import ProductModelPort, ProductModelError
from openbot_server.work_values import InvalidWork, WorkConflict

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=')
JPEG = b'\xff\xd8\xffsynthetic-jpeg-wire-only\xff\xd9'
PDF = b'%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\n%%EOF'
DATA = (('图像.png', 'image/png', PNG), ('照片.jpeg', 'image/jpeg', JPEG), ('年度报告.pdf', 'application/pdf', PDF))


def prepared(data=DATA):
    return PreparedModelMedia(dict(version=1, sha256='a'*64, sizeBytes=123), tuple(
        MediaItem(str(n), name, mime, hashlib.sha256(value).hexdigest(), value)
        for n, (name, mime, value) in enumerate(data)))


def request(content='Inspect original sources'):
    stamp = datetime(2000, 1, 1, tzinfo=timezone.utc)
    return ModelStepRequest(step=1, tools=(), messages=[ModelRequest(
        parts=[UserPromptPart(content, timestamp=stamp)], timestamp=stamp)])


def response(body, protocol):
    if protocol == 'responses-v1':
        return dict(id='synthetic', object='response', created_at=1, model=body['model'], status='completed',
            output=[dict(id='m', type='message', role='assistant', status='completed',
                content=[dict(type='output_text', text='Observed', annotations=[])])],
            usage=dict(input_tokens=1, output_tokens=1, total_tokens=2))
    if protocol == 'anthropic-messages-v1':
        return dict(id='synthetic', type='message', role='assistant', model=body['model'],
            content=[dict(type='text', text='Observed')], stop_reason='end_turn', stop_sequence=None,
            usage=dict(input_tokens=1, output_tokens=1))
    return dict(id='synthetic', object='chat.completion', created=1, model=body['model'],
        choices=[dict(index=0, finish_reason='stop', message=dict(role='assistant', content='Observed'))],
        usage=dict(prompt_tokens=1, completion_tokens=1, total_tokens=2))


def port(protocol, send, loader=None, before=None, provider=None):
    if protocol == 'chat-completions-v1':
        return ModelConnectionPort(ResolvedModelConnection('synthetic', 1, provider or 'openai', 'openai-chat',
            'https://api.openai.com/v1', 'synthetic-model', 'synthetic-key-only-not-real'),
            transport=httpx2.MockTransport(send), media_loader=loader, before_send=before)
    return ProductModelPort(dict(provider=provider or ('openai' if protocol == 'responses-v1' else 'anthropic'),
        model='synthetic-model', apiKey='synthetic-key-only-not-real', revision=None),
        transport=httpx2.MockTransport(send), media_loader=loader, before_send=before)


@pytest.mark.parametrize('protocol', ['responses-v1', 'chat-completions-v1', 'anthropic-messages-v1'])
def test_sdk_three_protocol_bytes_names_and_request_detachment(protocol):
    async def check():
        calls, order = [], []
        media = prepared(); original = request()
        async def load(): order.append('hydrate'); return media
        async def before(): order.append('fresh')
        def send(req):
            order.append('send'); calls.append(json.loads(req.content))
            assert int(req.headers['content-length']) == len(req.content)
            return httpx2.Response(200, json=response(calls[-1], protocol))
        async with port(protocol, send, load, before) as model:
            assert (await model(original)).text == 'Observed'
        assert order == ['hydrate', 'fresh', 'send']
        assert len(original.messages) == 1 and type(original.messages[0].parts[0].content) is str
        body = json.dumps(calls[0], ensure_ascii=False).encode()
        # Revalidation succeeds only if the SDK generated every byte in the original order.
        adapted = json.loads(adapt_wire(body, media, provider='anthropic' if protocol.startswith('anthropic') else 'openai', protocol=protocol))
        messages = adapted['input'] if protocol == 'responses-v1' else adapted['messages']
        blocks = [p for m in messages for p in m.get('content', []) if type(p) is dict]
        pdf = next(p for p in blocks if p['type'] in ('input_file', 'file', 'document'))
        assert (pdf.get('filename') or pdf.get('file', {}).get('filename') or pdf.get('title')) == '年度报告.pdf'
        projection=[]
        for part in blocks:
            if part['type'] in ('text','input_text'): continue
            if 'source' in part:
                projection.append(dict(mediaType=part['source']['media_type'],data=part['source']['data'],name=part.get('title')))
            else:
                file=part.get('file',part)
                uri=file.get('file_data') or part['image_url']
                if type(uri) is dict: uri=uri['url']
                header,encoded=uri.split(',',1)
                projection.append(dict(mediaType=header[5:-7],data=encoded,name=file.get('filename')))
        retained=json.loads((Path(__file__).parent/'fixtures/retained_media_wire.json').read_text())
        expected=next(row['projection'] for row in retained if row['protocol']==protocol)
        assert projection==expected
        assert len(calls) == 1 and b'synthetic-key-only-not-real' not in body
    asyncio.run(check())


@pytest.mark.parametrize('protocol', ['responses-v1', 'chat-completions-v1', 'anthropic-messages-v1'])
def test_public_binary_still_refused_and_loader_not_called(protocol):
    async def check():
        touched = []
        async def load(): touched.append('load'); return prepared()
        def send(_): touched.append('send'); raise AssertionError()
        async with port(protocol, send, load) as model:
            with pytest.raises(ProductModelError, match='model_request_invalid'):
                await model(request([BinaryContent(data=PNG, media_type='image/png')]))
        assert touched == []
    asyncio.run(check())


@pytest.mark.parametrize('value', [dict(version=True, sha256='a'*64, sizeBytes=1), dict(version=1,sha256='a'*64,sizeBytes=12289),
    dict(version=1,sha256='a'*64,sizeBytes=1,path='/tmp/raw'), None])
def test_closed_reference(value):
    with pytest.raises(InvalidWork): media_reference(value)


def test_bound_formula_and_item_count():
    media = prepared()
    assert media.wire_limit == BASE_WIRE_BYTES + sum(4*((len(i.data)+2)//3) for i in media.items) + 32768
    assert prepared(()).wire_limit == BASE_WIRE_BYTES
    with pytest.raises(InvalidWork): PreparedModelMedia(media.reference, media.items*3)
    with pytest.raises(InvalidWork): replace(media, items=(replace(media.items[0], sha256='b'*64),))


@pytest.mark.parametrize('mutation', ['url', 'wrong_bytes', 'wrong_mime', 'extra', 'file_id'])
def test_wire_foreign_media_refused(mutation):
    media = prepared((DATA[-1],))
    file = dict(type='input_file', file_data='data:application/pdf;base64,'+base64.b64encode(PDF).decode(), filename='filename.pdf')
    if mutation == 'url': file['file_data']='https://provider.invalid/file.pdf'
    if mutation == 'wrong_bytes': file['file_data']='data:application/pdf;base64,YQ=='
    if mutation == 'wrong_mime': file['file_data']=file['file_data'].replace('application/pdf','image/png')
    if mutation == 'file_id': file['file_id']='provider-file'
    body=dict(input=[dict(role='user', content=[file]*(2 if mutation=='extra' else 1))])
    with pytest.raises(WorkConflict, match='attachment_unavailable'):
        adapt_wire(json.dumps(body).encode(), media, provider='openai', protocol='responses-v1')


@pytest.mark.parametrize('protocol', ['responses-v1', 'chat-completions-v1', 'anthropic-messages-v1'])
def test_twenty_mib_binary_has_closed_body_limit_without_text_limit_change(protocol):
    async def check():
        data = b'%PDF-1.4\n' + b' '* (10*1024*1024-15) + b'\n%%EOF'
        assert len(data)==10*1024*1024
        media = prepared((('First.pdf','application/pdf',data),('Second.pdf','application/pdf',data)))
        calls=[]
        async def load(): return media
        def send(req):
            calls.append(len(req.content))
            assert BASE_WIRE_BYTES < len(req.content) <= media.wire_limit < 30*1024*1024
            return httpx2.Response(200,json=response(json.loads(req.content),protocol))
        async with port(protocol,send,load) as model:
            assert (await model(request())).text=='Observed'
        assert len(calls)==1
        assert len(data)*2==MAX_RAW_BYTES
        with pytest.raises(InvalidWork):
            prepared((('Oversize.pdf','application/pdf',data+b'x'),))
    asyncio.run(check())
