"""Public read projections shared by runtime responses and generated OpenAPI."""
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


class PublicModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Owner(PublicModel):
    id: Literal["owner"]
    name: str


class SessionModel(PublicModel):
    @model_validator(mode="before")
    @classmethod
    def boolean_discriminator(cls, value):
        if isinstance(value, dict) and type(value.get("authenticated")) is not bool:
            raise ValueError("Session authentication must be a JSON boolean.")
        return value


class AnonymousSession(SessionModel):
    authenticated: Literal[False]


class AuthenticatedSession(SessionModel):
    authenticated: Literal[True]
    owner: Owner
    expiresAt: str


AuthSession = Annotated[AnonymousSession | AuthenticatedSession, Field(discriminator="authenticated")]


class BotAppearance(PublicModel):
    head: Literal["round", "square", "cat"]
    body: Literal["classic", "tall", "cape", "armor", "storage", "quadruped"]
    mobility: Literal["feet", "single-wheel", "dual-wheel", "hover", "four-legs"]
    accessory: Literal["none", "headphones", "backpack", "trench", "arm", "toolbox"]
    accent: Literal["green", "yellow", "red", "blue"]


class Bot(PublicModel):
    id: str
    name: str
    role: str
    status: Literal["idle", "running", "waiting_approval", "blocked", "human_takeover",
                    "offline", "completed", "failed"]
    computerProfile: Literal["none", "model", "docker-linux", "macos-cua", "lume-vm", "coder"]
    model: dict[str, str] | None = None
    appearance: BotAppearance | None = None
    createdAt: str


class Channel(PublicModel):
    id: str
    name: str
    description: str
    botIds: list[str]
    directBotId: str | None = None
    createdAt: str


class BotsResponse(PublicModel):
    bots: list[Bot]


class ChannelsResponse(PublicModel):
    channels: list[Channel]


def iso_timestamp(value: datetime) -> str:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Expected a timezone-aware database timestamp.")
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def project_bot(row: Mapping[str, object]) -> Bot:
    configuration = row.get("configuration")
    candidate = configuration.get("appearance") if isinstance(configuration, dict) else None
    appearance = None
    if isinstance(candidate, dict):
        try:
            appearance = BotAppearance.model_validate({key: candidate.get(key) for key in BotAppearance.model_fields})
        except ValidationError:
            pass
    model = None
    if isinstance(configuration, dict) and configuration.get('model') is not None:
        from .model_connections_inputs import ModelSelection
        model = ModelSelection.model_validate(configuration['model']).model_dump()
    return Bot(id=row["id"], name=row["name"], role=row["role"], status=row["status"],
               computerProfile=row["computer_profile"], appearance=appearance, model=model,
               createdAt=iso_timestamp(row["created_at"]))


def project_channels(rows: Sequence[Mapping[str, object]]) -> list[Channel]:
    result: dict[str, Channel] = {}
    for row in rows:
        identity = row["id"]
        if identity not in result:
            result[identity] = Channel(id=identity, name=row["name"], description=row["description"],
                                       botIds=[], directBotId=row["direct_bot_id"],
                                       createdAt=iso_timestamp(row["created_at"]))
        if row["bot_id"] is not None:
            if not isinstance(row["bot_id"], str):
                raise ValueError("Invalid channel membership.")
            result[identity].botIds.append(row["bot_id"])
    return list(result.values())
