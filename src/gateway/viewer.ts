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
  :root {
    --bg:#0c0f14; --panel:#11161e; --elev:#18202b; --line:#232c39;
    --text:#e7edf4; --dim:#8a95a6; --faint:#525d6e;
    --accent:#5aa2f2; --ok:#43b06a; --warn:#d3a03a; --bad:#ef6a5f; --think:#9a86d6;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --ui:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.62 var(--ui);
         display:flex; -webkit-font-smoothing:antialiased; }
  ::selection { background:rgba(90,162,242,.28); }

  aside { width:270px; min-width:224px; border-right:1px solid var(--line); background:var(--panel);
          overflow-y:auto; }
  .brand { padding:17px 16px 13px; font-weight:600; letter-spacing:.2px; display:flex; align-items:center; gap:9px; }
  .brand .mark { width:9px; height:9px; border-radius:2px; background:var(--accent); transform:rotate(45deg); }
  .brand small { margin-left:auto; color:var(--faint); font-weight:400; font:11px var(--mono); }
  .runs { padding:2px 10px 20px; }
  .run { margin-bottom:15px; }
  .run-id { font:11px/1.5 var(--mono); color:var(--faint); padding:5px 8px 3px; word-break:break-all; }
  .session { display:flex; align-items:center; gap:9px; width:100%; text-align:left; background:none;
             border:1px solid transparent; color:var(--dim); font:12px/1.3 var(--mono); padding:7px 9px;
             border-radius:8px; cursor:pointer; transition:background .12s,border-color .12s,color .12s; }
  .session:hover { background:var(--elev); color:var(--text); }
  .session.active { border-color:var(--line); background:var(--elev); color:var(--text); }
  .session .sdot { width:6px; height:6px; border-radius:50%; background:var(--faint); flex:none; }
  .session.active .sdot { background:var(--accent); }

  main { flex:1; display:flex; flex-direction:column; min-width:0; position:relative; }
  header.meta { border-bottom:1px solid var(--line); padding:15px 24px 14px;
                display:flex; flex-direction:column; gap:9px;
                background:linear-gradient(180deg,var(--panel),transparent); }
  .meta-top { display:flex; align-items:baseline; gap:10px; }
  .meta-title { font-size:15px; font-weight:600; letter-spacing:.1px; }
  .meta-title .prov { color:var(--dim); font-weight:400; font:12px var(--mono); margin-left:2px; }
  .status { margin-left:auto; align-self:center; display:flex; align-items:center; gap:8px;
            font:12px var(--mono); color:var(--dim); }
  .status .dot { width:8px; height:8px; border-radius:50%; background:var(--faint); }
  .status.live .dot { background:var(--ok); animation:pulse 1.9s infinite; }
  .status.done .dot { background:var(--accent); }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(67,176,106,.5)} 70%{box-shadow:0 0 0 6px rgba(67,176,106,0)} 100%{box-shadow:0 0 0 0 rgba(67,176,106,0)} }
  .facts { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .fact { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border:1px solid var(--line);
          border-radius:20px; background:var(--panel); font:11px var(--mono); white-space:nowrap; }
  .fact .k { color:var(--faint); text-transform:uppercase; letter-spacing:.4px; font-size:10px; }
  .fact b { color:var(--text); font-weight:500; }

  #log { flex:1; overflow-y:auto; padding:22px 24px 44px; }
  .stream { max-width:864px; }
  .msg { white-space:pre-wrap; word-break:break-word; margin:3px 0 15px; }
  .thought { white-space:pre-wrap; word-break:break-word; color:var(--dim); font-style:italic;
             border-left:2px solid var(--think); padding:1px 0 1px 13px; margin:3px 0 15px; opacity:.92; }
  .turn { color:var(--faint); font:10px var(--mono); letter-spacing:.6px; text-transform:uppercase;
          margin:22px 0 13px; display:flex; align-items:center; gap:12px; }
  .turn::after { content:""; flex:1; height:1px; background:var(--line); }
  .chip { display:inline-flex; align-items:center; gap:8px; font:12px var(--mono); border:1px solid var(--line);
          border-radius:7px; padding:4px 10px; margin:2px 7px 9px 0; color:var(--dim); background:var(--panel); }
  .chip .tag { text-transform:uppercase; letter-spacing:.5px; font-size:10px; color:var(--faint); }
  .chip.ok { border-color:rgba(67,176,106,.42); } .chip.ok .tag { color:var(--ok); }
  .chip.bad { border-color:rgba(239,106,95,.42); } .chip.bad .tag { color:var(--bad); }
  .chip.ask { border-color:rgba(211,160,58,.42); } .chip.ask .tag { color:var(--warn); }
  .chip.end { border-color:rgba(90,162,242,.42); color:var(--text); } .chip.end .tag { color:var(--accent); }

  #jump { position:absolute; right:24px; bottom:24px; display:none; align-items:center; gap:6px;
          background:var(--accent); color:#06121f; border:none; border-radius:20px; padding:8px 14px;
          font:12px var(--ui); font-weight:600; cursor:pointer; box-shadow:0 5px 18px rgba(0,0,0,.45); }
  #jump.show { display:inline-flex; }

  #empty { color:var(--faint); padding:52px 8px; max-width:600px; }
  #empty p { margin:0 0 12px; }
  #empty code { font:12px var(--mono); color:var(--dim); background:var(--panel); border:1px solid var(--line);
                padding:2px 7px; border-radius:6px; }
