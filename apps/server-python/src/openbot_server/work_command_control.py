"""Current Work output access and separate Owner stop over the original protected identity."""
from uuid import uuid4

from .work_claims import WorkFence, check_fence
from .work_command_contract import parse, bounded_value
from .work_command_profiles import CommandProfile
from .work_command_v2_contract import BindingV2, token_digest
from .work_engine_binding import EngineActivityFacts
from .work_temporal_start import WorkRuntimeContext
from .work_values import WorkConflict, WorkNotFound, canonical


class CommandControlMixin:
    def _control_challenge(self, token, binding, *, request_id, nonce, operation):
        value = self.verifier.verify(token, purpose='work_command_control_challenge',
            issuer=self.enforcement_issuer, audience=self.control_issuer,
            expected_binding=binding.model_dump(), expected_request=dict(requestId=request_id, nonce=nonce))
        if value.operation != operation:
            raise WorkConflict('command_control_operation_changed')
        return value

    async def _control_original(self, db, action, live):
        from .work_command_store import LiveCommandConnection
        preparation, binding = await self._prepare_row(db, action)
        row = await (await db.execute('SELECT * FROM work_command_dispatches WHERE action_id=%s FOR UPDATE',
                                     (action['id'],))).fetchone()
        dispatch = None
        if row:
            claims = self._row(row, action)
            dispatch = parse(BindingV2, {k: claims[k] for k in BindingV2.model_fields})
            if (str(row['preparation_id']) != binding.preparationId
                    or row['readiness_digest'] != preparation['readiness_digest']
                    or row['native_deadline_ms'] != preparation['native_deadline_ms']):
                raise WorkConflict('command_readiness_changed')
            self._checked_ready(preparation, binding, preparation['ready_token'])
        profile_row = await (await db.execute('SELECT profile,profile_digest FROM work_command_profiles WHERE task_id=%s FOR SHARE',
                                              (action['task_id'],))).fetchone()
        if not profile_row:
            raise WorkNotFound()
        profile = parse(CommandProfile, profile_row['profile'])
        if (canonical(profile.model_dump())[1] != profile_row['profile_digest']
                or profile_row['profile_digest'] != binding.profileDigest
                or profile.taskId != action['task_id']
                or any(getattr(binding, k) != v for k, v in profile.route.model_dump().items())
                or type(live) is not LiveCommandConnection):
            raise WorkConflict('command_profile_changed')
        self._connection(live, profile, binding.connectionId)
        return preparation, binding, row, dispatch, profile

    def _sign_control(self, binding, challenge, challenge_token, dispatch, *, now, expires, **fields):
        if not self.prepare_clock.healthy() or expires <= now:
            raise WorkConflict('command_control_expired')
        return self.signer.sign(dict(**binding.model_dump(), version=2,
            iss=self.control_issuer, aud=self.enforcement_issuer, jti=str(uuid4()),
            purpose='work_command_control_request', challengeDigest=token_digest(challenge_token),
            requestId=challenge.requestId, nonce=challenge.nonce, issuedAtMs=now, expiresAtMs=expires,
            dispatch=dispatch.model_dump() if dispatch else None, **fields), purpose='work_command_control_request')

    async def authorize_lookup(self, connection, action_id, signed_challenge, *, request_id, nonce, include_output):
        """Internal original-Action lookup. No execution authority or artifact publication."""
        from .work_command_store import now_ms
        self._ready_service()
        if type(include_output) is not bool:
            raise WorkConflict('command_output_scope_required')
        async with self.input_scope.lock(), self.transport.guard(connection) as live:
            async with self.store._transaction(trusted=True) as db:
                task, action = await self.store._action(db, action_id)
                preparation, binding, row, dispatch, _ = await self._control_original(db, action, live)
                if (row is None or row['state'] not in ('issued', 'consumed')
                        or include_output and row['state'] != 'consumed'):
                    raise WorkConflict('command_lookup_required')
                challenge = self._control_challenge(signed_challenge, binding,
                    request_id=request_id, nonce=nonce, operation='lookup')
                self.store._active(task)
                if (action['status'] not in ('admitted', 'unknown') or not action['unexpired']
                        or not action['requires_approval'] or action['decision'] != 'approved'
                        or action['authority_generation'] != task['authority_generation']):
                    raise WorkConflict('command_admission_changed')
                profile, digest = await self.profiles.resolve_in_transaction(db, task)
                if digest != binding.profileDigest:
                    raise WorkConflict('command_profile_changed')
                self.profiles.check_command(profile, row['operation']['command'])
                proof = row['engine_proof']
                if type(proof) is not dict or set(proof) != {'facts', 'activityId', 'correctionContextId'}:
                    raise WorkConflict('command_proof_changed')
                bounded_value(proof)
                try:
                    facts = EngineActivityFacts(**proof['facts'])
                except (TypeError, ValueError):
                    raise WorkConflict('command_proof_changed') from None
                context = WorkRuntimeContext(task['id'], action['run_id'], task['bot_id'], task['objective'],
                                             task['token_limit'], proof['correctionContextId'])
                fence = WorkFence(action['run_id'], row['original_claim_id'], row['original_epoch'])
                await self._sdk(db, context, facts, proof['activityId'], task, fence)
                if proof['correctionContextId'] != action['correction_context_id']:
                    raise WorkConflict('command_proof_changed')
                await self.input_scope.revalidate_in_transaction(db, context, task, row['operation']['command'], row['input_scope'])
                claim = await (await db.execute('SELECT expires_at FROM work_claims WHERE run_id=%s AND claim_id=%s',
                                               (action['run_id'], fence.claim_id))).fetchone()
                now = await now_ms(db)
                expires = min(now + 30000, int(action['expires_at'].timestamp() * 1000), int(claim['expires_at'].timestamp() * 1000))
                token = self._sign_control(binding, challenge, signed_challenge, dispatch, now=now, expires=expires,
                                           operation='lookup', includeOutput=include_output)
                await check_fence(db, action['run_id'], fence)
                if await now_ms(db) >= expires:
                    raise WorkConflict('command_control_expired')
            return dict(status='authorized', token=token)

    async def authorize_owner_stop(self, owner_token, connection, action_id, signed_challenge, *, request_id, nonce):
        """Owner-only shutdown of the original unit, including after Task cancellation.

        A stop cannot disclose bytes, recreate a unit, modify a dispatch or settle Work effects.
        Membership/model availability is deliberately not required to stop an already owned unit.
        """
        from .work_command_store import now_ms
        self._ready_service()
        async with self.input_scope.lock(), self.transport.guard(connection) as live:
            async with self.store._transaction(owner_token) as db:
                _, action = await self.store._action(db, action_id)
                _, binding, _, dispatch, profile = await self._control_original(db, action, live)
                node = await (await db.execute('SELECT credential_digest,revoked_at FROM node_credentials WHERE node_id=%s FOR SHARE',
                                              (binding.nodeId,))).fetchone()
                if not node or node['revoked_at'] is not None or node['credential_digest'] != profile.credentialDigest:
                    raise WorkConflict('command_identity_changed')
                challenge = self._control_challenge(signed_challenge, binding,
                    request_id=request_id, nonce=nonce, operation='stop')
                now = await now_ms(db)
                token = self._sign_control(binding, challenge, signed_challenge, dispatch, now=now, expires=now + 5000,
                                           operation='stop', reason='owned_cleanup')
                if await now_ms(db) >= now + 5000:
                    raise WorkConflict('command_control_expired')
            return dict(status='authorized', token=token)
