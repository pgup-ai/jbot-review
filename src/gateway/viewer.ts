/**
 * The whole viewer, inlined as a string so the bundled gateway is one file
 * with zero static assets — `node dist/gateway/server.js` serves everything.
 * Rendering knowledge lives HERE, not in the gateway: the server relays
 * envelopes opaquely, so new ACP update kinds only ever touch this page.
 */
export const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>jbot observer</title>
<style>
  :root { --bg:#0e1116; --panel:#161b22; --line:#242b36; --text:#dde3ec; --dim:#8b95a5;
          --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui,sans-serif; display:flex; height:100vh; }
  aside { width:260px; min-width:200px; border-right:1px solid var(--line); overflow-y:auto; padding:10px; }
  main { flex:1; display:flex; flex-direction:column; min-width:0; }
  h1 { font-size:14px; margin:4px 6px 10px; color:var(--dim); font-weight:600; }
  .run { margin-bottom:10px; }
  .run-id { font:12px var(--mono); color:var(--dim); padding:2px 6px; word-break:break-all; }
  .session { display:block; width:100%; text-align:left; background:none; border:1px solid transparent;
             color:var(--text); font:12px var(--mono); padding:4px 8px; border-radius:6px; cursor:pointer; }
  .session:hover { background:var(--panel); }
  .session.active { border-color:var(--accent); background:var(--panel); }
  #status { padding:8px 14px; border-bottom:1px solid var(--line); color:var(--dim); font-size:12px;
            display:flex; gap:10px; align-items:center; }
  #status .dot { width:8px; height:8px; border-radius:50%; background:var(--dim); }
  #status.live .dot { background:var(--ok); }
  #log { flex:1; overflow-y:auto; padding:14px; }
  .ev { margin:0 0 8px; max-width:900px; }
  .msg { white-space:pre-wrap; word-break:break-word; }
  .thought { color:var(--dim); font-style:italic; white-space:pre-wrap; word-break:break-word; }
  .chip { display:inline-block; font:11px var(--mono); border:1px solid var(--line); border-radius:10px;
          padding:1px 8px; margin:1px 4px 1px 0; color:var(--dim); background:var(--panel); }
  .chip.perm-allow { color:var(--ok); border-color:var(--ok); }
  .chip.perm-reject { color:var(--bad); border-color:var(--bad); }
  .chip.stop { color:var(--accent); border-color:var(--accent); }
  .meta { color:var(--dim); font:11px var(--mono); margin:10px 0 4px; }
  #empty { color:var(--dim); padding:30px; }
</style>
</head>
<body>
<aside>
  <h1>jbot observer</h1>
  <div id="runs"></div>
</aside>
<main>
  <div id="status"><span class="dot"></span><span id="statusText">pick a session</span></div>
  <div id="log"><div id="empty">Reviews appear here as they stream in. Run the demo feeder or a teed review.</div></div>
</main>
<script>
const qs = new URLSearchParams(location.search);
const token = qs.get('token');
const withToken = (url) => token ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : url;
const runsEl = document.getElementById('runs');
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
let es = null;
let active = null;
let msgEl = null;      // open assistant-message element (streamed chunks)
let thoughtEl = null;  // open thought element

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function append(node) {
  const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;
  logEl.appendChild(node);
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}

function closeStreams() { msgEl = null; thoughtEl = null; }

function renderUpdate(update) {
  const kind = update.sessionUpdate;
  if (kind === 'agent_message_chunk' && update.content && update.content.type === 'text') {
    thoughtEl = null;
    if (!msgEl) { msgEl = el('div', 'ev msg'); append(msgEl); }
    msgEl.textContent += update.content.text;
    append(msgEl); // re-stick scroll
  } else if (kind === 'agent_thought_chunk' && update.content && update.content.type === 'text') {
    msgEl = null;
    if (!thoughtEl) { thoughtEl = el('div', 'ev thought'); append(thoughtEl); }
    thoughtEl.textContent += update.content.text;
  } else if (kind === 'tool_call') {
    closeStreams();
    append(el('span', 'chip', '🛠 ' + (update.title || update.kind || update.toolCallId || 'tool')));
  } else if (kind === 'usage_update' && update.used !== undefined) {
    append(el('span', 'chip', 'ctx ' + update.used + (update.size ? '/' + update.size : '')));
  }
}

function renderEnvelope(e) {
  const frame = e.frame || {};
  if (frame.method === 'session/update' && frame.params && frame.params.update) {
    renderUpdate(frame.params.update);
  } else if (frame.method === 'session/prompt' && e.dir === 'out') {
    closeStreams();
    append(el('div', 'meta', '── prompt sent (' + e.label + ', ' + e.agent + ') ──'));
  } else if (frame.method === 'session/request_permission' && frame.params && frame.params.toolCall) {
    closeStreams();
    append(el('span', 'chip', '🔐 asks: ' + (frame.params.toolCall.kind || frame.params.toolCall.title || 'tool')));
  } else if (e.dir === 'out' && frame.result && frame.result.outcome) {
    const oc = frame.result.outcome.outcome;
    append(el('span', 'chip ' + (oc === 'selected' ? 'perm-allow' : 'perm-reject'),
      oc === 'selected' ? '✓ ' + frame.result.outcome.optionId : '✗ cancelled'));
  } else if (e.dir === 'in' && frame.result && frame.result.stopReason) {
    closeStreams();
    append(el('span', 'chip stop', '■ ' + frame.result.stopReason));
  }
}

function open(runId, sessionId, button) {
  if (es) es.close();
  document.querySelectorAll('.session.active').forEach((b) => b.classList.remove('active'));
  button.classList.add('active');
  active = runId + '/' + sessionId;
  logEl.textContent = '';
  closeStreams();
  statusText.textContent = active + ' — connecting…';
  es = new EventSource(withToken('/api/runs/' + runId + '/sessions/' + sessionId + '/stream'));
  es.onopen = () => { statusEl.classList.add('live'); statusText.textContent = active + ' — live'; };
  es.onerror = () => { statusEl.classList.remove('live'); statusText.textContent = active + ' — reconnecting…'; };
  es.onmessage = (msg) => { try { renderEnvelope(JSON.parse(msg.data)); } catch {} };
}

let lastRunsJson = '';
async function refreshRuns() {
  try {
    const text = await (await fetch(withToken('/api/runs'))).text();
    if (text === lastRunsJson) return; // unchanged: keep the DOM (and clicks) stable
    lastRunsJson = text;
    const runs = JSON.parse(text);
    runsEl.textContent = '';
    for (const run of runs) {
      const box = el('div', 'run');
      box.appendChild(el('div', 'run-id', run.runId));
      for (const session of run.sessions) {
        const b = el('button', 'session', session);
        if (active === run.runId + '/' + session) b.classList.add('active');
        b.onclick = () => open(run.runId, session, b);
        box.appendChild(b);
      }
      runsEl.appendChild(box);
    }
  } catch {}
}
refreshRuns();
setInterval(refreshRuns, 5000);
</script>
</body>
</html>
`;
