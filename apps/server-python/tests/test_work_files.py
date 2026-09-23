"""Actual private files and invalid paths, never the user's artifact directory."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
from pathlib import Path

import pytest
from openbot_server.database import StoreUnavailable
from openbot_server.work_files import LocalWorkFiles, MAX_BYTES, artifact_name, artifact_media_type
from openbot_server.work_values import InvalidWork


@pytest.fixture
def files(tmp_path):
    tmp_path.chmod(0o700)
    return LocalWorkFiles(tmp_path)


def test_concurrent_same_content_is_one_immutable_blob_and_readback(files):
    data = b'row,value\n7,fixed\n'
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(files.put,[data]*8))
    assert all(value == results[0] for value in results)
    assert files.read(results[0]['sha256'],len(data)) == data
    assert [p.name for p in files.directory.iterdir()] == [hashlib.sha256(data).hexdigest()]


@pytest.mark.parametrize('failure', ['missing','size','digest','symlink','directory','fifo'])
def test_invalid_blob_never_returns_bytes(files,tmp_path,failure):
    descriptor = files.put(b'original')
    path = files.directory / descriptor['sha256']
    path.unlink()
    if failure == 'size': path.write_bytes(b'longer content')
    if failure == 'digest': path.write_bytes(b'changed!')
    if failure == 'symlink':
        target = tmp_path/'untrusted-source'; target.write_bytes(b'original'); path.symlink_to(target)
    if failure == 'directory': path.mkdir()
    if failure == 'fifo': os.mkfifo(path)
    with pytest.raises(StoreUnavailable):
        files.read(descriptor['sha256'],8)
    if failure in ('size','digest','symlink','directory','fifo'):
        with pytest.raises(StoreUnavailable): files.put(b'original')
    assert not list(files.directory.glob('.pending-*'))


def test_private_root_and_no_symlink_root_are_required(files,tmp_path):
    tmp_path.chmod(0o755)
    with pytest.raises(StoreUnavailable): files.verify()
    tmp_path.chmod(0o700)
    link=tmp_path/'link';link.symlink_to(tmp_path,target_is_directory=True)
    with pytest.raises(StoreUnavailable): LocalWorkFiles(link).verify()


def test_oversize_and_path_descriptor_never_open_files(files):
    with pytest.raises(InvalidWork): files.put(b'x'*(MAX_BYTES+1))
    with pytest.raises(InvalidWork): files.read('../elsewhere',1)
    with pytest.raises(InvalidWork): files.read('a'*64,True)
    assert not list(files.directory.iterdir())


@pytest.mark.parametrize('name',['..','.','a/b','a\\b','bad\n.csv','bad\x7f.txt','x'*256])
def test_download_name_cannot_inject_headers_or_paths(name):
    with pytest.raises(InvalidWork):artifact_name(name)


@pytest.mark.parametrize('value',['text/csv\r\nX:true','text/html;script','text','TEXT/CSV',None])
def test_media_type_is_a_bounded_header_token(value):
    with pytest.raises(InvalidWork):artifact_media_type(value)


def test_durable_file_failure_cannot_report_success(files,monkeypatch):
    def fail(_):raise OSError('fixture flush failure')
    monkeypatch.setattr(os,'fsync',fail)
    with pytest.raises(StoreUnavailable):files.put(b'bytes')
    assert not list(files.directory.iterdir())
