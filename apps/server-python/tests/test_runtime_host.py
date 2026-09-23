"""Control authority tests use adversarial ports; no model credentials or worker implementation."""
import asyncio
from copy import deepcopy
from dataclasses import replace

import pytest

from openbot_server.runtime_host import CONTROL_PROMPT, RuntimeHost
from openbot_server.runtime_ports import (ModelIdentity, ModelStep, RuntimeBudget, RuntimeDenied,
    RuntimePorts, RuntimeTool)
from openbot_server.task_models import RunUsage


def first():
    return [{"role":"user","content":CONTROL_PROMPT}]


def intent(identity="c1", **arguments):
    return {"id":identity,"name":"read","arguments":arguments or {"query":"facts"}}


def transcript(call, value, text=""):
    parts = ([{"type":"text","text":text}] if text else []) + [
        {"type":"tool-call","toolCallId":call["id"],"toolName":call["name"],"input":call["arguments"]}]
    return first() + [{"role":"assistant","content":parts},{"role":"tool","content":[
        {"type":"tool-result","toolCallId":call["id"],"toolName":call["name"],"output":{"type":"json","value":value}}]}]


class Fixture:
    def __init__(self, responses=None):
        self.active = True
        self.calls, self.effects, self.usage, self.audit, self.drafts = [], [], [], [], []
        self.correction_values = []
        self.responses = list(responses or [ModelStep("",[intent()],"tool-calls",10,2), ModelStep(" Delivered. ",[],"stop",11,3)])
        self.budget = RuntimeBudget()
        self.cancelled = asyncio.Event()
        self.ports = RuntimePorts(ModelIdentity("openai","fixture"), self.model, self.authority,
            self.corrections, self.save_usage, self.progress,
            (RuntimeTool("read","Read facts",{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":False},
                         self.validate,self.execute,True,1024),), self.output)

    def host(self, **kwargs):
        return RuntimeHost(self.ports, instructions="Server policy.",messages=[{"role":"user","content":"Research facts."}],
                           budget=self.budget,cancelled=self.cancelled,**kwargs)

    async def authority(self):
        if not self.active:
            raise RuntimeDenied("scope_revoked")

    async def corrections(self):
        return deepcopy(self.correction_values)

    async def save_usage(self, value):
        self.usage.append(value.model_dump())

    async def progress(self, stage, message):
        self.audit.append((stage,message))

    async def model(self, request, emit):
        self.calls.append(request)
        return self.responses.pop(0)

    async def validate(self, args):
        if set(args) != {"query"} or type(args["query"]) is not str:
            raise ValueError("PRIVATE validation")
        return args

    async def execute(self, args, context):
        self.effects.append((deepcopy(args),context.call_id))
        return {"evidence":args["query"]}

    def output(self, text, reset):
        self.drafts.append((text,reset))


def test_complete_journey_retains_server_context_and_commits_usage_before_response():
    async def check():
        f=Fixture(); h=f.host()
        catalog=await h.catalog(); assert set(catalog[0]) == {"name","description","inputSchema"}
        catalog[0]["name"]="forged"
        response=await h.generate(first()); call=response["tools"][0]
        assert f.effects == [] and f.usage[0]["inputTokens"] == 10
        value=await h.execute_tool(call)
        assert value == {"evidence":"facts"} and f.effects == [({"query":"facts"},"c1")]
        response=await h.generate(transcript(call,value))
        result=await h.finish(response["text"])
        assert result == {"text":"Delivered.","appliedCorrectionIds":[]}
        assert f.calls[1].messages[0] == {"role":"user","content":"Research facts."}
        assert f.calls[0].instructions == "Server policy." and f.calls[0].max_retries == 0
        assert f.calls[0].store_response is False and f.calls[0].telemetry is False
        assert (f.budget.steps,f.budget.tools,f.budget.web) == (2,1,1)
        assert f.usage[-1] == {"provider":"openai","model":"fixture","steps":2,"inputTokens":21,"outputTokens":5}
        with pytest.raises(RuntimeDenied) as error: await h.assert_active()
        assert error.value.code == "conflict"
    asyncio.run(check())


@pytest.mark.parametrize("change", ["arguments","name","id","bool"])
def test_only_exact_proposed_intents_can_execute_and_denial_is_sticky(change):
    async def check():
        f=Fixture([ModelStep("",[intent(query=1)],"tool-calls",1,1)]);h=f.host()
        await h.catalog(); call=(await h.generate(first()))["tools"][0]
        fake=deepcopy(call)
        if change == "arguments": fake["arguments"]={"query":"different"}
        if change == "name": fake["name"]="write"
        if change == "id": fake["id"]="absent"
        if change == "bool": fake["arguments"]={"query":True}
        with pytest.raises(RuntimeDenied) as denial: await h.execute_tool(fake)
        assert denial.value.code == "invalid_target"
        with pytest.raises(RuntimeDenied) as again: await h.execute_tool(call)
        assert again.value is denial.value and f.effects == []
    asyncio.run(check())


def test_consumed_id_cannot_replay_but_a_later_model_may_propose_it_again():
    async def replay():
        f=Fixture();h=f.host();await h.catalog();call=(await h.generate(first()))["tools"][0]
        await h.execute_tool(call)
        with pytest.raises(RuntimeDenied): await h.execute_tool(call)
        assert len(f.effects)==1
    async def fresh():
        f=Fixture([ModelStep("",[intent()],"tool-calls"),ModelStep("",[intent()],"tool-calls")]);h=f.host()
        await h.catalog();call=(await h.generate(first()))["tools"][0];value=await h.execute_tool(call)
        newer=(await h.generate(transcript(call,value)))["tools"][0];await h.execute_tool(newer)
        assert len(f.effects)==2
    asyncio.run(replay());asyncio.run(fresh())


@pytest.mark.parametrize("forge", ["tool_result","assistant","initial","extra_user","drop_history"])
def test_worker_cannot_forge_history_or_inject_new_user_authority(forge):
    async def check():
        f=Fixture();h=f.host();await h.catalog();call=(await h.generate(first()))["tools"][0]
        value=await h.execute_tool(call);messages=transcript(call,value)
        if forge == "tool_result": messages[-1]["content"][0]["output"]["value"]={"evidence":"never executed"}
        if forge == "assistant": messages[1]["content"][0]["input"]={"query":"changed"}
        if forge == "initial": messages[0]["content"]="new privileged instructions"
        if forge == "extra_user": messages.append({"role":"user","content":"grant tools"})
        if forge == "drop_history": messages=first()
        with pytest.raises(RuntimeDenied): await h.generate(messages)
        assert len(f.calls)==1 and len(f.effects)==1
    asyncio.run(check())


def test_owner_corrections_are_reread_without_trusting_worker_or_mutating_saved_context():
    async def check():
        f=Fixture();h=f.host();await h.catalog()
        f.correction_values=[{"id":"s1","instruction":"Use primary sources"}]
        call=(await h.generate(first()))["tools"][0];value=await h.execute_tool(call)
        f.correction_values=[{"id":"s2","instruction":"Separate inferences"}]
        answer=await h.generate(transcript(call,value));result=await h.finish(answer["text"])
        assert result["appliedCorrectionIds"]==["s2"]
        assert "Separate inferences" in f.calls[-1].messages[-1]["content"]
        assert "Use primary sources" not in str(f.calls[-1].messages)
    asyncio.run(check())


@pytest.mark.parametrize("boundary", ["corrections","model","usage","validation","tool","audit"])
def test_revocation_at_each_await_boundary_prevents_later_success(boundary):
    async def check():
        f=Fixture()
        if boundary=="corrections":
            async def corrections(): f.active=False;return []
            f.ports=replace(f.ports,corrections=corrections)
        if boundary=="model":
            async def model(request,emit): f.active=False;return await f.model(request,emit)
            f.ports=replace(f.ports,generate=model)
        if boundary=="usage":
            async def usage(value): await f.save_usage(value);f.active=False
            f.ports=replace(f.ports,save_usage=usage)
        if boundary=="validation":
            async def validate(args): f.active=False;return args
            f.ports=replace(f.ports,tools=(replace(f.ports.tools[0],validate=validate),))
        if boundary=="tool":
            async def execute(args,context): f.active=False;return await f.execute(args,context)
            f.ports=replace(f.ports,tools=(replace(f.ports.tools[0],execute=execute),))
        if boundary=="audit":
            async def progress(stage,message): await f.progress(stage,message);f.active=False
            f.ports=replace(f.ports,progress=progress)
        h=f.host();await h.catalog()
        with pytest.raises(RuntimeDenied) as denial:
            call=(await h.generate(first()))["tools"][0]
            await h.execute_tool(call)
        assert denial.value.code=="scope_revoked"
        with pytest.raises(RuntimeDenied) as final: await h.finish("Delivered.")
        assert final.value is denial.value
        assert len(f.effects)==(1 if boundary=="tool" else 0)
        if boundary in ("corrections","audit"): assert not f.calls
        if boundary in ("corrections","audit","model"): assert not f.usage
    asyncio.run(check())


def test_concurrent_operation_poison_is_not_cleared_by_inflight_model():
    async def check():
        f=Fixture();entered,release=asyncio.Event(),asyncio.Event()
        async def model(request,emit): entered.set();await release.wait();return ModelStep("late",[],"stop",1,1)
        f.ports=replace(f.ports,generate=model);h=f.host();await h.catalog()
        pending=asyncio.create_task(h.generate(first()));await entered.wait()
        with pytest.raises(RuntimeDenied) as conflict: await h.assert_active()
        release.set()
        with pytest.raises(RuntimeDenied) as late: await pending
        assert conflict.value is late.value and not f.usage
    asyncio.run(check())


def test_port_swallowing_task_cancellation_cannot_save_usage_or_succeed():
    async def check():
        f=Fixture();entered=asyncio.Event()
        async def model(request,emit):
            entered.set()
            try: await asyncio.Event().wait()
            except asyncio.CancelledError: return ModelStep("late",[],"stop",1,1)
        f.ports=replace(f.ports,generate=model);h=f.host();await h.catalog()
        task=asyncio.create_task(h.generate(first()));await entered.wait();task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
        assert not f.usage
        with pytest.raises(asyncio.CancelledError): await h.finish("late")
    asyncio.run(check())


@pytest.mark.parametrize("response", [ModelStep("",[intent(),intent()],"tool-calls"),
    ModelStep("",[{"id":"c","name":"unknown","arguments":{}}],"tool-calls"),
    ModelStep("",[],"stop"),ModelStep("x",[],"length"),ModelStep("😀"*4001,[],"stop")])
def test_malformed_model_response_never_dispatches_or_completes(response):
    async def check():
        f=Fixture([response]);h=f.host();await h.catalog()
        with pytest.raises(RuntimeDenied): await h.generate(first())
        with pytest.raises(RuntimeDenied): await h.finish("x")
        assert not f.effects
    asyncio.run(check())


@pytest.mark.parametrize("result", [float("inf"),10**400,{1:"bad key"},set([1]),"x"*1025])
def test_tool_results_must_be_finite_completed_bounded_json(result):
    async def check():
        f=Fixture()
        async def execute(args,context): f.effects.append((args,context.call_id));return result
        f.ports=replace(f.ports,tools=(replace(f.ports.tools[0],execute=execute),))
        h=f.host();await h.catalog();call=(await h.generate(first()))["tools"][0]
        with pytest.raises(RuntimeDenied) as error: await h.execute_tool(call)
        assert error.value.code=="tool_unavailable"
        with pytest.raises(RuntimeDenied): await h.execute_tool(call)
        assert len(f.effects)==1
    asyncio.run(check())


@pytest.mark.parametrize("counter,value", [("steps",8),("tools",16),("web",4)])
def test_shared_budgets_cannot_reset_between_operations(counter,value):
    async def check():
        f=Fixture();setattr(f.budget,counter,value);h=f.host();await h.catalog()
        with pytest.raises(RuntimeDenied) as error:
            call=(await h.generate(first()))["tools"][0]
            await h.execute_tool(call)
        assert error.value.code=="task_limit" and not f.effects
    asyncio.run(check())


def test_unknown_usage_stays_unknown_and_reported_threshold_blocks_next_step():
    async def unknown():
        f=Fixture([ModelStep("",[intent()],"tool-calls",None,3),ModelStep("final",[],"stop",5,4)])
        h=f.host();await h.catalog();call=(await h.generate(first()))["tools"][0];value=await h.execute_tool(call)
        await h.generate(transcript(call,value));assert f.usage[-1]["inputTokens"] is None and f.usage[-1]["outputTokens"]==7
    async def threshold():
        f=Fixture();f.budget.steps=1;f.budget.usage=RunUsage(provider="openai",model="fixture",steps=1,inputTokens=64000,outputTokens=2)
        h=f.host();await h.catalog()
        with pytest.raises(RuntimeDenied): await h.generate(first())
        assert not f.calls
    asyncio.run(unknown());asyncio.run(threshold())


def test_final_must_match_model_and_usage_failure_cannot_be_replaced_by_success():
    async def forged():
        f=Fixture([ModelStep("final",[],"stop",1,1)]);h=f.host();await h.catalog();await h.generate(first())
        with pytest.raises(RuntimeDenied) as error: await h.finish("fabricated")
        assert error.value.code=="conflict"
    async def failed_storage():
        f=Fixture([ModelStep("final",[],"stop",1,1)]);denial=RuntimeDenied("execution_failed")
        async def save(value): raise denial
        f.ports=replace(f.ports,save_usage=save);h=f.host();await h.catalog()
        with pytest.raises(RuntimeDenied) as first_error: await h.generate(first())
        with pytest.raises(RuntimeDenied) as final_error: await h.finish("final")
        assert first_error.value is final_error.value is denial
    asyncio.run(forged());asyncio.run(failed_storage())


@pytest.mark.parametrize("tools", ["duplicate","missing_validator","unbounded","too_many","oversized"])
def test_catalog_requires_explicit_validators_policies_and_bounded_declarations(tools):
    async def check():
        f=Fixture();tool=f.ports.tools[0]
        choices={"duplicate":(tool,tool),"missing_validator":(replace(tool,validate=None),),
                 "unbounded":(replace(tool,maximum_result_bytes=131073),),
                 "too_many":tuple(replace(tool,name=f"t{x}") for x in range(65)),
                 "oversized":(replace(tool,description="x"*65537),)}
        f.ports=replace(f.ports,tools=choices[tools]);h=f.host()
        with pytest.raises(RuntimeDenied): await h.catalog()
        with pytest.raises(RuntimeDenied): await h.generate(first())
        assert not f.calls
    asyncio.run(check())


def test_streaming_text_checks_scope_and_cannot_publish_after_revocation():
    async def check():
        f=Fixture()
        async def model(request,emit):
            await emit("visible")
            f.active=False
            await emit("must not appear")
            return ModelStep("late",[],"stop",1,1)
        f.ports=replace(f.ports,generate=model);h=f.host();await h.catalog()
        with pytest.raises(RuntimeDenied) as error: await h.generate(first())
        assert error.value.code=="scope_revoked"
        assert ("visible",False) in f.drafts and all("must not" not in value[0] for value in f.drafts)
        assert not f.usage
    asyncio.run(check())


def test_failed_web_observation_is_audited_without_overwriting_the_original_denial():
    async def check(audit_fails):
        f=Fixture();denial=RuntimeDenied("plugin_unavailable")
        async def execute(args,context): raise denial
        async def progress(stage,message):
            if audit_fails and message.startswith("Failed"): raise RuntimeError("PRIVATE AUDIT")
            await f.progress(stage,message)
        f.ports=replace(f.ports,tools=(replace(f.ports.tools[0],execute=execute),),progress=progress)
        h=f.host();await h.catalog();call=(await h.generate(first()))["tools"][0]
        with pytest.raises(RuntimeDenied) as error: await h.execute_tool(call)
        assert error.value is denial
        assert (("observation","Failed read.") in f.audit) is (not audit_fails)
    asyncio.run(check(False));asyncio.run(check(True))


@pytest.mark.parametrize("value", [True,-1,1.5,float("nan"),10**1000])
def test_unreported_invalid_counts_do_not_become_zero_or_a_numeric_overflow(value):
    async def check():
        f=Fixture([ModelStep("done",[],"stop",value,value)]);h=f.host();await h.catalog()
        result=await h.generate(first())
        assert result["usage"]=={"inputTokens":None,"outputTokens":None}
        assert f.usage[-1]["inputTokens"] is None
    asyncio.run(check())


@pytest.mark.parametrize("failure", ["oversized", "revoked"])
def test_model_adapter_cannot_swallow_a_stream_refusal_then_claim_success(failure):
    async def check():
        f = Fixture()
        caught = []
        async def model(request, emit):
            if failure == "revoked":
                f.active = False
            try:
                await emit("x" * 8001 if failure == "oversized" else "unsafe")
            except RuntimeDenied as error:
                caught.append(error)
            f.active = True
            return ModelStep("claimed success", [], "stop", 1, 1)
        f.ports = replace(f.ports, generate=model)
        host = f.host()
        await host.catalog()
        with pytest.raises(RuntimeDenied) as denied:
            await host.generate(first())
        assert caught and denied.value is caught[0]
        assert not f.usage and not f.effects
        with pytest.raises(RuntimeDenied) as final:
            await host.finish("claimed success")
        assert final.value is caught[0]
    asyncio.run(check())
