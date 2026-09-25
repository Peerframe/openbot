"""Retained Web contract on the actual Python application and owned PostgreSQL fixture."""
import asyncio
import hashlib
import json
from pathlib import Path
import secrets
import time
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.authority import AuthenticationRequired
from openbot_server.database import PostgresReadStore
from openbot_server.owner_files import OwnerFiles, validate_attachment
from openbot_server.control_errors import ControlError
from openbot_server.product_control import OwnerProduct
from openbot_server.task_store import PostgresTaskStore


def product(fixture,tmp_path):
    (tmp_path/'attachments').mkdir(mode=0o700)
    return OwnerProduct(fixture['dsn'],object_root=tmp_path)


def client(fixture,service):
    app=create_app(PostgresReadStore(fixture['dsn']),owner_name='Owner',secure_cookies=False,
        allowed_origins=('http://testserver',),product=service,tasks=PostgresTaskStore(fixture['dsn'],files=service.files))
    result=TestClient(app)
    result.cookies.set('openbot_session',fixture['token'])
    return result


def test_real_owner_workspace_and_attachment_task_lifecycle(fixture,tmp_path):
    service=product(fixture,tmp_path)
    with client(fixture,service) as api:
        root=api.get('/api/v1/workspace')
        assert root.status_code==200,root.text
        value=root.json()
        assert fixture['botId'] in [b['id'] for b in value['bots']]
        assert value['counts']['bots']>=1
        channel=fixture['channelId'];base=f'/api/v1/channels/{channel}/attachments'
        denied=api.post(base,content=b'owner data',headers={'Content-Type':'application/octet-stream','X-OpenBot-Filename':'brief.txt'})
        assert denied.status_code==403
        uploaded=api.post(base,content='中文事实\n'.encode(),headers={'Origin':'http://testserver','Content-Type':'application/octet-stream','X-OpenBot-Filename':'brief.txt'})
        assert uploaded.status_code==201,uploaded.text
        item=uploaded.json()['attachment']
        assert api.get(base).json()['attachments']==[item]
        download=api.get(base+'/'+item['id']+'/content')
        assert download.content=='中文事实\n'.encode()
        assert download.headers['content-type']=='application/octet-stream'
        body={'botId':fixture['botId'],'content':f"Read [OpenBot attachment: {item['id']}]"}
        created=api.post(f'/api/v1/channels/{channel}/messages',json=body,headers={'Origin':'http://testserver'})
        assert created.status_code==201,created.text
        removed=api.delete(base+'/'+item['id'],headers={'Origin':'http://testserver'})
        assert removed.status_code==200,removed.text
        refused=api.post(f'/api/v1/channels/{channel}/messages',json=body,headers={'Origin':'http://testserver'})
        assert refused.status_code==400,refused.text
        assert api.get(base+'/'+item['id']+'/content').content==download.content
        restored=api.post(base+'/'+item['id']+'/restore',headers={'Origin':'http://testserver'})
        assert restored.status_code==200
        assert 'deletedAt' not in restored.json()['attachment']
        api.cookies.clear()
        assert api.get(base).status_code==401
        assert api.get('/api/v1/workspace').status_code==401


def test_attachment_is_not_retained_after_final_authority_expiry(fixture,tmp_path,monkeypatch):
    service=product(fixture,tmp_path)
    token=secrets.token_urlsafe(32)
    with psycopg.connect(fixture['dsn']) as db:
        db.execute("INSERT INTO auth_sessions(id,owner_id,token_digest,expires_at) VALUES(%s,'owner',%s,now()+interval '1 second')",
            (str(uuid4()),hashlib.sha256(token.encode()).hexdigest()))
    original=service.files.persist
    def delayed(*args):
        value=original(*args);time.sleep(1.1);return value
    monkeypatch.setattr(service.files,'persist',delayed)
    async def run():
        with pytest.raises(AuthenticationRequired):
            await service.file_mutation(token,fixture['channelId'],lambda:service.files.persist(fixture['channelId'],'expiry.txt',b'expiry'))
    asyncio.run(run())
    assert list((tmp_path/'attachments').glob('*.json'))==[]
    assert list((tmp_path/'attachments').glob('*.bin'))==[]