</style>
</head>
<body>
<aside>
  <div class="brand"><span class="mark"></span> jbot observer <small id="conn"></small></div>
  <div class="runs" id="runs"></div>
</aside>
<main>
  <header class="meta" id="meta" hidden>
    <div class="meta-top">
      <div class="meta-title"><span id="mRole"></span><span class="prov" id="mProv"></span></div>
      <div class="status" id="mStatus"><span class="dot"></span><span id="mStatusText">idle</span></div>
    </div>
    <div class="facts" id="mFacts"></div>
  </header>
  <div id="log"><div id="empty">
    <p>Pick a session to watch it stream — reasoning, tool calls, permission decisions and findings appear as they happen.</p>
    <p>Feed a real review by pointing it here:<br /><code>JBOT_OBSERVER_URL=http://127.0.0.1:8790 npm run review:local</code></p>
  </div></div>
  <button id="jump">↓ latest</button>
</main>
<script>
var qs = new URLSearchParams(location.search);
var token = qs.get('token');
function withToken(u) { return token ? u + (u.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(token) : u; }

var runsEl = document.getElementById('runs');
var logEl = document.getElementById('log');
var jumpEl = document.getElementById('jump');
var metaEl = document.getElementById('meta');
var connEl = document.getElementById('conn');
var mRole = document.getElementById('mRole');
var mProv = document.getElementById('mProv');
var mStatus = document.getElementById('mStatus');
var mStatusText = document.getElementById('mStatusText');
var mFacts = document.getElementById('mFacts');

var es = null, active = null;
var msgEl = null, thoughtEl = null;
var meta = null, tick = null;

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function atBottom() { return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80; }
// Measure BEFORE mutating, restore after — otherwise a growing transcript
// pushes the bottom away and following silently stops.
function pinned(mutate) {
  var stick = atBottom();
  mutate();
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}
function append(node) { pinned(function () { logEl.appendChild(node); }); return node; }
function closeStreams() { msgEl = null; thoughtEl = null; }

function stream(kind, text) {
  pinned(function () {
    if (kind === 'msg') {
      thoughtEl = null;
      if (!msgEl) { msgEl = el('div', 'msg'); logEl.appendChild(msgEl); }
      msgEl.textContent += text;
    } else {
      msgEl = null;
      if (!thoughtEl) { thoughtEl = el('div', 'thought'); logEl.appendChild(thoughtEl); }
      thoughtEl.textContent += text;
    }
  });
}
function chip(cls, tag, text) {
  var c = el('span', 'chip' + (cls ? ' ' + cls : ''));
  c.appendChild(el('span', 'tag', tag));
  if (text) c.appendChild(document.createTextNode(text));
  closeStreams();
  return append(c);
}

function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n || 0); }
function elapsed() {
  if (!meta || !meta.firstTs) return '0:00';
  var end = meta.live ? Date.now() : meta.lastTs;
  var s = Math.max(0, Math.round((end - meta.firstTs) / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function fact(k, v) {
  var f = el('span', 'fact');
  f.appendChild(el('span', 'k', k));
  f.appendChild(el('b', null, v));
  return f;
}
function renderMeta() {
  if (!meta) return;
  var facts = [];
  if (meta.model) facts.push(fact('model', meta.model));
  if (meta.mode) facts.push(fact('mode', meta.mode));
  if (meta.inTok || meta.outTok) facts.push(fact('tokens', '↑' + fmt(meta.inTok) + '  ↓' + fmt(meta.outTok)));
  if (meta.ctxSize) facts.push(fact('context', fmt(meta.ctxUsed) + ' / ' + fmt(meta.ctxSize)));
  facts.push(fact('elapsed', elapsed()));
  mFacts.textContent = '';
  facts.forEach(function (f) { mFacts.appendChild(f); });
  mProv.textContent = meta.version ? meta.agent + ' ' + meta.version : meta.agent;
}
function setStatus(state, text) {
  mStatus.className = 'status' + (state ? ' ' + state : '');
  mStatusText.textContent = text;
}

function ingest(e) {
  if (!meta) return;
  meta.agent = e.agent || meta.agent;
  if (e.model) meta.model = e.model;
  if (!meta.firstTs) meta.firstTs = e.ts;
  meta.lastTs = e.ts;
  var f = e.frame || {};
  var p = f.params || {};

  if (f.method === 'session/update' && p.update) {
    var u = p.update, k = u.sessionUpdate;
    if (k === 'agent_message_chunk' && u.content && u.content.type === 'text') stream('msg', u.content.text);
    else if (k === 'agent_thought_chunk' && u.content && u.content.type === 'text') stream('think', u.content.text);
    else if (k === 'tool_call') chip('', 'tool', u.title || u.kind || u.toolCallId || 'tool');
    else if (k === 'usage_update') { if (u.used !== undefined) meta.ctxUsed = u.used; if (u.size) meta.ctxSize = u.size; }
  } else if (f.method === 'session/prompt' && e.dir === 'out') {
    closeStreams();
    append(el('div', 'turn', 'prompt · ' + (e.label || '')));
  } else if (f.method === 'session/set_config_option' && e.dir === 'out') {
    if (p.configId === 'model' && p.value) meta.model = p.value;
    if (p.configId === 'mode' && p.value) meta.mode = p.value;
  } else if (f.method === 'session/set_mode' && e.dir === 'out' && p.modeId) {
    meta.mode = p.modeId;
  } else if (f.method === 'session/request_permission' && p.toolCall) {
    chip('ask', 'ask', p.toolCall.kind || p.toolCall.title || 'tool');
  } else if (e.dir === 'out' && f.result && f.result.outcome) {
    var oc = f.result.outcome.outcome;
    if (oc === 'selected') chip('ok', 'allow', f.result.outcome.optionId);
    else chip('bad', 'deny', 'cancelled');
  } else if (e.dir === 'in' && f.id === 1 && f.result && f.result.agentInfo) {
    meta.version = f.result.agentInfo.version || '';
  } else if (e.dir === 'in' && f.result && f.result.stopReason) {
    if (f.result.usage) { meta.inTok = f.result.usage.inputTokens || meta.inTok; meta.outTok = f.result.usage.outputTokens || meta.outTok; }
    meta.live = false;
    chip('end', 'done', f.result.stopReason);
    setStatus('done', 'done · ' + f.result.stopReason);
  }
  renderMeta();
}

function open(runId, sessionId, label) {
  if (es) es.close();
  if (tick) clearInterval(tick);
  document.querySelectorAll('.session.active').forEach(function (b) { b.classList.remove('active'); });
  var btn = document.querySelector('[data-key="' + runId + '/' + sessionId + '"]');
  if (btn) btn.classList.add('active');
  active = runId + '/' + sessionId;
  meta = { agent: '', model: '', mode: '', version: '', firstTs: 0, lastTs: 0, inTok: 0, outTok: 0, ctxUsed: 0, ctxSize: 0, live: true };
  logEl.textContent = '';
  closeStreams();
  metaEl.hidden = false;
  mRole.textContent = label;
  mProv.textContent = '';
  setStatus('', 'connecting…');
  renderMeta();
  tick = setInterval(function () { if (meta && meta.live) renderMeta(); }, 1000);
  es = new EventSource(withToken('/api/runs/' + runId + '/sessions/' + sessionId + '/stream'));
  es.onopen = function () { if (meta.live) setStatus('live', 'live'); };
  es.onerror = function () { if (meta.live) setStatus('', 'reconnecting…'); };
  es.onmessage = function (m) { try { ingest(JSON.parse(m.data)); } catch (err) {} };
}

logEl.addEventListener('scroll', function () { jumpEl.classList.toggle('show', !atBottom()); });
jumpEl.addEventListener('click', function () { logEl.scrollTop = logEl.scrollHeight; jumpEl.classList.remove('show'); });

var lastRuns = '';
function refreshRuns() {
  fetch(withToken('/api/runs')).then(function (r) { return r.text(); }).then(function (text) {
    connEl.textContent = '';
    if (text === lastRuns) return; // unchanged: keep the DOM (and clicks) stable
    lastRuns = text;
    var runs = JSON.parse(text);
    connEl.textContent = runs.length + (runs.length === 1 ? ' run' : ' runs');
    runsEl.textContent = '';
    runs.forEach(function (run) {
      var box = el('div', 'run');
      box.appendChild(el('div', 'run-id', run.runId));
      run.sessions.forEach(function (session) {
        var key = run.runId + '/' + session;
        var b = el('button', 'session');
        b.dataset.key = key;
        b.appendChild(el('span', 'sdot'));
        b.appendChild(document.createTextNode(session));
        if (active === key) b.classList.add('active');
        b.onclick = function () { open(run.runId, session, session); };
        box.appendChild(b);
      });
      runsEl.appendChild(box);
    });
  }).catch(function () { connEl.textContent = 'offline'; });
}
refreshRuns();
setInterval(refreshRuns, 4000);
</script>
</body>
</html>
`;
