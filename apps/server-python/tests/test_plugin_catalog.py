"""Actual reviewed source hashes and Owner-only bounded catalog publication."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore
from openbot_server.plugin_catalog import parse_catalog
from openbot_server.product_control import OwnerProduct

ROOT=Path(__file__).resolve().parents[3]
SOURCE=Path(__file__).resolve().parents[1]/'src/openbot_server/plugin_catalog.json'


def test_actual_bundled_review_binds_current_template_files():
    value=parse_catalog(SOURCE.read_bytes())
    assert len(value['entries'])==1
    entry=value['entries'][0]
    assert entry['distribution']=='self-hosted-template' and entry['review']['status']=='reviewed'
    for file in entry['files']:
        assert hashlib.sha256((ROOT/file['path']).read_bytes()).hexdigest()==file['sha256']
    assert (ROOT/entry['review']['record']).is_file()


@pytest.mark.parametrize('field,value',[('status','pending'),('status','rejected'),('record','../private'),('reviewedAt','yesterday')])
def test_unreviewed_or_invalid_review_refuses_entire_feed(field,value):
    data=json.loads(SOURCE.read_bytes());data['entries'][0]['review'][field]=value
    with pytest.raises(ValueError):parse_catalog(json.dumps(data).encode())


def test_duplicates_unknown_credentials_and_oversize_fail_closed():
    data=json.loads(SOURCE.read_bytes())
    for changed in [dict(data,entries=data['entries']*2),dict(data,token='secret'),dict(data,entries=[dict(data['entries'][0],sourceCommit='0'*40)]),dict(data,entries=[dict(data['entries'][0],files=[dict(path='../private',sha256='a'*64)])])]:
        with pytest.raises(ValueError):parse_catalog(json.dumps(changed).encode())
    with pytest.raises(ValueError):parse_catalog(b' '*65537)
    with pytest.raises(ValueError):parse_catalog(b'{"format":"x","format":"y"}')


def test_public_catalog_requires_owner_and_never_accepts_a_remote_feed(fixture,tmp_path):
    source=tmp_path/'catalog.json';source.write_bytes(SOURCE.read_bytes());source.chmod(0o600)
    product=OwnerProduct(fixture['dsn'],object_root=tmp_path,plugin_catalog_path=source)
    app=create_app(PostgresReadStore(fixture['dsn']),owner_name='Owner',secure_cookies=False,allowed_origins=('http://testserver',),product=product)
    with TestClient(app) as api:
        assert api.get('/api/v1/plugins/catalog').status_code==401
        api.cookies.set('openbot_session',fixture['token'])
        result=api.get('/api/v1/plugins/catalog');assert result.status_code==200,result.text
        assert result.json()==parse_catalog(SOURCE.read_bytes())
        assert str(source) not in result.text and 'endpoint' not in result.json()['entries'][0]
        assert api.get('/api/v1/plugins/catalog?source=https://attacker.invalid').status_code==422
        data=json.loads(source.read_bytes());data['entries'][0]['review']['status']='pending';source.write_text(json.dumps(data));source.chmod(0o600)
        assert api.get('/api/v1/plugins/catalog').status_code==503
        source.write_bytes(SOURCE.read_bytes());source.chmod(0o644)
        assert api.get('/api/v1/plugins/catalog').status_code==503
