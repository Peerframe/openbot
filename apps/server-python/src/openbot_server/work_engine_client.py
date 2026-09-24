"""Explicit mutual-TLS product engine client. No ambient settings or plaintext fallback."""
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit


def read_owned_file(path, *, private=False, maximum=65536):
    path = Path(path)
    if not path.is_absolute():
        raise ValueError('absolute_file_required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or not 0 < info.st_size <= maximum
                or stat.S_IMODE(info.st_mode) & 0o022
                or private and stat.S_IMODE(info.st_mode) & 0o077):
            raise ValueError('unsafe_engine_file')
        data = stream.read(maximum + 1)
    if not 0 < len(data) <= maximum:
        raise ValueError('engine_file_limit')
    return data


def validate_address(address):
    if type(address) is not str or len(address) > 320 or any(c.isspace() for c in address):
        raise ValueError('invalid_engine_address')
    parsed = urlsplit('tls://' + address)
    if (not parsed.hostname or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment or not parsed.port):
        raise ValueError('invalid_engine_address')
    return address


def tls_config(settings):
    from temporalio.service import TLSConfig
    if type(settings) is not dict or set(settings) != {'ca', 'certificate', 'key', 'server_name'}:
        raise ValueError('engine_mtls_required')
    name = settings['server_name']
    if type(name) is not str or len(name)>253 or not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', name):
        raise ValueError('invalid_engine_server_identity')
    return TLSConfig(server_root_ca_cert=read_owned_file(settings['ca']),
        client_cert=read_owned_file(settings['certificate']),
        client_private_key=read_owned_file(settings['key'], private=True), domain=name)


async def connect(address, settings, *, namespace='default', plugins=()):
    from temporalio.client import Client
    return await Client.connect(validate_address(address), namespace=namespace,
                                tls=tls_config(settings), plugins=plugins)
