"""Loopback-only reference with explicit authority; no dotenv or schema migration."""
from pathlib import Path
import os
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import uvicorn
from openbot_server.app import create_app
from openbot_server.database import PostgresReadStore
from openbot_server.auth import OwnerAuthentication
from openbot_server.auth_store import PostgresAuthStore
from openbot_server.identity_store import PostgresIdentityStore


def main():
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
    if authority not in ("read-only", "owner-auth", "identity", "tasks"):
        raise SystemExit("Unknown control-plane authority mode.")
    owner_name = os.environ.get("OPENBOT_OWNER_NAME", "Owner")
    auth = None
    origins = ()
    if authority in ("owner-auth", "identity", "tasks"):
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
    tasks = None
    run_commands = None
    if authority in ("identity", "tasks"):
        from openbot_server.conversations import PostgresConversationStore
        from openbot_server.profile_details import PostgresProfileStore
        conversations = PostgresConversationStore(dsn)
        profiles = PostgresProfileStore(dsn)
    if authority == "tasks":
        from openbot_server.task_store import PostgresTaskStore
        tasks = PostgresTaskStore(dsn)
        from openbot_server.run_command_store import PostgresRunCommandStore
        run_commands = PostgresRunCommandStore(dsn)
    app = create_app(PostgresReadStore(dsn), owner_name=owner_name,
                     secure_cookies=cookie_mode == "secure", allowed_origins=origins, auth=auth,
                     identity=PostgresIdentityStore(dsn) if authority in ("identity", "tasks") else None, conversations=conversations, profiles=profiles, tasks=tasks, run_commands=run_commands)
    uvicorn.run(app, host="127.0.0.1", port=int(port_text), proxy_headers=False, access_log=False,
                log_level="warning", loop="asyncio", http="h11", timeout_graceful_shutdown=8)


if __name__ == "__main__":
    main()
