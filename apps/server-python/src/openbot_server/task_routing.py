"""Assignee selection, ported from ``apps/server/src/task-routing.ts``.

This module decides *which* members receive a task. It grants nothing: a role name that reads
``chief`` only affects the default pick, and a candidate is returned exactly as the store read it.
The complete set is validated before anything is returned, so a caller can never persist a partial
recipient list.
"""
from collections.abc import Sequence

from .models import Bot, PublicModel
from .task_inputs import CreateMessageInput

# ``Bot["computerProfile"]``, reused rather than restated so a new profile cannot drift in here.
ComputerProfile = Bot.model_fields["computerProfile"].annotation

# ``task-routing.ts`` matches the marker against ``name + " " + role``, lowercased.
_CHIEF_MARKERS = ("chief", "总管", "协调", "调度")

_RECIPIENTS_MIN = 1
_RECIPIENTS_MAX = 6


class TaskValidation(Exception):
    """A rejected recipient set.

    Deliberately not a ``ValueError``: ``PostgresTaskStore.submit`` maps storage-shaped failures to
    ``StoreUnavailable`` and must leave this one on the floor for the route to answer with 422.
    """


class TaskCandidate(PublicModel):
    """``Pick<Bot, "id" | "name" | "role" | "computerProfile">`` as read from a channel membership."""

    id: str
    name: str
    role: str
    computerProfile: ComputerProfile


def _is_chief(candidate: TaskCandidate) -> bool:
    """``isChief``: the marker is searched in ``"<name> <role>"``, case-insensitively.

    Node's ``toLocaleLowerCase()`` is used for this in TypeScript. The default-locale mapping is the
    Unicode default lowercase for every marker and every realistic name, so ``str.lower()`` is the
    same function here; a host whose default locale made ``I`` lowercase to ``ı`` would only change
    which *default* candidate wins, never who may receive a task.
    """
    identity = f"{candidate.name} {candidate.role}".lower()
    return any(marker in identity for marker in _CHIEF_MARKERS)


def select_assignee(candidates: Sequence[TaskCandidate],
                    requested_bot_id: str | None = None) -> TaskCandidate | None:
    """``selectChannelAssignee``: an explicit request must be a member; otherwise chief, then first."""
    if requested_bot_id is not None:
        return next((candidate for candidate in candidates if candidate.id == requested_bot_id), None)
    chief = next((candidate for candidate in candidates if _is_chief(candidate)), None)
    if chief is not None:
        return chief
    return candidates[0] if candidates else None


def select_assignees(candidates: Sequence[TaskCandidate], value: CreateMessageInput,
                     direct_bot_id: str | None = None) -> list[TaskCandidate]:
    """``selectChannelAssignees``: validate the whole recipient set, in the caller's order.

    Raises ``TaskValidation`` with the same text the TypeScript store raises, so the HTTP mapping and
    any operator-facing message stay identical.
    """
    if value.botId is not None and value.botIds is not None:
        raise TaskValidation("Choose botId or botIds, not both.")
    if value.botIds is not None:
        requested: list[str] | None = list(value.botIds)
    elif value.botId is not None:
        requested = [value.botId]
    else:
        requested = None
    if requested is not None and not (
        _RECIPIENTS_MIN <= len(requested) <= _RECIPIENTS_MAX
        and len(set(requested)) == len(requested)
    ):
        raise TaskValidation("Choose one to six unique Bot recipients.")
    if direct_bot_id is not None and requested is not None:
        if any(identity != direct_bot_id for identity in requested):
            raise TaskValidation("A direct conversation can only address its Bot.")
    if requested is not None:
        identities: list[str] | None = requested
    elif direct_bot_id is not None:
        identities = [direct_bot_id]
    else:
        identities = None
    selected = ([select_assignee(candidates, identity) for identity in identities]
                if identities is not None else [select_assignee(candidates)])
    if any(candidate is None for candidate in selected):
        raise TaskValidation("Add a Bot to this channel before assigning a task." if identities is None
                             else "The selected Bot is not a member of this channel.")
    return [candidate for candidate in selected if candidate is not None]
