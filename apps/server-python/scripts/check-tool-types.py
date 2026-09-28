"""Static consumer assertions: decorators must preserve the real tool boundaries."""

from typing import assert_type

from pydantic import JsonValue

from openbot_server.work_deferred import EffectServices
from openbot_server.work_product_reads import ProductWorkReads
from openbot_server.work_product_web import WorkWebAdapter
from openbot_server.work_temporal_start import WorkRuntimeContext


async def consumer_contracts(
    reads: ProductWorkReads, web: WorkWebAdapter, context: WorkRuntimeContext
) -> None:
    assert_type(await reads.load(context, {}), EffectServices)
    assert_type(await web.load(context, {}), EffectServices)
    assert_type(await reads.load_result(context, {}), JsonValue)
    assert_type(await web.load_result(context, {}), JsonValue)
