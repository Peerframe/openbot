"""Reviewed metadata only. Publication/discovery cannot grant plugin authority."""
from importlib.resources import files
import json
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import Field, field_validator

from .authority import OwnerTransactions
from .browser_protocol import Strict, Timestamp
from .control_errors import ControlError
from .work_engine_client import read_owned_file


class CatalogFile(Strict):
    path: Annotated[str,Field(min_length=1,max_length=256,pattern=r'^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$')]
    sha256: Annotated[str,Field(pattern=r'^[0-9a-f]{64}$')]

    @field_validator('path')
    @classmethod
    def path_components(cls,value):
        if any(part in ('.','..') for part in value.split('/')):raise ValueError('Invalid catalog source path.')
        return value


class Review(Strict):
    status: Literal['reviewed']
    reviewedAt: Timestamp
    reviewedBy: Annotated[str,Field(min_length=1,max_length=80)]
    record: Annotated[str,Field(min_length=1,max_length=256,pattern=r'^docs/research/[a-z0-9-]+\.md$')]
    scope: Annotated[str,Field(min_length=1,max_length=500)]


class CatalogEntry(Strict):
    id: Annotated[str,Field(min_length=1,max_length=64,pattern=r'^[a-z0-9]+(?:-[a-z0-9]+)*$')]
    name: Annotated[str,Field(min_length=1,max_length=80)]
    description: Annotated[str,Field(min_length=1,max_length=500)]
    distribution: Literal['self-hosted-template','self-hosted']
    version: Annotated[str,Field(min_length=1,max_length=64,pattern=r'^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    license: Annotated[str,Field(min_length=1,max_length=64,pattern=r'^[A-Za-z0-9.-]+$')]
    sourceUrl: Annotated[str,Field(min_length=1,max_length=2048)]
    sourceCommit: Annotated[str,Field(pattern=r'^[0-9a-f]{40}$')]
    files: Annotated[list[CatalogFile],Field(min_length=1,max_length=16)]
    review: Review

    @field_validator('sourceUrl')
    @classmethod
    def source_url(cls,value):
        parsed=urlsplit(value)
        if (parsed.scheme!='https' or not parsed.hostname or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment or parsed.port not in (None,443)
                or any(c.isspace() or ord(c)<32 or c=='\\' for c in value)):
            raise ValueError('Invalid catalog source URL.')
        return value


class Catalog(Strict):
    format: Literal['openbot.reviewed-plugin-catalog/v1']
    revision: Annotated[int,Field(ge=1,le=2147483647)]
    entries: Annotated[list[CatalogEntry],Field(max_length=32)]


def parse_catalog(data):
    if len(data)>65536:raise ValueError('Catalog too large.')
    def pairs(values):
        result={}
        for key,value in values:
            if key in result:raise ValueError('Duplicate catalog field.')
            result[key]=value
        return result
    value=Catalog.model_validate(json.loads(data,object_pairs_hook=pairs))
    if len({item.id for item in value.entries})!=len(value.entries):raise ValueError('Duplicate catalog identity.')
    for item in value.entries:
        if len({file.path for file in item.files})!=len(item.files):raise ValueError('Duplicate source path.')
        if item.sourceCommit not in item.sourceUrl:raise ValueError('Source URL must bind exact commit.')
    return value.model_dump()


class ReviewedPluginCatalog:
    def __init__(self,dsn,source=None):
        self.transactions=OwnerTransactions(dsn,application_name='openbot-plugin-catalog')
        self.source=None if source is None else Path(source)
        if self.source is not None and (not self.source.is_absolute() or self.source.resolve()!=self.source):
            raise ValueError('An exact absolute private catalog path is required.')

    async def snapshot(self,token):
        # Authenticate before reading/configuration disclosure; revalidate expiry before publication.
        async with self.transactions.transaction(token):
            try:
                if self.source is not None: data=read_owned_file(self.source,private=True,maximum=65536)
                else:
                    with files('openbot_server').joinpath('plugin_catalog.json').open('rb') as stream: data=stream.read(65537)
                return parse_catalog(data)
            except (OSError,ValueError,TypeError,KeyError,UnicodeError):
                raise ControlError(503,'plugin_catalog_unavailable') from None
