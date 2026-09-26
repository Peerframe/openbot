"""Explicit product lifecycle: one SDK Worker and bounded ingress, never a recovery loop."""
import asyncio
import inspect
import json

from pydantic_ai.durable_exec.temporal import PydanticAIPlugin

from .work_dispatch_batch import dispatch_batch
from .work_engine_client import connect, read_owned_file, tls_config, validate_address
from .work_handoff import HandoffStore
from .work_repair_dispatch import repair_batch
from .work_terminal import terminal_batch
from .work_values import InvalidWork, WorkConflict, text
from .work_worker import TYPE, product_worker
from .temporal_engine import TemporalEnginePort


def configuration(path):
    """The Server supplies its existing store; an engine file cannot select another database."""
    data = json.loads(read_owned_file(path, private=True, maximum=16384))
    required = {'temporal_address', 'namespace', 'queue', 'tls'}
    limits = {'limit': (16, 64), 'execution_timeout_seconds': (3600, 86400),
              'item_timeout_seconds': (10, 30), 'interval_seconds': (2, 30)}
    if type(data) is not dict or not required <= data.keys() or data.keys() - required - limits.keys():
        raise InvalidWork('invalid_product_engine_configuration')
    validate_address(data['temporal_address']); tls_config(data['tls'])
    text(data['namespace'], 64); text(data['queue'], 256)
    for name, (default, maximum) in limits.items():
        value = data.get(name, default)
        if type(value) is not int or not 1 <= value <= maximum:
            raise InvalidWork('invalid_product_engine_limit')
        data[name] = value
    return data


class ProductWorkService:
    """Trusted composition is code, never an operator-provided import path or Workflow input.

    Repeated passes only deliver new admissions, observe unconfirmed starts and deliver explicit
    repair commands. The original engine Run owns continuation; no failed Worker is restarted.
    """

    def __init__(self, store, config_path, *, compose, automations=None):
        if not callable(compose): raise InvalidWork('product_composition_required')
        if store.files is None: raise InvalidWork('work_files_unconfigured')
        self.store, self._config_path, self._compose = store, config_path, compose
        self._automations, self._task, self._ready = automations, None, None
        self._started, self._closing = False, False
        self._state, self._last_pass = 'unstarted', None
        # Scan order only; SQL terminal events remain the durable source of truth.
        self._terminal_cursor = None

    @property
    def status(self):
        return {'state': self._state, 'lastPass': self._last_pass}

    async def start(self):
        if self._started: raise WorkConflict('product_service_already_started')
        self._started = True
        self._ready = asyncio.get_running_loop().create_future()
        self._task = asyncio.create_task(self._run(), name='openbot-product-work')
        try:
            async with asyncio.timeout(30):
                await asyncio.shield(self._ready)
        except BaseException:
            await self.close()
            # Retrieve a concurrent startup exception before dropping this private future.
            if self._ready.done() and not self._ready.cancelled(): self._ready.exception()
            raise

    async def close(self):
        self._closing = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._state != 'failed': self._state = 'stopped'

    async def _run(self):
        try:
            config = configuration(self._config_path)
            async with asyncio.timeout(20):
                await self.store.verify_schema()
                client = await connect(config['temporal_address'], config['tls'],
                    namespace=config['namespace'], plugins=[PydanticAIPlugin()])
            scope = dict(expected_namespace=config['namespace'], expected_queue=config['queue'],
                         expected_workflow_type=TYPE)
            options = self._compose(client, scope)
            if inspect.isawaitable(options): options = await options
            allowed = {'load_services', 'verify_result', 'plan_effect', 'load_effect', 'load_lookup',
                       'load_tool_result', 'enable_corrections', 'reset_history_on_correction',
                       'load_prompt', 'publication', 'publication_scope', 'large_tool_arguments', 'effect_readiness',
                       'join_request','unconsumed_children'}
            if (type(options) is not dict or not {'load_services', 'verify_result'} <= options.keys()
                    or options.keys() - allowed):
                raise InvalidWork('invalid_product_composition')
            async with product_worker(client, self.store, namespace=config['namespace'],
                                      queue=config['queue'], **options):
                self._state = 'running'
                self._ready.set_result(None)
                while True:
                    await self._pass(client, config, repair=options.get('load_lookup') is not None)
                    await asyncio.sleep(config['interval_seconds'])
        except asyncio.CancelledError:
            if not self._closing:
                self._state = 'failed'
            if not self._ready.done():
                self._ready.set_exception(WorkConflict('product_service_start_failed'))
        except Exception:
            # SDK/DB/file exceptions can contain credentials, private paths or tool content.
            self._state = 'failed'
            if not self._ready.done():
                self._ready.set_exception(WorkConflict('product_service_start_failed'))

    async def _pass(self, client, config, *, repair):
        observed = {'scheduled': 0, 'deliveries': 0, 'unconfirmed': 0, 'repairs': 0,
                    'terminalClosures': 0, 'terminalUnconfirmed': 0, 'errors': 0}
        if self._automations is not None:
            try:
                async with asyncio.timeout(15):
                    scheduled = await self._automations.submit_due()
                observed['scheduled'] = len(scheduled)
            except asyncio.CancelledError:
                raise
            except Exception:
                observed['errors'] += 1
        common = dict(namespace=config['namespace'], queue=config['queue'], workflow_type=TYPE,
                      limit=config['limit'], item_timeout_seconds=config['item_timeout_seconds'])
        try:
            rows = await dispatch_batch(HandoffStore(self.store), TemporalEnginePort(client), **common,
                                       execution_timeout_seconds=config['execution_timeout_seconds'])
            observed['deliveries'] = len(rows)
            observed['unconfirmed'] = sum(row['status'] != 'acknowledged' for row in rows)
        except asyncio.CancelledError:
            raise
        except Exception:
            observed['errors'] += 1
        try:
            page = await terminal_batch(self.store, client, after=self._terminal_cursor, **common)
            self._terminal_cursor = page.next_cursor
            observed['terminalClosures'] = sum(row['status'] == 'closed' for row in page.results)
            observed['terminalUnconfirmed'] = sum(row['status'] == 'unconfirmed' for row in page.results)
        except asyncio.CancelledError:
            raise
        except Exception:
            observed['errors'] += 1
        if repair:
            try:
                rows = await repair_batch(self.store, client, **common)
                observed['repairs'] = len(rows)
            except asyncio.CancelledError:
                raise
            except Exception:
                observed['errors'] += 1
        self._last_pass = observed
