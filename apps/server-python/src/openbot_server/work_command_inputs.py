"""Mandatory original input scope over existing OwnerFiles; no staging/storage implementation."""
from dataclasses import dataclass, field
import hashlib

from .task_store import attachment_ids
from .work_command_contract import Command, bounded_value, parse, strict_json
from .work_command_profiles import command_source
from .work_corrections import check_context
from .work_product_reads import ProductWorkReads
from .work_values import WorkConflict


@dataclass(frozen=True)
class PreparedCommand:
    """Opaque local preparation result. JSON/HTTP/Node data cannot mint its instance seal."""
    connection: object
    native_deadline_ms: int
    input_digest: str
    action_id: str
    original_epoch: int
    operation_fingerprint: str
    _scope_bytes: bytes = field(repr=False)
    _seal: object = field(repr=False)


class CommandInputScope:
    def __init__(self, files):
        if files is None or not all(callable(getattr(files,name,None)) for name in ('lock','validate_references','read')):
            raise ValueError('command_input_scope_required')
        self.files=files
        self._seal=object()

    def lock(self): return self.files.lock()

    async def freeze_in_transaction(self, db, context, task, command, attachments):
        """Caller owns files->identity->source/Task and has already checked real SDK/fence."""
        command=parse(Command,command)
        if (task['id']!=context.task_id or task['bot_id']!=context.bot_id or task['objective']!=context.objective
                or type(attachments) is not list or len(attachments)>8):
            raise WorkConflict('command_input_scope_changed')
        await check_context(db,task,context.run_id,context.correction_token)
        source,_=await command_source(db,task)
        refs=attachment_ids(context.objective)
        self.files.validate_references(source['channel_id'],refs)
        names=[];ids=[];items=[]
        for item in attachments:
            if type(item) is not dict or set(item)!={'path','attachmentId'}:
                raise WorkConflict('command_input_scope_changed')
            if type(item['path']) is not str or not 1<=len(item['path'])<=128 or type(item['attachmentId']) is not str:
                raise WorkConflict('command_input_scope_changed')
            names.append(item['path']);ids.append(item['attachmentId'])
            if item['attachmentId'] not in refs: raise WorkConflict('command_input_scope_changed')
            # Reuse the retained read snapshot, including explicit derived-text version. This
            # first adapter refuses binary inputs with no authorized extraction; it never OCRs.
            snapshot,_=ProductWorkReads._attachment(self,context,dict(channelId=source['channel_id']),
                dict(attachmentId=item['attachmentId'],offset=0,limit=12000))
            metadata,data=self.files.read(source['channel_id'],item['attachmentId'])
            items.append(dict(path=item['path'],attachmentId=item['attachmentId'],snapshot=snapshot,
                size=len(data),sha256=metadata['sha256']))
        if len(set(ids))!=len(ids) or names!=sorted(set(names)):
            raise WorkConflict('command_input_scope_changed')
        manifest=[dict(path=item['path'],size=item['size'],sha256=item['sha256']) for item in items]
        if manifest != [entry.model_dump() for entry in command.inputManifest]:
            raise WorkConflict('command_input_manifest_changed')
        value=dict(kind='work_command_inputs',version=1,taskId=task['id'],runId=context.run_id,
            generation=task['authority_generation'],correctionContextId=context.correction_token,
            sourceRunId=source['legacy_run_id'],channelId=source['channel_id'],messageId=source['source_message_id'],
            instructionDigest=hashlib.sha256(context.objective.encode()).hexdigest(),inputDigest=command.inputDigest,items=items)
        bounded_value(value)
        return value

    def prepared(self, connection, native_deadline_ms, receipt, operation, fingerprint):
        """Trusted dispatch.prepare is the public preparation entry; no DTO conversion exists."""
        return PreparedCommand(connection,native_deadline_ms,receipt['inputDigest'],operation.actionId,operation.originalEpoch,
            fingerprint,bounded_value(receipt),self._seal)

    def receipt(self, prepared):
        if type(prepared) is not PreparedCommand or prepared._seal is not self._seal:
            raise WorkConflict('command_preparation_required')
        return strict_json(prepared._scope_bytes)

    async def revalidate_in_transaction(self, db, context, task, command, receipt):
        if type(receipt) is not dict or type(receipt.get('items')) is not list:
            raise WorkConflict('command_input_scope_changed')
        bounded_value(receipt)
        try: bindings=[dict(path=item['path'],attachmentId=item['attachmentId']) for item in receipt['items']]
        except (KeyError,TypeError): raise WorkConflict('command_input_scope_changed') from None
        actual=await self.freeze_in_transaction(db,context,task,command,bindings)
        if actual!=receipt: raise WorkConflict('command_input_scope_changed')
        return True
