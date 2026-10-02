"""Message reads authorize before revealing channel existence and never accept writes."""
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from openbot_server.app import create_app
from openbot_server.database import ReadResult
from test_app import EXPIRES, TOKEN


def test_message_route_authority_existence_schema_and_response_boundaries():
    store = AsyncMock()
    with TestClient(create_app(store, owner_name="Owner"), base_url="https://control.test") as client:
        store.read.return_value = ReadResult(None, found=False)
        assert client.get("/api/v1/channels/private/messages").status_code == 401
        client.cookies.set("__Host-openbot_session", TOKEN)
        store.read.return_value = ReadResult(EXPIRES, found=False)
        assert client.get("/api/v1/channels/absent/messages").status_code == 404
        store.read.assert_awaited_with(TOKEN, "messages", channel_id="absent")
        store.read.return_value = ReadResult(EXPIRES)
        response = client.get("/api/v1/channels/empty/messages")
        assert response.json() == {"messages": [], "hasMore": False}
        assert response.headers["cache-control"] == "no-store"
        assert client.post("/api/v1/channels/empty/messages", json={"content": "do work"}).status_code == 405
        schema = client.get("/openapi.json").json()
        assert schema["paths"]["/api/v1/channels/{channel_id}/messages"]["get"]["security"] == [{"OwnerSession": []}]
        store.read.return_value = ReadResult(EXPIRES, ({"id": "private-corrupt"},))
        response = client.get("/api/v1/channels/broken/messages")
        assert response.status_code == 503 and "private-corrupt" not in response.text
        store.read.return_value = ReadResult(EXPIRES, ({
            "id": "message", "channel_id": "encoded", "author_type": "human",
            "content": "\x01" * 800000, "created_at": EXPIRES,
        },))
        assert client.get("/api/v1/channels/encoded/messages").status_code == 503
        response = client.get("/api/v1/channels/" + "x" * 129 + "/messages")
        assert response.status_code == 422 and "x" * 129 not in response.text



def test_c18_page_arguments_and_openapi_are_explicit():
    store=AsyncMock();store.read.return_value=ReadResult(EXPIRES)
    with TestClient(create_app(store,owner_name='Owner')) as api:
        api.cookies.set('__Host-openbot_session',TOKEN)
        assert api.get('/api/v1/channels/empty/messages?limit=2').json()=={'messages':[],'hasMore':False}
        store.read.assert_awaited_with(TOKEN,'messages',channel_id='empty',before=None,limit=2)
        operation=api.get('/openapi.json').json()['paths']['/api/v1/channels/{channel_id}/messages']['get']
        params={p['name']:p for p in operation['parameters']}
        assert params['limit']['schema']['maximum']==100 and params['limit']['schema']['minimum']==1
        assert params['before']['schema']['anyOf'][0]['maxLength']==2048
