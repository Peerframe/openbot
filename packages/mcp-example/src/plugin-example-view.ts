/** Offline MCP Apps example: no host RPC capability and no external asset requests. */
export const examplePluginView = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Notebook demo</title>
<body>
  <h1>Notebook demo</h1>
  <p>This isolated view can run local interactions without accessing the host.</p>
  <button id="count" type="button">Count clicks: 0</button>
  <button id="read" type="button">Read notebook resource</button>
  <pre id="notes"></pre>
  <script>
    let count = 0;
    let initialized = false;
    const host = window.parent;
    const initializeId = 'notebook-initialize';
    window.addEventListener('message', event => {
      if (event.source !== host) return;
      const message = event.data;
      if (message?.jsonrpc !== '2.0') return;
      if (message.id === initializeId && message.result && !initialized) {
        initialized = true;
        host.postMessage({jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {}}, '*');
      }
      if (String(message.id).startsWith('read-notes-')) {
        document.getElementById('notes').textContent = message.result?.contents?.map(item => item.text).join('\\n') || 'Resource read denied or unavailable.';
      }
      if (message.method === 'ui/resource-teardown' && message.id !== undefined) {
        host.postMessage({jsonrpc: '2.0', id: message.id, result: {}}, '*');
      }
    });
    host.postMessage({
      jsonrpc: '2.0', id: initializeId, method: 'ui/initialize',
      params: {
        protocolVersion: '2026-01-26',
        appInfo: {name: 'openbot-notebook-demo', version: '1.0.0'},
        appCapabilities: {}
      }
    }, '*');
    let reads = 0;
    document.getElementById('read').onclick = () => {
      host.postMessage({jsonrpc:'2.0',id:'read-notes-'+(++reads),method:'resources/read',params:{uri:'notes://current'}}, '*');
    };
    document.getElementById('count').onclick = event => {
      event.currentTarget.textContent = 'Count clicks: ' + (++count);
    };
  </script>
</body>
</html>`;
