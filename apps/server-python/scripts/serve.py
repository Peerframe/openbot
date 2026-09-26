"""Loopback-default reference with explicit authority/listen host; no dotenv or schema migration."""
from pathlib import Path
import asyncio
import importlib.util
import json
import os
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent-runtime-python" / "src"))

import uvicorn
from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore
from openbot_server.auth import OwnerAuthentication
from openbot_server.auth_store import PostgresAuthStore
from openbot_server.identity_store import PostgresIdentityStore


def main():
    host = os.environ.get("OPENBOT_CONTROL_HOST", "127.0.0.1")
    if host not in ("127.0.0.1", "0.0.0.0"):
        raise SystemExit("Control-plane host must be 127.0.0.1 or 0.0.0.0.")
    dsn = os.environ.get("OPENBOT_CONTROL_DATABASE_URL")
    if not dsn:
        raise SystemExit("Set an explicit OPENBOT_CONTROL_DATABASE_URL for the read reference.")
    cookie_mode = os.environ.get("OPENBOT_CONTROL_COOKIE_MODE", "secure")
    if cookie_mode not in ("secure", "loopback"):
        raise SystemExit("Unknown control-plane cookie mode.")
    port_text = os.environ.get("OPENBOT_CONTROL_PORT", "3101")
    if not port_text.isascii() or not port_text.isdigit() or not 1 <= int(port_text) <= 65535:
        raise SystemExit("Control-plane port must be between 1 and 65535.")
    authority = os.environ.get("OPENBOT_CONTROL_AUTHORITY", "read-only")
    if authority not in ("read-only", "owner-auth", "identity", "tasks", "work", "product"):
        raise SystemExit("Unknown control-plane authority mode.")
    owner_name = os.environ.get("OPENBOT_OWNER_NAME", "Owner")
    auth = None
    origins = ()
    if authority in ("owner-auth", "identity", "tasks", "work", "product"):
        password = os.environ.get("OPENBOT_CONTROL_OWNER_PASSWORD")
        if password is None:
            raise SystemExit("Owner-auth requires its explicit control-plane Owner password.")
        ttl_text = os.environ.get("OPENBOT_CONTROL_SESSION_TTL_HOURS", "12")
        if not ttl_text.isascii() or not ttl_text.isdigit() or len(ttl_text) > 3:
            raise SystemExit("Control-plane session TTL must be 1 to 168 hours.")
        auth = OwnerAuthentication(PostgresAuthStore(dsn), owner_name=owner_name, password=password,
                                   ttl_hours=int(ttl_text))
        default_origins = f"http://127.0.0.1:{int(port_text)},http://localhost:{int(port_text)}"
        origins = tuple(item.strip() for item in os.environ.get("OPENBOT_CONTROL_ALLOWED_ORIGINS", default_origins).split(",") if item.strip())
    conversations = None
    profiles = None
    product = None
    command_installation = None
    command_path = os.environ.get('OPENBOT_CONTROL_COMMAND_CONFIG_PATH')
    if command_path is not None and (authority != 'product'
            or not os.environ.get('OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH')):
        raise SystemExit('Command configuration requires product mode and an explicit Work engine configuration.')
    if authority == "product":
        if importlib.util.find_spec('pydantic_ai') is None:
            raise SystemExit('Product mode requires the pinned Worker environment; run bootstrap-worker.sh.')
        from openbot_server.product_control import OwnerProduct
        from openbot_server.model_settings import ModelSettingsService
        from openbot_server.employee_knowledge import PostgresEmployeeKnowledge
        from openbot_server.automation_store import PostgresAutomations
        from openbot_server.conversation_interactions import PostgresConversationInteractions
        object_root = os.environ.get("OPENBOT_CONTROL_OBJECT_ROOT")
        if not object_root:
            raise SystemExit("Product mode requires OPENBOT_CONTROL_OBJECT_ROOT.")
        model_directory = os.environ.get("OPENBOT_CONTROL_MODEL_DIRECTORY")
        legacy_path = os.environ.get('OPENBOT_CONTROL_MODEL_SETTINGS_PATH')
        legacy_key = os.environ.get('OPENBOT_CONTROL_MODEL_ENCRYPTION_KEY')
        if legacy_path or legacy_key:
            if not legacy_path or not legacy_key or model_directory:
                raise SystemExit('Select either the retained model-settings path/key or a model directory.')
            model = ModelSettingsService.from_legacy(legacy_path, legacy_key)
        else:
            model = ModelSettingsService(model_directory) if model_directory else None
        from openbot_server.model_connections import ModelConnectionsService
        custom_urls = json.loads(os.environ.get('OPENBOT_CONTROL_MODEL_CUSTOM_BASE_URLS', '[]'))
        connections = asyncio.run(ModelConnectionsService.from_key_path(dsn,
            os.environ.get('OPENBOT_CONTROL_MODEL_CONNECTION_KEY_PATH', str(Path(object_root)/'model-connections.key')),
            custom_base_urls=custom_urls))
        from openbot_server.work_command_installation import CommandInstallation
        command_installation = CommandInstallation.from_file(command_path, connections)
        from openbot_server.worker_host_identity import PostgresWorkerHostIdentity
        from openbot_server.worker_host_registry import WorkerHostRegistry
        worker_identity = PostgresWorkerHostIdentity(dsn)
        worker_registry = WorkerHostRegistry(worker_identity,
            command_channel=command_installation.channel_configuration if command_installation else None)
        if command_installation:
            command_installation.attach(worker_registry.commands)
        from openbot_server.browser_gate import BrowserPauseGate
        from openbot_server.browser_sessions import BrowserSessionsService
        browser = BrowserSessionsService(dsn,worker_registry,gate=BrowserPauseGate(dsn),
                                        agent_gate_configured=False)
        from openbot_server.plugin_service import PluginService
        from openbot_server.plugin_inputs import LegacyManifestCodec
        plugins = PluginService(dsn,
            os.environ.get('OPENBOT_CONTROL_PLUGIN_STORE_PATH', str(Path(object_root)/'plugins'/'state.json')),
            local_endpoints=json.loads(os.environ.get('OPENBOT_CONTROL_PLUGIN_LOCAL_ENDPOINTS','[]')),
            codec=LegacyManifestCodec(node_binary=os.environ.get('OPENBOT_CONTROL_NODE_EXECUTABLE','node'),
                locale=os.environ.get('OPENBOT_CONTROL_NODE_LOCALE','en-US')))
        product = OwnerProduct(dsn, object_root=object_root, model_settings=model,
            knowledge=PostgresEmployeeKnowledge(dsn), interactions=PostgresConversationInteractions(dsn),
            plugins=plugins,model_connections=connections,worker_identity=worker_identity,
            worker_registry=worker_registry,browser=browser,nodes=worker_registry.list)
        product.automations = PostgresAutomations(dsn, files=product.files,model_connections=connections)
        from openbot_server.employee_portability import PostgresEmployeePortability
        publisher = None
        publisher_directory = os.environ.get('OPENBOT_CONTROL_PUBLISHER_DIRECTORY')
        publisher_passphrase = os.environ.get('OPENBOT_CONTROL_PUBLISHER_PASSPHRASE_FILE')
        if publisher_directory or publisher_passphrase:
            if not publisher_directory or not publisher_passphrase:
                raise SystemExit('Publisher directory and private passphrase file must be configured together.')
            from openbot_server.employee_portability_publisher import EmployeePublisher
            publisher = EmployeePublisher.load(publisher_directory, publisher_passphrase)
        product.portability = PostgresEmployeePortability(dsn, publisher=publisher,
            knowledge=product.knowledge, list_nodes=product.workspace.nodes)
        from openbot_server.attachment_processing import AttachmentProcessingService
        product.processing = AttachmentProcessingService(dsn, files=product.files, settings=model,
            node_executable=os.environ.get('OPENBOT_CONTROL_NODE_EXECUTABLE'),
            module_root=os.environ.get('OPENBOT_CONTROL_NODE_MODULE_ROOT'))
    tasks = None
    run_commands = None
    if authority in ("identity", "tasks", "work", "product"):
        from openbot_server.conversations import PostgresConversationStore
        from openbot_server.profile_details import PostgresProfileStore
        conversations = PostgresConversationStore(dsn)
        profiles = PostgresProfileStore(dsn)
    if authority in ("tasks", "work", "product"):
        from openbot_server.task_store import PostgresTaskStore
        tasks = PostgresTaskStore(dsn, files=product.files if product else None,
                                 model_connections=product.model_connections if product else None)
        from openbot_server.run_command_store import PostgresRunCommandStore
        run_commands = PostgresRunCommandStore(dsn)
    work = None
    if authority in ("work", "product"):
        from openbot_server.work_store import PostgresWorkStore
        from openbot_server.work_files import LocalWorkFiles
        from openbot_server.work_task_profiles import WorkTaskProfiles
        artifact_root = os.environ.get("OPENBOT_CONTROL_ARTIFACT_ROOT")
        work = PostgresWorkStore(dsn,files=LocalWorkFiles(artifact_root) if artifact_root else None,
                                 task_profiles=WorkTaskProfiles(files=product.files) if product is not None else None,
                                 command_profiles=command_installation.profiles if command_installation else None)
    if product is not None:
        from openbot_server.work_sources import WorkSourceAdmission
        budget_text = os.environ.get('OPENBOT_CONTROL_WORK_TOKEN_LIMIT', '100000')
        if not budget_text.isascii() or not budget_text.isdigit() or len(budget_text) > 10:
            raise SystemExit('Product work token limit must be an explicit bounded integer.')
        sources = WorkSourceAdmission(work, token_limit=int(budget_text),
                                     **(command_installation.source_options if command_installation else {}))
        tasks.work_sources = sources
        run_commands.work_sources = sources
        product.automations.work_sources = sources
        product.interactions.work_sources = sources
        engine_config = os.environ.get('OPENBOT_CONTROL_TEMPORAL_CONFIG_PATH')
        if engine_config:
            from openbot_server.work_product_runtime import ProductWorkRuntime
            from openbot_server.work_product_service import ProductWorkService
            search_key = os.environ.get('TAVILY_API_KEY')
            async def compose(client, scope):
                driver = (await command_installation.driver(work,client,scope,product.files)
                          if command_installation else None)
                return ProductWorkRuntime(work,client,scope,product,tavily_key=search_key,sources=sources,
                                          command_driver=driver).options()
            product.work_runtime = ProductWorkService(work,engine_config,compose=compose,
                                                      automations=product.automations)
    app = create_app(PostgresReadStore(dsn), owner_name=owner_name,
                     secure_cookies=cookie_mode == "secure", allowed_origins=origins, auth=auth,
                     identity=PostgresIdentityStore(dsn,model_connections=product.model_connections if product else None) if authority in ("identity", "tasks", "work", "product") else None, conversations=conversations, profiles=profiles, tasks=tasks, run_commands=run_commands, work=work, product=product)
    web_root = os.environ.get("OPENBOT_CONTROL_WEB_ROOT")
    if web_root:
        from fastapi.staticfiles import StaticFiles
        web_path = Path(web_root)
        if not web_path.is_absolute() or not (web_path / "index.html").is_file():
            raise SystemExit("An absolute built Web directory is required.")
        app.mount("/", StaticFiles(directory=web_path, html=True), name="web")
    from openbot_server.worker_host_registry import worker_host_uvicorn_options
    uvicorn.run(app, host=host, port=int(port_text), **worker_host_uvicorn_options(), access_log=False,
                log_level="warning", loop="asyncio", http="h11", timeout_graceful_shutdown=8)


if __name__ == "__main__":
    main()
