"""Read the actual local Python product API, with no proxy discovery or credentials."""
import json
import os
import urllib.request

try:
    port=int(os.environ.get('OPENBOT_CONTROL_PORT','3001'))
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f'http://127.0.0.1:{port}/health',timeout=2) as response:
        value=json.loads(response.read(4097))
        assert value['ok'] is True and value['service']=='openbot-server' and value['phase']=='python-product-candidate'
except Exception:
    raise SystemExit(1) from None
