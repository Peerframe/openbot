"""Optional SDK execution guard; ordinary core imports never load Temporal."""

from pydantic_ai.exceptions import UserError


def refuse_inline_temporal_tool() -> None:
    # TemporalDurability 2.47.0 does not wrap arbitrary AbstractToolset leaves. Without a
    # constructor-time DynamicToolset, a port would execute in replayable Workflow code.
    try:
        from temporalio import workflow
    except ImportError:
        return
    if workflow.in_workflow():
        raise UserError("OpenBot tool ports require a registered Temporal tool activity")
