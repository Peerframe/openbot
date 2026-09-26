"""Retained strict OpenBot plugin contracts and bounded draft-07 policy (MIT)."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import re
import subprocess
import shutil
from typing import Annotated, Any, Literal

from jsonschema import Draft7Validator
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, field_validator, model_validator

from .control_errors import ControlError


class PluginError(ControlError):
    def __init__(self, code: str):
        super().__init__({'invalid':400,'unavailable':503,'conflict':409,'forbidden':403,
                          'not_found':404,'rejected':409,'expired':409}[code], code)


Name = Annotated[str, StringConstraints(pattern=r'^[A-Za-z0-9_.-]{1,64}$')]
Uuid = Annotated[str, StringConstraints(pattern=r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
Digest = Annotated[str, StringConstraints(pattern=r'^[a-f0-9]{64}$')]
Short = Annotated[str, StringConstraints(max_length=2000)]
Uri = Annotated[str, StringConstraints(min_length=1, max_length=2048)]


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

    @model_validator(mode='before')
    @classmethod
    def reject_explicit_null_optionals(cls, value):
        if isinstance(value,dict):
            for name, info in cls.model_fields.items():
                key=info.alias or name
                if key in value and value[key] is None and not info.is_required():
                    raise ValueError('Optional fields must be omitted, not null.')
        return value

    @field_validator('*')
    @classmethod
    def retain_utf16_bounds(cls,value,info):
        if isinstance(value,str):
            length=len(value.encode('utf-16-le',errors='surrogatepass'))//2
            for constraint in cls.model_fields[info.field_name].metadata:
                maximum=getattr(constraint,'max_length',None)
                if maximum is not None and length>maximum:raise ValueError('String exceeds protocol bound.')
        return value


class Endpoint(Strict):
    name: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    endpoint: Uri
    token: Annotated[str, StringConstraints(min_length=1, max_length=2048, pattern=r'^[\x21-\x7e]+$')] | None = None

    @field_validator('name', mode='before')
    @classmethod
    def trim_name(cls, value):
        return value.strip() if isinstance(value, str) else value


class Install(Endpoint):
    reviewedDigest: Digest


class Revision(Strict):
    revision: Uuid


class Update(Revision):
    reviewedDigest: Digest


class Enabled(Revision):
    enabled: bool


class ToolGrant(Strict):
    name: Name
    mode: Literal['read','confirm']


class Grant(Revision):
    tools: Annotated[list[ToolGrant], Field(max_length=32)]
    resources: Annotated[list[Uri], Field(max_length=32)] = Field(default_factory=list)
    prompts: Annotated[list[Name], Field(max_length=32)] = Field(default_factory=list)


class Call(Revision):
    pluginId: Uuid
    toolName: Name
    arguments: dict[str, Any]


class Content(Revision):
    pluginId: Uuid
    kind: Literal['resource','prompt']
    name: Uri
    arguments: dict[Name, Annotated[str, StringConstraints(max_length=4000)]] = Field(default_factory=dict)


class Decision(Strict):
    decision: Literal['approve','reject']


class Tool(Strict):
    name: Name
    description: Short
    inputSchema: dict[str, Any]
    annotations: dict[str, Any] | None = None
    resourceUri: Annotated[str, StringConstraints(pattern=r'^ui://', max_length=2048)] | None = None


class Resource(Strict):
    uri: Uri
    name: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    description: Short
    mimeType: Annotated[str, StringConstraints(max_length=128)] | None = None


class PromptArgument(Strict):
    name: Name
    description: Annotated[str, StringConstraints(max_length=1000)] | None = None
    required: bool | None = None


class Prompt(Strict):
    name: Name
    description: Short
    arguments: Annotated[list[PromptArgument], Field(max_length=16)]


class ResourceContent(Strict):
    uri: Annotated[str, StringConstraints(max_length=2048)]
    mimeType: Annotated[str, StringConstraints(max_length=128)] | None = None
    text: Annotated[str, StringConstraints(max_length=128*1024)]
    meta: dict[str, Any] | None = Field(default=None, alias='_meta')


class ResourceResult(Strict):
    contents: Annotated[list[ResourceContent], Field(min_length=1, max_length=16)]


class TextContent(Strict):
    type: Literal['text']
    text: Annotated[str, StringConstraints(max_length=12000)]


class PromptMessage(Strict):
    role: Literal['user','assistant']
    content: TextContent


class PromptResult(Strict):
    description: Short | None = None
    messages: Annotated[list[PromptMessage], Field(min_length=1, max_length=16)]


class RetainedGrant(Strict):
    botId: Annotated[str, StringConstraints(max_length=128)]
    tools: Annotated[list[ToolGrant], Field(max_length=32)]
    resources: Annotated[list[Uri], Field(max_length=32)] | None = None
    prompts: Annotated[list[Name], Field(max_length=32)] | None = None


class Record(Strict):
    id: Uuid
    name: Annotated[str, StringConstraints(max_length=80)]
    endpoint: Annotated[str, StringConstraints(max_length=2048)]
    digest: Digest
    revision: Uuid
    enabled: bool
    createdAt: str
    token: Annotated[str, StringConstraints(max_length=2048)] | None = None
    tools: Annotated[list[Tool], Field(max_length=32)]
    resources: Annotated[list[Resource], Field(max_length=32)] | None = None
    prompts: Annotated[list[Prompt], Field(max_length=32)] | None = None
    grants: Annotated[list[RetainedGrant], Field(max_length=128)]


class Audit(Strict):
    at: str
    phase: Annotated[str, StringConstraints(max_length=64)]
    pluginId: str
    botId: str | None = None
    runId: str | None = None
    callId: str | None = None
    toolName: str | None = None


class State(Strict):
    plugins: Annotated[list[Record], Field(max_length=16)]
    audit: Annotated[list[Audit], Field(max_length=500)]


def bounded(value, limit):
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode(errors='backslashreplace')
        if len(encoded) > limit:
            raise ValueError()
        return encoded
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise PluginError('invalid') from None


def parse(model, value, limit=24*1024):
    try:
        detached = json.loads(bounded(value, limit))
        return model.model_validate(detached).model_dump(exclude_none=True, by_alias=True)
    except (ValidationError, ValueError, TypeError, RecursionError):
        raise PluginError('invalid') from None


def clone(value):
    return json.loads(bounded(value, 3*1024*1024))


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def public(record):
    return clone({key:value for key,value in record.items() if key != 'token'})


def audit(state, phase, plugin_id, **identifiers):
    state['audit'].append({'at':now(), 'phase':phase, 'pluginId':plugin_id, **identifiers})
    state['audit'] = state['audit'][-500:]


def check_schema(schema):
    forbidden = {'$ref','$dynamicRef','$recursiveRef','$id','pattern','patternProperties','format','x-mcp-header'}
    unsupported = {'$async','$anchor','$dynamicAnchor','$recursiveAnchor','$vocabulary','dependentRequired',
                   'dependentSchemas','prefixItems','minContains','maxContains','unevaluatedProperties',
                   'unevaluatedItems','contentSchema','discriminator'}
    maps = {'properties','$defs','definitions'}
    arrays = {'allOf','anyOf','oneOf'}
    singles = {'additionalProperties','additionalItems','contains','not','if','then','else','propertyNames'}
    count = 0
    def walk(value, depth, position):
        nonlocal count
        count += 1
        if depth > 12 or count > 1000:
            raise PluginError('invalid')
        if isinstance(value, list):
            for child in value:
                walk(child, depth+1, 'schema' if position == 'schema-array' else 'data')
        elif isinstance(value, dict):
            for key, child in value.items():
                following = 'data'
                if position == 'schema':
                    if key in forbidden | unsupported:
                        raise PluginError('invalid')
                    if key == '$schema' and child not in ('http://json-schema.org/draft-07/schema#','http://json-schema.org/draft-07/schema'):
                        raise PluginError('invalid')
                    if key in maps: following = 'schema-map'
                    elif key in arrays: following = 'schema-array'
                    elif key == 'dependencies': following = 'dependencies'
                    elif key == 'items': following = 'schema-array' if isinstance(child,list) else 'schema'
                    elif key in singles: following = 'schema'
                elif position == 'schema-map' or (position == 'dependencies' and not isinstance(child,list)):
                    following = 'schema'
                walk(child, depth+1, following)
    if not isinstance(schema,dict) or schema.get('type') != 'object':
        raise PluginError('invalid')
    walk(schema, 0, 'schema')
    bounded(schema, 12*1024)
    try:
        Draft7Validator.check_schema(schema)
    except Exception:
        raise PluginError('invalid') from None
    return Draft7Validator(schema)


# This fixed compatibility script is not an MCP executable. No imported source is evaluated.
_LEGACY_SCRIPT = r'''
const fs=require('node:fs');
const v=JSON.parse(fs.readFileSync(0,'utf8'));
const cmp=(a,b)=>a.localeCompare(b,v.locale);
function canon(x){return Array.isArray(x)?x.map(canon):x&&typeof x==='object'?
Object.fromEntries(Object.entries(x).sort(([a],[b])=>cmp(a,b)).map(([k,v])=>[k,canon(v)])):x;}
let b=v.body;b.tools.sort((a,b)=>cmp(a.name,b.name));
if(b.resources)b.resources.sort((a,b)=>cmp(a.uri,b.uri));
if(b.prompts)b.prompts.sort((a,b)=>cmp(a.name,b.name));
process.stdout.write(JSON.stringify({body:b,canonical:JSON.stringify(canon(b))}));
'''


class LegacyManifestCodec:
    """Explicit legacy Node/locale codec; no authority, network or plugin code execution."""
    def __init__(self, node_binary='node', locale='en-US'):
        self.node_binary, self.locale = shutil.which(node_binary) or node_binary, locale

    def manifest(self, name, endpoint, tools, resources=(), prompts=()):
        tools = [parse(Tool,t) for t in tools]
        resources = [parse(Resource,r) for r in resources]
        prompts = [parse(Prompt,p) for p in prompts]
        if not tools and not resources and not prompts:
            raise PluginError('invalid')
        for entries, key in ((tools,'name'),(resources,'uri'),(prompts,'name')):
            if len(entries)>32 or len({e[key] for e in entries}) != len(entries):
                raise PluginError('invalid')
        for tool in tools:
            check_schema(tool['inputSchema'])
        for prompt in prompts:
            if len({a['name'] for a in prompt['arguments']}) != len(prompt['arguments']):
                raise PluginError('invalid')
        body = {'name':name,'endpoint':endpoint,'tools':tools}
        if resources: body['resources']=resources
        if prompts: body['prompts']=prompts
        encoded = bounded({'body':body,'locale':self.locale}, 64*1024)
        try:
            result = subprocess.run([self.node_binary,'--no-addons','-e',_LEGACY_SCRIPT], input=encoded,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2, check=True,
                                    env={'PATH':'/usr/bin:/bin','LANG':'en_US.UTF-8'})
            if len(result.stdout)>256*1024: raise ValueError()
            output = json.loads(result.stdout)
            text = output['canonical'].encode()
            if len(text)>64*1024: raise ValueError()
            return {**output['body'],'digest':hashlib.sha256(text).hexdigest()}
        except (OSError, subprocess.SubprocessError, ValueError, KeyError):
            raise PluginError('unavailable') from None
