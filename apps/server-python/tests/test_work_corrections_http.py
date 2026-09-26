"""Actual application route/middleware/OpenAPI, before database and engine acceptance."""
from unittest.mock import patch
from fastapi.testclient import TestClient
from openbot_server.app import create_app
from openbot_server import work_routes
from test_app import Store, TOKEN
from test_work_reconciliation_http import Commands


def test_correction_entry_rejects_unsupported_shape_origin_auth_and_read_only_mode():
    class Corrections:
        calls = []
        async def request(self, token, task_id, **body):
            self.calls.append((token, task_id, body))
            return dict(id='c', taskId=task_id, runId=body['run_id'], sequence=1,
                requestedBy='owner', instruction=body['instruction'], generation=2,
                createdAt='2026-09-24T00:00:00.000Z')
    commands, read, corr = Commands(), Store(), Corrections()
    body = dict(runId='r', instruction='Use the corrected column', requestKey='one', expectedSequence=0)
    path = '/api/v1/tasks/t/corrections'
    with patch.object(work_routes, 'CorrectionStore', return_value=corr), TestClient(create_app(
            read, owner_name='Owner', work=commands, allowed_origins=('https://web.test',)),
            base_url='https://control.test') as client:
        client.headers['Origin']='https://web.test'
        assert client.post(path,json=body).status_code==401
        client.cookies.set('__Host-openbot_session',TOKEN)
        assert client.post(path,json=body,headers={'Origin':'https://other.test'}).status_code==403
        for change in [dict(expectedSequence=True),dict(expectedSequence=9),dict(grant=True),dict(instruction='')]:
            assert client.post(path,json=body|change).status_code==422
        assert client.post(path,content='[',headers={'Content-Type':'application/json'}).status_code==422
        assert client.post(path,content='x'*32769,headers={'Content-Type':'application/json'}).status_code==413
        assert not corr.calls
        result=client.post(path,json=body)
        assert result.status_code==202,result.text
        assert result.json()['requestedBy']=='owner' and result.json()['instruction']==body['instruction']
        assert result.headers['Cache-Control']=='no-store'
        assert corr.calls==[(TOKEN,'t',dict(run_id='r',instruction=body['instruction'],request_key='one',expected_sequence=0))]
        assert client.get('/openapi.json').json()['paths']['/api/v1/tasks/{task_id}/corrections']['post']['security']==[{'OwnerSession':[]}]
        escaped=body|dict(instruction='\x01'*4096)
        assert client.post(path,json=escaped).status_code==202
        assert corr.calls[-1][2]['instruction']==escaped['instruction']
        read.revoked=True
        assert client.post(path,json=body).status_code==401
        assert len(corr.calls)==2
    with TestClient(create_app(Store(),owner_name='Owner'),base_url='https://control.test') as client:
        assert client.post(path,json=body).status_code==405
