"""Explicit trusted-client transport; no implicit credentials or insecure fallback."""
from pathlib import Path
import stat

from temporalio.client import Client
from temporalio.service import TLSConfig


def tls_config(settings):
    if settings is None:
        return False  # Explicit legacy development/plaintext reference only.
    if not isinstance(settings, dict) or set(settings) != {'ca', 'certificate', 'key', 'server_name'}:
        raise ValueError('Expected an explicit complete engine TLS configuration')
    if settings['server_name'] != 'temporal.openbot.internal':
        raise ValueError('Unexpected engine TLS server identity')
    material = {}
    for name in ('ca', 'certificate', 'key'):
        path = Path(settings[name])
        info = path.lstat()
        if not path.is_absolute() or not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 65536:
            raise ValueError('Expected a bounded regular engine PEM file')
        material[name] = path.read_bytes()
    return TLSConfig(server_root_ca_cert=material['ca'], client_cert=material['certificate'],
        client_private_key=material['key'], domain=settings['server_name'])


async def connect(address, settings=None, *, plugins=()):
    return await Client.connect(address, tls=tls_config(settings), plugins=plugins)