def test_attachment_boundaries_and_legacy_layout(tmp_path):
    tmp_path.chmod(0o700);files=OwnerFiles(tmp_path);channel=str(uuid4())
    with pytest.raises(ControlError): files._read('../foreign',100)
    with pytest.raises(ControlError): validate_attachment('a.txt',b'\xff')
    with pytest.raises(ControlError): validate_attachment('a.txt',b'x'*(256*1024+1))
    item=files.persist(channel,'safe.txt',b'payload')
    assert files.metadata(channel,item['id'])==item
    with pytest.raises(ControlError): files.read(str(uuid4()),item['id'])
    (tmp_path/(item['id']+'.bin')).write_bytes(b'tampered')
    with pytest.raises(ControlError): files.read(channel,item['id'])


def test_integrated_model_knowledge_schedule_and_reactions(fixture,tmp_path):
    from datetime import datetime,timedelta,timezone
    from openbot_server.model_settings import ModelSettingsService
    from openbot_server.employee_knowledge import PostgresEmployeeKnowledge
    from openbot_server.automation_store import PostgresAutomations
    from openbot_server.conversation_interactions import PostgresConversationInteractions
    service=product(fixture,tmp_path)
    service.model=ModelSettingsService(tmp_path.resolve()/'model')
    service.knowledge=PostgresEmployeeKnowledge(fixture['dsn'])
    service.automations=PostgresAutomations(fixture['dsn'],files=service.files)
    service.interactions=PostgresConversationInteractions(fixture['dsn'])
    headers={'Origin':'http://testserver'};bot=fixture['botId'];channel=fixture['channelId']
    with client(fixture,service) as api:
        assert api.get('/api/v1/settings/model').json()['status']=='unconfigured'
        saved=api.post('/api/v1/settings/model',headers=headers,json={'provider':'ark','model':'ep-fixture',
            'apiKey':'synthetic-not-a-live-key','revision':None,'agentEnabled':False})
        assert saved.status_code==200,saved.text
        assert saved.json()['status']=='configured' and 'apiKey' not in saved.json()
        assert api.post('/api/v1/settings/model',headers=headers,json={'provider':'ark','model':'ep-fixture',
            'apiKey':'synthetic-not-a-live-key','revision':None}).status_code==409
        base=f'/api/v1/bots/{bot}'
        memory=api.post(base+'/memories',headers=headers,json={'kind':'semantic','title':'Synthetic memory',
            'content':'Retained contract','sensitivity':'internal','portability':'never','modelUseEnabled':False})
        assert memory.status_code==201,memory.text
        identity=memory.json()['memory']['id']
        update=api.patch(base+'/memories/'+identity,headers=headers,json={'expectedRevision':1,'title':'Reviewed memory'})
        assert update.status_code==200,update.text
        assert api.get(base+'/profile').json()['profile']['memories'][0]['title']=='Reviewed memory'
        removed=api.request('DELETE',base+'/memories/'+identity,headers=headers,json={'expectedRevision':2,'ownerReviewed':True})
        assert removed.status_code==200,removed.text
        slug='integration-'+uuid4().hex
        skill=api.post(base+'/skills/import',headers=headers,json={'markdown':f'---\nname: {slug}\ndescription: >-\n  Read retained\n  facts\n---\nUse facts.','version':'1.0.0','reason':'Synthetic import'})
        assert skill.status_code==201,skill.text
        assert skill.json()['skill']['state']=='candidate'
        assert api.get(base+'/knowledge-proposals').status_code==200
        automation=api.post('/api/v1/automations',headers=headers,json={'name':'Integration schedule',
            'botId':bot,'channelId':channel,'prompt':'Read retained facts','intervalMinutes':60,
            'firstRunAt':(datetime.now(timezone.utc)+timedelta(days=1)).isoformat().replace('+00:00','Z')})
        assert automation.status_code==201,automation.text
        automation_id=automation.json()['automation']['id']
        assert api.patch('/api/v1/automations/'+automation_id,headers=headers,json={'enabled':False}).status_code==200
        assert api.delete('/api/v1/automations/'+automation_id,headers=headers).json()=={'deleted':True}
        message=api.post(f'/api/v1/channels/{channel}/messages',headers=headers,json={'botId':bot,'content':'Integration message'})
        assert message.status_code==201,message.text
        message_id=message.json()['message']['id']
        reaction=api.put(f'/api/v1/channels/{channel}/messages/{message_id}/reactions',headers=headers,json={'emoji':'👍','active':True})
        assert reaction.status_code==200,reaction.text
        assert reaction.json()['reactions'][0]['emoji']=='👍'
        assert api.get(f'/api/v1/channels/{channel}/reactions').status_code==200
