"""Exercise the installed application middleware/routes before the database acceptance gate."""
from fastapi.testclient import TestClient
from openbot_server.app import create_app
from test_app import Store, TOKEN


class Commands:
    def __init__(self):
        self.calls = []

    async def verify_schema(self):
        pass

    async def request_reconciliation(self, token, action_id, **request):
        self.calls.append((token, action_id, request))
        return {'id':'command', 'actionId':action_id, 'sequence':1, 'requestedBy':'owner',
                'reason':request['reason'], 'createdAt':'2026-09-23T00:00:00.000Z',
                'delivered':False, 'outcome':None}


def test_repair_application_entry_enforces_owner_origin_shape_and_work_mode():
    read = Store(); commands = Commands()
    path = '/api/v1/actions/action/reconcile'
    body = {'intentDigest':'a'*64, 'requestKey':'request', 'expectedSequence':0, 'reason':'Recheck receipt'}
    with TestClient(create_app(read, owner_name='Owner', work=commands,
                    allowed_origins=('https://web.test',)), base_url='https://control.test') as client:
        client.headers['Origin'] = 'https://web.test'
        assert client.post(path, json=body).status_code == 401
        client.cookies.set('__Host-openbot_session', TOKEN)
        assert client.post(path, json=body, headers={'Origin':'https://untrusted.test'}).status_code == 403
        for change in ({'applied':True}, {'actualTokens':0}, {'requestedBy':'owner'},
                       {'expectedSequence':True}, {'reason':'x'*513}, {'intentDigest':'bad'}):
            assert client.post(path, json={**body, **change}).status_code == 422
        assert client.post(path, content=b'{invalid', headers={'Content-Type':'application/json'}).status_code == 422
        assert not commands.calls
        accepted = client.post(path, json=body)
        assert accepted.status_code == 202, accepted.text
        assert accepted.json()['outcome'] is None and not accepted.json()['delivered']
        assert commands.calls == [(TOKEN, 'action', {'intent_digest':'a'*64, 'request_key':'request',
                                                    'expected_sequence':0, 'reason':'Recheck receipt'})]
        assert accepted.headers['Cache-Control'] == 'no-store'
        assert client.get('/openapi.json').json()['paths']['/api/v1/actions/{action_id}/reconcile']['post']['security'] == [{'OwnerSession':[]}]
        read.revoked = True
        assert client.post(path, json=body).status_code == 401
        assert len(commands.calls) == 1
    with TestClient(create_app(Store(), owner_name='Owner'), base_url='https://control.test') as read_only:
        assert read_only.post(path, json=body).status_code == 405
