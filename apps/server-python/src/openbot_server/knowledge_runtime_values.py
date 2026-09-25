"""Control-private Work knowledge receipts; descriptive values never grant authority.

The reviewed Employee learning direction remains inspired by Hermes Agent. No receipt is a
public Runtime/HTTP input, capability, artifact proof, or claim of model consumption.
"""
from dataclasses import dataclass
import hashlib
import json


class KnowledgeUnavailable(ValueError):
    """A generic refusal safe to return without reflecting untrusted stored text."""


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def byte_size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode())


def query_digest(value):
    if type(value) is not str or '\0' in value:
        raise KnowledgeUnavailable('invalid_knowledge_query')
    try:
        if len(value.encode()) > 512:
            raise KnowledgeUnavailable('knowledge_query_limit')
        return hashlib.sha256(value.encode()).hexdigest()
    except UnicodeError:
        raise KnowledgeUnavailable('invalid_knowledge_query') from None


@dataclass(frozen=True)
class KnowledgeContext:
    task_id: str
    run_id: str
    bot_id: str
    channel_id: str | None

    def __post_init__(self):
        for value in (self.task_id, self.run_id, self.bot_id) + (() if self.channel_id is None else (self.channel_id,)):
            if type(value) is not str or not value or len(value.encode()) > 128 or '\0' in value:
                raise KnowledgeUnavailable('invalid_knowledge_context')


@dataclass(frozen=True)
class KnowledgeTarget:
    context: KnowledgeContext
    source_run_id: str | None
    source_message_id: str | None
    authority_generation: int
    execution_epoch: int
    native_source: dict | None = None


@dataclass(frozen=True)
class MemoryVersion:
    id: str
    revision: int
    fingerprint: str


@dataclass(frozen=True)
class SkillVersion:
    id: str
    revision: int
    sha256: str
    reviewed_sha256: str
    fingerprint: str


@dataclass(frozen=True)
class KnowledgeReceipt:
    target: KnowledgeTarget
    purpose: str
    query_sha256: str
    memories: tuple[MemoryVersion, ...] = ()
    skills: tuple[SkillVersion, ...] = ()
    schema: str = 'openbot.work-knowledge/v1'


@dataclass(frozen=True)
class KnowledgeSelection:
    payload: dict
    receipt: KnowledgeReceipt


@dataclass(frozen=True)
class PreparedMemoryProposal:
    target: KnowledgeTarget
    kind: str
    title: str
    content: str
    fingerprint: str

    @property
    def payload(self):
        return {'status': 'prepared', 'requiresOwnerReview': True, 'activeMemoryChanged': False}
