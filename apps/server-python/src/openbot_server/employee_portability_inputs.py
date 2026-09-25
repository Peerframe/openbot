"""Retained strict Employee v1/v2 and forward-compatible DSSE contracts."""
from datetime import datetime
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .employee_knowledge_inputs import Input, text_type
from .identity_inputs import ChannelBotId, _bounded_text
from .models import BotAppearance, Bot

Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


def datetime_text(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?Z", value):
        raise ValueError("Expected an ISO UTC datetime.")
    datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


class SkillContent(Input):
    markdown: str = Field(min_length=1, max_length=12288)
    sha256: Digest
    license: str = Field(min_length=1, max_length=500)


class PortableSkill(Input):
    slug: text_type(64)
    name: text_type(160)
    description: text_type(1024)
    version: text_type(64)
    requiredCapabilities: list[text_type(160)] = Field(max_length=64)
    content: SkillContent | None = None
    dependencySlugs: list[text_type(160)] = Field(max_length=64)

    @field_validator("slug")
    @classmethod
    def name_format(cls, value):
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
            raise ValueError("Invalid Agent Skills name.")
        return value


class Unsigned(Input):
    status: Literal["unsigned"]


class Signed(Input):
    status: Literal["dsse"]
    algorithm: Literal["ed25519"]
    keyid: text_type(256)


class PortableEmployee(Input):
    name: text_type(64)
    role: text_type(160)
    description: _bounded_text(0, 2000, description="Optional portable biography.") | None = None
    appearance: BotAppearance | None = None


class PortableConfiguration(Input):
    recommendedExecutionProfile: Bot.model_fields["computerProfile"].annotation


class PortablePolicy(Input):
    identity: Literal["new-on-import"]
    authority: Literal["none"]
    memories: Literal["none"]
    importedSkillState: Literal["disabled-pending-review"]


class PortablePayload(Input):
    format: Literal["openbot.employee/v1", "openbot.employee/v2"]
    kind: Literal["template"]
    packageId: ChannelBotId
    generatedAt: str
    employee: PortableEmployee
    configuration: PortableConfiguration
    skills: list[PortableSkill] = Field(max_length=256)
    requestedCapabilities: list[text_type(160)] = Field(max_length=256)
    portability: PortablePolicy
    signature: Annotated[Unsigned | Signed, Field(discriminator="status")]

    @field_validator("generatedAt")
    @classmethod
    def timestamp(cls, value):
        return datetime_text(value)

    @model_validator(mode="after")
    def content_version(self):
        if self.format == "openbot.employee/v1" and any(skill.content for skill in self.skills):
            raise ValueError("Instruction content requires openbot.employee/v2.")
        return self


class Integrity(Input):
    algorithm: Literal["sha256"]
    canonicalization: Literal["openbot-json-v1"]
    digest: Digest


class EmployeePackage(Input):
    payload: PortablePayload
    integrity: Integrity


def base64_text(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9+/_-]+={0,2}", value) or len(value.rstrip("=")) % 4 == 1:
        raise ValueError("Invalid DSSE base64.")
    return value


class EnvelopeSignature(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    keyid: str | None = Field(default=None, max_length=256)
    sig: str = Field(min_length=1, max_length=8192)

    @field_validator("sig")
    @classmethod
    def signature_base64(cls, value):
        return base64_text(value)

    @field_validator("keyid", mode="before")
    @classmethod
    def no_null(cls, value):
        if value is None:
            raise ValueError("Explicit null is not an omission.")
        return value


class DsseEnvelope(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    payload: str = Field(min_length=1, max_length=1500000)
    payloadType: str = Field(min_length=1, max_length=512)
    signatures: list[EnvelopeSignature] = Field(min_length=1, max_length=16)

    @field_validator("payload")
    @classmethod
    def payload_base64(cls, value):
        return base64_text(value)


class ExportDownloadInput(Input):
    packageId: ChannelBotId
    generatedAt: str

    @field_validator("generatedAt")
    @classmethod
    def timestamp(cls, value):
        return datetime_text(value)


class ActivateInput(Input):
    package: dict[str, Any]
    expectedPackageId: ChannelBotId
    expectedDigest: Digest
    ownerReviewed: Literal[True]
    allowUnsigned: bool
    idempotencyKey: ChannelBotId
    employeeName: text_type(64) | None = None
