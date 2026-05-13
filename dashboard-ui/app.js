// GSB Intelligence Dashboard — Client
const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? `${location.protocol}//${location.hostname}:8080`
  : `${location.protocol}//${location.host}`;
const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

// ── State ─────────────────────────────────────────────────────────────────────
let latestBrief  = null;
let jobCount     = 0;
let ws           = null;
let currentThread = '';
let acpReady     = false;
let workers      = [];

// ── Auth state ────────────────────────────────────────────────────────────────
let operatorToken = sessionStorage.getItem('gsb_operator_token') || null;
let isOperator = false;
let passwordConfigured = false;

async function checkAuth() {
  // Check if password is configured on the server
  try {
    const statusRes = await fetch(`${API_BASE}/api/auth/status`);
    const statusData = await statusRes.json();
    passwordConfigured = statusData.passwordConfigured;
  } catch (_) {}

  if (!passwordConfigured) {
    // No password set — operator features simply disabled, no login shown
    setPublicMode(false);
    return;
  }

  if (!operatorToken) { setPublicMode(true); return; }

  // Verify token is still valid
  try {
    const res = await fetch(`${API_BASE}/api/auth/verify`, {
      headers: { 'x-gsb-token': operatorToken }
    });
    if (res.ok) {
      isOperator = true;
      setOperatorMode();
    } else {
      operatorToken = null;
      sessionStorage.removeItem('gsb_operator_token');
      setPublicMode(true);
    }
  } catch (_) {
    setPublicMode(true);
  }
}

function setPublicMode(showLogin) {
  isOperator = false;
  // CEO command bar: instant queries only in public mode
  document.getElementById('cmd-input').placeholder =
    'Ask about any token, wallet, or market trend — e.g. "what\'s trending on Base?"';
  // Show/hide operator controls
  document.getElementById('operator-badge').classList.add('hidden');
  if (showLogin) {
    document.getElementById('operator-login-btn').classList.remove('hidden');
  } else {
    document.getElementById('operator-login-btn').classList.add('hidden');
  }
  // Lock Fire Job and Skills tabs
  document.getElementById('fire-lock').classList.remove('hidden');
  document.getElementById('skills-lock').classList.remove('hidden');
  // Show hire CTA
  document.getElementById('hire-cta').classList.remove('hidden');
  // Enable Send button for instant queries (public can still ask)
  document.getElementById('cmd-send').disabled = false;
  document.getElementById('cmd-input').disabled = false;
  document.getElementById('cmd-send').textContent = 'Ask';
}

function setOperatorMode() {
  isOperator = true;
  document.getElementById('operator-badge').classList.remove('hidden');
  document.getElementById('operator-login-btn').classList.add('hidden');
  document.getElementById('fire-lock').classList.add('hidden');
  document.getElementById('skills-lock').classList.add('hidden');
  document.getElementById('hire-cta').classList.add('hidden');
  document.getElementById('cmd-send').textContent = 'Send';
  document.getElementById('cmd-input').placeholder =
    'Tell the agents what to do — e.g. "analyze $GSB token and write a thread"';
}

function authHeaders(headers) {
  if (operatorToken) headers['x-gsb-token'] = operatorToken;
  return headers;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async function init() {
  await loadWorkers();
  await checkAuth();
  connectWS();
})();

// ── Load workers from API ─────────────────────────────────────────────────────
async function loadWorkers() {
  try {
    const r = await fetch(`${API_BASE}/api/workers`);
    workers = await r.json();
    populateWorkerSelect();
  } catch (_) {}
}

function populateWorkerSelect() {
  const sel = document.getElementById('fire-worker');
  sel.innerHTML = '';
  workers.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.name;
    opt.textContent = `${w.name} — $${w.price} USDC`;
    sel.appendChild(opt);
  });
  updateDefaultReq();
}

function updateDefaultReq() {
  const sel   = document.getElementById('fire-worker');
  const ta    = document.getElementById('fire-requirement');
  const w     = workers.find(x => x.name === sel.value);
  if (w && !ta.dataset.edited) ta.value = w.defaultReq;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  ws = new WebSocket(`${WS_BASE}/ws`);
  ws.onopen    = () => { setWsStatus(true); fetchState(); };
  ws.onmessage = e  => { try { handle(JSON.parse(e.data)); } catch(_){} };
  ws.onclose   = ()  => { setWsStatus(false); setTimeout(connectWS, 3000); };
  ws.onerror   = ()  => setWsStatus(false);
}

function handle(msg) {
  if      (msg.type === 'brief')         { latestBrief = msg.data; renderBrief(msg.data); renderBriefInCmd(msg.data); }
  else if (msg.type === 'history')       renderHistory(msg.data);
  else if (msg.type === 'job-event')     appendJobEvent(msg.data);
  else if (msg.type === 'acp_status')    setAcpStatus(msg.data);
  else if (msg.type === 'cmd-status')    appendCmdStatus(msg.data);
  else if (msg.type === 'swarm-status')  updateSwarmStatus(msg.data);
  else if (msg.type === 'cmd-synthesis') renderCmdSynthesis(msg.data);
  else if (msg.type === 'skills-updated') loadSkillRegistry();
}

async function fetchState() {
  try {
    const r    = await fetch(`${API_BASE}/api/state`);
    const data = await r.json();
    setAcpStatus({ ready: data.acpReady });
    if (data.brief)           renderBrief(data.brief);
    if (data.history?.length) renderHistory(data.history);
    fetchSwarmStatus();
  } catch (_) {}
}

// ── Status indicators ─────────────────────────────────────────────────────────
function setWsStatus(ok) {
  document.getElementById('ws-dot').className    = 'dot ' + (ok ? 'connected' : 'error');
  document.getElementById('ws-status').textContent = ok ? 'Live' : 'Disconnected';
}

function setAcpStatus(data) {
  acpReady = !!data.ready;
  const dot   = document.getElementById('acp-dot');
  const label = document.getElementById('acp-status');
  const btn   = document.getElementById('fire-btn');
  dot.className   = 'dot ' + (acpReady ? 'connected' : 'error');
  label.textContent = acpReady ? 'CEO wallet ready' : (data.error ? 'Wallet error' : 'Initializing…');
  btn.disabled    = false;  // always enabled — uses direct mode if ACP not ready
  btn.textContent = acpReady ? 'Fire Job →' : 'Fire Job (Direct) →';
  // In public mode, CEO command bar stays enabled for instant queries regardless of ACP
  // Only disable if ACP is not ready AND user is operator
  if (isOperator) {
    document.getElementById('cmd-send').disabled = !acpReady;
    document.getElementById('cmd-input').disabled = !acpReady;
    if (!acpReady) {
      document.getElementById('cmd-input').placeholder = 'Waiting for CEO wallet…';
    }
  }
  // Public mode: cmd bar always enabled for instant queries — placeholder set by setPublicMode
}

// ── Render Brief ──────────────────────────────────────────────────────────────
function renderBrief(brief) {
  const r  = brief.results || {};
  const ts = brief.ts ? new Date(brief.ts).toLocaleTimeString() : '—';
  setText('brief-ts', ts);
  setText('last-update', 'Updated ' + ts);

  document.getElementById('brief-empty').classList.add('hidden');
  document.getElementById('brief-grid').classList.remove('hidden');

  if (r.token_analysis) renderToken(r.token_analysis);
  if (r.wallet_profile) renderWallet(r.wallet_profile);
  if (r.alpha_signals)  renderAlpha(r.alpha_signals);
  if (r.thread)         renderThread(r.thread);
  updateKPIs(r);

  // Render CEO synthesis panel if available
  if (brief.ceoSynthesis) renderCeoSynthesis(brief.ceoSynthesis);
}

function renderToken(d) {
  if (d.error) return;
  const change = d.price?.change_24h;
  const changeStr = change != null ? `${change > 0 ? '+' : ''}${change}%` : '—';

  setText('brief-token-name', `${d.token?.name} (${d.token?.symbol})`);
  setText('brief-price', d.price?.usd ? `$${parseFloat(d.price.usd).toFixed(6)}` : '—');

  const chEl = document.getElementById('brief-change');
  chEl.textContent = changeStr;
  chEl.className = 'stat-val mono ' + (change > 0 ? 'up' : change < 0 ? 'down' : '');

  setText('brief-liq',  d.liquidity_usd ? '$' + Number(d.liquidity_usd).toLocaleString() : '—');
  setText('brief-vol',  d.volume_24h    ? '$' + Number(d.volume_24h).toLocaleString()    : '—');
  setText('brief-mcap', d.market_cap    ? '$' + Number(d.market_cap).toLocaleString()    : '—');

  const vEl = document.getElementById('brief-verdict');
  vEl.textContent = d.gsb_verdict || '';
  vEl.className   = 'verdict-row ' + verdictClass(d.gsb_verdict || '');

  const dexLink = document.getElementById('brief-dex-link');
  if (d.dexscreener_url) { dexLink.href = d.dexscreener_url; dexLink.style.display = ''; }

  document.getElementById('token-detail').innerHTML = `<pre>${esc(JSON.stringify(d, null, 2))}</pre>`;
}

function renderWallet(d) {
  if (d.error) return;
  setText('brief-wallet-addr',  d.wallet || '—');
  setText('brief-tx-count',     d.transaction_count?.toLocaleString() || '—');
  setText('brief-wallet-class', d.classification || '—');

  const wrap = document.getElementById('brief-recent-txs');
  wrap.innerHTML = '';
  (d.recent_transactions || []).slice(0, 3).forEach(tx => {
    const row = document.createElement('div');
    row.className = 'tx-row';
    row.innerHTML = `<span>${tx.hash?.slice(0,14)}…</span><span>${tx.value_eth} ETH</span><span>${tx.age_days}d ago</span>`;
    wrap.appendChild(row);
  });

  const link = document.getElementById('brief-basescan-link');
  if (d.basescan_url) { link.href = d.basescan_url; link.style.display = ''; }

  document.getElementById('wallet-detail').innerHTML = `<pre>${esc(JSON.stringify(d, null, 2))}</pre>`;
}

function renderAlpha(d) {
  if (d.error) return;
  setText('brief-gsb-signal', d.gsb_signal || '');
  setText('brief-signal-badge', (d.gsb_signal || '').split('—')[0].trim().slice(0, 28));

  const wrap = document.getElementById('brief-gainers');
  if (d.top_gainers_base?.length) {
    const rows = d.top_gainers_base.map(g => `<tr>
      <td><strong>${g.symbol || '—'}</strong></td>
      <td>${g.name || '—'}</td>
      <td class="gain">${g.change_24h || '—'}</td>
      <td>$${parseFloat(g.price_usd || 0).toFixed(6)}</td>
      <td>${g.liquidity || '—'}</td>
      <td>${g.volume_24h || '—'}</td>
      <td><a href="${g.dexscreener || '#'}" target="_blank" rel="noopener">↗</a></td>
    </tr>`).join('');
    wrap.innerHTML = `<table><thead><tr><th>Symbol</th><th>Name</th><th>24h</th><th>Price</th><th>Liq</th><th>Vol 24h</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  document.getElementById('alpha-detail').innerHTML = `<pre>${esc(JSON.stringify(d, null, 2))}</pre>`;
}

function renderThread(d) {
  if (!d?.thread) return;
  currentThread = d.thread;
  document.getElementById('copy-thread-btn').disabled = false;

  const tweets = d.thread.split('\n\n').filter(Boolean).map(line => {
    const num  = (line.match(/^(\d+)\//) || [])[1] || '';
    const text = line.replace(/^\d+\/\s*/, '');
    return `<div class="tweet">
      <span class="tweet-num">${num || '#'}</span>
      <span class="tweet-text">${esc(text)}</span>
    </div>`;
  }).join('');

  document.getElementById('thread-panel').innerHTML = `<div class="tweet-list">${tweets}</div>`;
}

// ── KPIs ──────────────────────────────────────────────────────────────────────
function updateKPIs(r) {
  const v = r.token_analysis?.gsb_verdict;
  if (v) {
    const el = document.getElementById('kpi-verdict-val');
    el.textContent = v.split('—')[0].trim();
    el.className   = 'kpi-value ' + verdictClass(v);
  }
  if (r.wallet_profile?.classification)
    setText('kpi-wallet-val', r.wallet_profile.classification.split('—')[0].trim());
  if (r.alpha_signals?.gsb_signal)
    setText('kpi-signal-val', r.alpha_signals.gsb_signal.split('.')[0].trim().slice(0, 32));
}

// ── Job history ───────────────────────────────────────────────────────────────
function renderHistory(events) {
  const tbody = document.getElementById('jobs-tbody');
  tbody.innerHTML = '';
  events.forEach(ev => insertJobRow(ev));
  jobCount = events.length;
  refreshJobCount();
}

function appendJobEvent(ev) {
  insertJobRow(ev, true);
  jobCount++;
  refreshJobCount();
  setText('kpi-jobs-val', String(jobCount));
}

function insertJobRow(ev, prepend = false) {
  const tbody = document.getElementById('jobs-tbody');
  if (tbody.querySelector('[colspan]')) tbody.innerHTML = '';
  const tr   = document.createElement('tr');
  const time = new Date(ev.ts).toLocaleTimeString();
  tr.innerHTML = `
    <td>${time}</td>
    <td class="mono">${ev.jobId || '—'}</td>
    <td>${ev.worker || '—'}</td>
    <td class="mono">${ev.event || '—'}</td>
    <td><span class="status-pill ${(ev.status || '').toLowerCase()}">${ev.status || '—'}</span></td>`;
  prepend ? tbody.insertBefore(tr, tbody.firstChild) : tbody.appendChild(tr);
}

function refreshJobCount() {
  setText('job-count', `${jobCount} job${jobCount !== 1 ? 's' : ''}`);
  setText('kpi-jobs-val', String(jobCount));
}

// ── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    const sec = item.dataset.section;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(`section-${sec}`)?.classList.add('active');
    if (sec === 'skills') loadSkillRegistry();
  });
});

// ── Copy thread ───────────────────────────────────────────────────────────────
document.getElementById('copy-thread-btn').addEventListener('click', () => {
  if (!currentThread) return;
  navigator.clipboard.writeText(currentThread).then(() => {
    const btn = document.getElementById('copy-thread-btn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 2000);
  }).catch(() => {
    const ta = Object.assign(document.createElement('textarea'),
      { value: currentThread, style: 'position:fixed;opacity:0' });
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  });
});

// ── Worker select → auto-fill default requirement ────────────────────────────
document.getElementById('fire-worker').addEventListener('change', () => {
  document.getElementById('fire-requirement').dataset.edited = '';
  updateDefaultReq();
});

document.getElementById('fire-requirement').addEventListener('input', function() {
  this.dataset.edited = '1';
});

// ── Fire Job ──────────────────────────────────────────────────────────────────
document.getElementById('fire-btn').addEventListener('click', async () => {
  // Fire in direct mode if ACP not ready — backend handles it

  const workerName  = document.getElementById('fire-worker').value;
  const requirement = document.getElementById('fire-requirement').value.trim();
  const count       = parseInt(document.getElementById('fire-count').value) || 1;

  if (!requirement) { showFire('Please enter a requirement.', 'err'); return; }

  const btn = document.getElementById('fire-btn');
  btn.disabled    = true;
  btn.textContent = `Firing ${count} job${count > 1 ? 's' : ''}…`;

  let fired = 0, errors = 0;
  for (let i = 0; i < count; i++) {
    try {
      const r = await fetch(`${API_BASE}/api/fire-job`, {
        method:  'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify({ worker: workerName, requirement, direct: true }),
      });
      const data = await r.json();
      if (data.ok) { fired++; showFire(`Job ${fired}/${count} fired → ${data.jobId}`, 'ok'); }
      else         { errors++; showFire(data.error, 'err'); break; }
    } catch (err) {
      errors++;
      showFire('Network error: ' + err.message, 'err');
      break;
    }
    if (i < count - 1) await new Promise(r => setTimeout(r, 3000)); // space them out
  }

  btn.disabled    = false;
  btn.textContent = 'Fire Job →';
  if (fired > 0 && errors === 0) showFire(`✓ ${fired} job${fired > 1 ? 's' : ''} fired successfully`, 'ok');
});

function showFire(msg, type) {
  const el = document.getElementById('fire-feedback');
  el.textContent = msg;
  el.className   = `fire-feedback ${type}`;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 6000);
}

// ── Theme toggle ──────────────────────────────────────────────────────────────
let theme = 'dark';
document.getElementById('theme-toggle').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-toggle').innerHTML = theme === 'dark' ? sunIcon() : moonIcon();
});

function sunIcon()  { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`; }
function moonIcon() { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`; }

// ── Helpers ───────────────────────────────────────────────────────────────────
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function verdictClass(v) {
  const l = v.toLowerCase();
  if (l.includes('bullish')) return 'bullish';
  if (l.includes('risky') || l.includes('bear')) return 'bearish';
  if (l.includes('watch') || l.includes('neutral')) return 'watch';
  return '';
}

// ── Preset buttons ────────────────────────────────────────────────────────────
document.querySelectorAll('.btn-preset').forEach(btn => {
  btn.addEventListener('click', async () => {
    const workerName = btn.dataset.worker;
    const requirement = btn.dataset.req;
    if (!workerName || !requirement) return;
    btn.disabled = true;
    btn.textContent = 'Firing…';
    try {
      const r = await fetch(`${API_BASE}/api/fire-job`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ worker: workerName, requirement, direct: true }),
      });
      const data = await r.json();
      if (data.ok) {
        showFire(`✓ ${workerName.split(' ').pop()} job fired → ${data.jobId}`, 'ok');
        document.getElementById('section-fire').scrollIntoView({ behavior: 'smooth' });
      } else {
        showFire(data.error || 'Fire failed', 'err');
      }
    } catch (e) {
      showFire('Network error: ' + e.message, 'err');
    }
    btn.disabled = false;
    btn.textContent = btn.dataset.worker.split(' ').pop();
  });
});

// ── Graduation buttons ────────────────────────────────────────────────────────
document.querySelectorAll('.btn-grad').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    const workerName = btn.dataset.worker;
    const count      = parseInt(btn.dataset.count) || 1;
    const worker     = workers.find(w => w.name === workerName);
    if (!worker) return;

    btn.disabled    = true;
    btn.textContent = 'Firing…';

    let fired = 0;
    for (let i = 0; i < count; i++) {
      try {
        const r = await fetch(`${API_BASE}/api/fire-job`, {
          method:  'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body:    JSON.stringify({ worker: workerName, requirement: worker.defaultReq, direct: true }),
        });
        const data = await r.json();
        if (data.ok) fired++;
        else break;
      } catch (_) { break; }
      if (i < count - 1) await new Promise(r => setTimeout(r, 3000));
    }

    showFire(`Fired ${fired}/${count} graduation jobs for ${workerName}`, fired === count ? 'ok' : 'err');
    btn.textContent = fired === count ? 'Fired ✓' : 'Retry';
    btn.disabled    = false;

    // Navigate to jobs tab to watch
    document.querySelector('[data-section="jobs"]').click();
  });
});

// ── CEO Command Line ──────────────────────────────────────────────────────────
const cmdInput   = document.getElementById('cmd-input');
const cmdSend    = document.getElementById('cmd-send');
const cmdHistory = document.getElementById('cmd-history');

// Send on Enter key
cmdInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendCommand();
  }
});

cmdSend.addEventListener('click', sendCommand);

async function sendCommand() {
  const text = cmdInput.value.trim();
  if (!text) return;
  // In public mode, allow sending for instant queries even without ACP
  if (!isOperator && !text.trim()) return;

  // Echo user command into history
  addCmdMsg('user', `> ${text}`);
  cmdInput.value = '';

  // Disable while firing
  cmdSend.disabled = true;
  cmdInput.disabled = true;

  try {
    const headers = authHeaders({ 'Content-Type': 'application/json' });
    const r = await fetch(`${API_BASE}/api/command`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ command: text }),
    });
    const data = await r.json();
    if (!r.ok) {
      addCmdMsg('error', data.error || 'Server error');
    }
    // Real-time status updates come through WebSocket cmd-status messages
  } catch (err) {
    addCmdMsg('error', 'Network error: ' + err.message);
  } finally {
    cmdSend.disabled = false;
    cmdInput.disabled = false;
    cmdInput.focus();
  }
}

// Handle incoming cmd-status WebSocket messages
function appendCmdStatus(data) {
  const type = data.type || 'info';

  if (type === 'instant') {
    // Fast lane: render multi-line intel block
    addCmdBlock('instant', data.message);
    return;
  }
  if (type === 'hint') {
    addCmdMsg('hint', data.message);
    return;
  }

  addCmdMsg(type, data.message || JSON.stringify(data));

  if (type === 'done') {
    const jobsNav = document.querySelector('[data-section="jobs"]');
    if (jobsNav) {
      jobsNav.style.color = 'var(--accent)';
      setTimeout(() => jobsNav.style.color = '', 3000);
    }
  }
}

// Render a brief result snippet into the command history when an agent delivers
function renderBriefInCmd(brief) {
  const r = brief?.results || {};
  const lines = [];

  if (r.token_analysis && !r.token_analysis.error) {
    const t = r.token_analysis;
    const sym   = t.token?.symbol || 'TOKEN';
    const price = t.price?.usd ? `$${parseFloat(t.price.usd).toFixed(6)}` : null;
    const chg   = t.price?.change_24h;
    const chgStr = chg != null ? ` ${chg > 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}%` : '';
    if (price) lines.push(`Token: ${sym} ${price}${chgStr}  ${t.gsb_verdict || ''}`);
  }
  if (r.alpha_signals && !r.alpha_signals.error) {
    const a = r.alpha_signals;
    if (a.gsb_signal) lines.push(`Alpha: ${a.gsb_signal}`);
  }
  if (r.thread && r.thread.thread) {
    lines.push(`Thread: Ready — check the Thread tab`);
  }
  if (r.wallet_profile && !r.wallet_profile.error) {
    const w = r.wallet_profile;
    lines.push(`Wallet: ${w.classification || 'profiled'} — ${w.transaction_count || '?'} txs`);
  }

  if (lines.length) {
    // Show raw worker outputs in a collapsible section
    const wrapper = document.createElement('div');
    wrapper.className = 'cmd-raw-toggle';
    const toggle = document.createElement('button');
    toggle.className = 'raw-toggle-btn';
    toggle.textContent = 'View Raw Worker Data';
    const rawContent = document.createElement('div');
    rawContent.className = 'raw-content hidden';
    const pre = document.createElement('pre');
    pre.className = 'block-body';
    pre.textContent = lines.join('\n');
    rawContent.appendChild(pre);
    toggle.addEventListener('click', () => {
      rawContent.classList.toggle('hidden');
      toggle.textContent = rawContent.classList.contains('hidden') ? 'View Raw Worker Data' : 'Hide Raw Worker Data';
    });
    wrapper.appendChild(toggle);
    wrapper.appendChild(rawContent);
    cmdHistory.appendChild(wrapper);
    cmdHistory.scrollTop = cmdHistory.scrollHeight;
  }
}

function addCmdMsg(type, text) {
  const el = document.createElement('div');
  el.className = `cmd-msg ${type}`;

  const tag  = document.createElement('span');
  tag.className = 'msg-tag';

  const body = document.createElement('span');
  body.className = 'msg-body';
  body.textContent = text;

  const tagMap = {
    user:   'YOU',
    ack:    'CEO',
    firing: 'HIRING',
    fired:  'HIRED',
    done:   'DONE',
    error:  'ERROR',
    info:   'INFO',
    hint:   'TIP',
  };
  tag.textContent = tagMap[type] || type.toUpperCase();

  el.appendChild(tag);
  el.appendChild(body);
  cmdHistory.appendChild(el);
  cmdHistory.scrollTop = cmdHistory.scrollHeight;
}

// Multi-line block for instant intel and agent results
function addCmdBlock(type, text) {
  const el = document.createElement('div');
  el.className = `cmd-block ${type}`;

  const header = document.createElement('div');
  header.className = 'block-header';
  header.textContent = type === 'instant' ? '⚡ INSTANT INTEL' : '🤖 AGENT BRIEF';

  const body = document.createElement('pre');
  body.className = 'block-body';
  body.textContent = text;

  el.appendChild(header);
  el.appendChild(body);
  cmdHistory.appendChild(el);
  cmdHistory.scrollTop = cmdHistory.scrollHeight;
}

// ── Swarm Status ─────────────────────────────────────────────────────────────
function updateSwarmStatus(workers) {
  if (!Array.isArray(workers)) return;
  workers.forEach(w => {
    const el = document.querySelector(`.swarm-agent[data-agent="${w.name}"]`);
    if (!el) return;
    const dot = el.querySelector('.swarm-dot');
    if (!dot) return;
    dot.className = 'swarm-dot ' + (w.status || 'idle');
    // Update tooltip
    let tip = w.name;
    if (w.status === 'working' && w.currentJobId) tip += ` — Job ${w.currentJobId}`;
    else if (w.lastJobAt) tip += ` — Last: ${new Date(w.lastJobAt).toLocaleTimeString()}`;
    if (w.jobsCompleted > 0) tip += ` (${w.jobsCompleted} completed)`;
    el.title = tip;

    // Update sidebar nav worker dots
    const navDot = document.querySelector(`.nav-worker-dot[data-nav-worker="${w.name}"]`);
    if (navDot) navDot.className = 'nav-worker-dot ' + (w.status || 'idle');
  });
}

// Poll swarm status on connect
async function fetchSwarmStatus() {
  try {
    const r = await fetch(`${API_BASE}/api/swarm-status`);
    const data = await r.json();
    if (data.workers) updateSwarmStatus(data.workers);
  } catch (_) {}
}

// ── CEO Synthesis Panel (Brief section) ──────────────────────────────────────
function renderCeoSynthesis(synthesis) {
  if (!synthesis || !synthesis.summary) return;
  const panel = document.getElementById('ceo-synthesis-panel');
  panel.classList.remove('hidden');

  if (synthesis.query) {
    const queryEl = document.getElementById('ceo-synth-query');
    queryEl.textContent = `Query: ${synthesis.query}`;
    queryEl.classList.remove('hidden');
  }

  // AI badge
  const titleEl = document.getElementById('ceo-synth-title');
  if (titleEl) {
    const existingBadge = titleEl.querySelector('.ai-badge');
    if (synthesis.aiPowered && !existingBadge) {
      const badge = document.createElement('span');
      badge.className = 'ai-badge';
      badge.textContent = 'Claude';
      titleEl.appendChild(badge);
    } else if (!synthesis.aiPowered && existingBadge) {
      existingBadge.remove();
    }
  }

  document.getElementById('ceo-synth-summary').textContent = synthesis.summary;

  const list = document.getElementById('ceo-synth-findings-list');
  list.innerHTML = '';
  (synthesis.keyFindings || []).forEach(f => {
    const li = document.createElement('li');
    li.textContent = f;
    list.appendChild(li);
  });

  document.getElementById('ceo-synth-recommendation').textContent = synthesis.recommendation || '';

  const meta = document.getElementById('ceo-synth-meta');
  const workers = synthesis.workers ? synthesis.workers.join(', ') : `${synthesis.workerCount} workers`;
  const ts = synthesis.timestamp ? new Date(synthesis.timestamp).toLocaleTimeString() : '';
  meta.textContent = `Workers: ${workers} | ${ts}`;

  document.getElementById('ceo-synth-ts').textContent = ts;
}

// ── CEO Synthesis in Command History ─────────────────────────────────────────
function renderCmdSynthesis(synthesis) {
  if (!synthesis || !synthesis.summary) return;

  const el = document.createElement('div');
  el.className = 'cmd-block synthesis';

  const header = document.createElement('div');
  header.className = 'block-header';
  header.innerHTML = '&#9670; CEO INTELLIGENCE BRIEF' + (synthesis.aiPowered ? ' <span class="ai-badge">Claude</span>' : '');

  const body = document.createElement('div');
  body.className = 'block-body synth-body';

  const summary = document.createElement('p');
  summary.className = 'synth-summary';
  summary.textContent = synthesis.summary;
  body.appendChild(summary);

  if (synthesis.keyFindings && synthesis.keyFindings.length) {
    const findTitle = document.createElement('div');
    findTitle.className = 'synth-section-title';
    findTitle.textContent = 'Key Findings';
    body.appendChild(findTitle);

    const ul = document.createElement('ul');
    ul.className = 'synth-findings';
    synthesis.keyFindings.forEach(f => {
      const li = document.createElement('li');
      li.textContent = f;
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }

  if (synthesis.recommendation) {
    const recTitle = document.createElement('div');
    recTitle.className = 'synth-section-title';
    recTitle.textContent = 'Recommendation';
    body.appendChild(recTitle);
    const rec = document.createElement('p');
    rec.className = 'synth-recommendation';
    rec.textContent = synthesis.recommendation;
    body.appendChild(rec);
  }

  el.appendChild(header);
  el.appendChild(body);
  cmdHistory.appendChild(el);
  cmdHistory.scrollTop = cmdHistory.scrollHeight;
}

// Suggested commands on focus (shown once per session)
let hintShown = false;
cmdInput.addEventListener('focus', () => {
  if (!hintShown) {
    hintShown = true;
    if (isOperator) {
      addCmdMsg('info', 'Try: "analyze $GSB token" · "profile wallet 0x…" · "scan for alpha" · "write a thread" · "run full brief"');
    } else {
      addCmdMsg('info', 'Try: "price of $ETH" · "what\'s trending on Base?" · "market sentiment" · "check $SOL"');
    }
  }
});

// ── Skills Tab ──────────────────────────────────────────────────────────────
let currentSkillWorker = 'GSB Token Analyst';
let skillRegistry = {};

async function loadSkillRegistry() {
  try {
    const res = await fetch(`${API_BASE}/api/skills`);
    skillRegistry = await res.json();
    renderSkillCards();
  } catch (e) {
    console.warn('Skills load failed:', e);
  }
}

function renderSkillCards() {
  const container = document.getElementById('skill-cards');
  if (!container) return;
  const skills = skillRegistry[currentSkillWorker] || [];

  if (!skills.length) {
    container.innerHTML = '<div class="empty-state"><p class="muted">No skills yet for this worker.</p></div>';
    return;
  }

  container.innerHTML = skills.map(skill => `
    <div class="skill-card">
      <div class="skill-card-head">
        <span class="skill-id mono">${esc(skill.skillId)}</span>
        <span class="skill-price mono">$${skill.price} USDC</span>
        <button class="skill-delete-btn" data-worker="${esc(currentSkillWorker)}" data-skill="${esc(skill.skillId)}">×</button>
      </div>
      <div class="skill-desc">${esc(skill.description)}</div>
      <div class="skill-instruction muted">${esc(skill.instruction)}</div>
      ${skill.params?.length ? `<div class="skill-params">params: ${skill.params.map(p => `<code>{${esc(p)}}</code>`).join(', ')}</div>` : ''}
      <button class="btn-preset skill-fire-btn" data-worker="${esc(currentSkillWorker)}" data-skill="${esc(skill.skillId)}" data-params='${JSON.stringify(skill.params||[])}'>
        Fire this skill
      </button>
    </div>
  `).join('');

  // Delete handlers
  container.querySelectorAll('.skill-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete skill ${btn.dataset.skill}?`)) return;
      await fetch(`${API_BASE}/api/skills/${encodeURIComponent(btn.dataset.worker)}/${btn.dataset.skill}`, { method: 'DELETE', headers: authHeaders({}) });
      await loadSkillRegistry();
    });
  });

  // Fire handlers
  container.querySelectorAll('.skill-fire-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const params = JSON.parse(btn.dataset.params || '[]');
      const paramVals = {};
      for (const p of params) {
        const val = prompt(`Enter value for {${p}}:`);
        if (!val) return;
        paramVals[p] = val;
      }
      const requirement = JSON.stringify({ skillId: btn.dataset.skill, params: paramVals });
      document.getElementById('fire-worker').value = btn.dataset.worker;
      document.getElementById('fire-requirement').value = requirement;
      document.getElementById('fire-requirement').dataset.edited = '1';
      document.querySelector('[data-section="fire"]').click();
    });
  });
}

// Worker tab switching
document.querySelectorAll('.skill-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.skill-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentSkillWorker = tab.dataset.worker;
    renderSkillCards();
  });
});

// Add skill form
document.getElementById('add-skill-btn')?.addEventListener('click', () => {
  document.getElementById('skill-form').classList.remove('hidden');
});
document.getElementById('sf-cancel')?.addEventListener('click', () => {
  document.getElementById('skill-form').classList.add('hidden');
});
document.getElementById('sf-save')?.addEventListener('click', async () => {
  const workerName = document.getElementById('sf-worker').value;
  const skillId = document.getElementById('sf-id').value.trim().replace(/\s+/g, '_');
  const description = document.getElementById('sf-desc').value.trim();
  const instruction = document.getElementById('sf-instruction').value.trim();
  const price = parseFloat(document.getElementById('sf-price').value) || 0.10;
  const params = document.getElementById('sf-params').value.split(',').map(p => p.trim()).filter(Boolean);

  if (!skillId || !instruction) {
    alert('Skill ID and Instruction are required');
    return;
  }

  const res = await fetch(`${API_BASE}/api/skills`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ workerName, skillId, description, instruction, params, price })
  });

  if (res.ok) {
    document.getElementById('skill-form').classList.add('hidden');
    // Reset form
    document.getElementById('sf-id').value = '';
    document.getElementById('sf-desc').value = '';
    document.getElementById('sf-instruction').value = '';
    document.getElementById('sf-params').value = '';
    document.getElementById('sf-price').value = '0.10';
    await loadSkillRegistry();
  }
});

/* ══════════════════ THROW ADMIN ══════════════════════════════════════════ */
const THROW_WATCHER = 'https://throw-watcher-production.up.railway.app';

async function loadThrowData() {
  try {
    const [statusRes, throwsRes, campaignsRes] = await Promise.all([
      fetch(`${API_BASE}/api/throw/status`),
      fetch(`${API_BASE}/api/throw/throws`),
      fetch(`${API_BASE}/api/throw/campaigns`),
    ]);

    // KPIs
    if (statusRes.ok) {
      const s = await statusRes.json();
      setText('tw-throws-today', s.throwsToday ?? '—');
      setText('tw-vol-today',    s.volumeToday != null ? '$' + s.volumeToday.toFixed(2) : '—');
      setText('tw-throws-total', s.throwsTotal ?? '—');
      setText('tw-vol-total',    s.volumeTotal != null ? '$' + s.volumeTotal.toFixed(2) : '—');
      setText('tw-wallets',      s.registeredWallets ?? '—');
      const statusEl = document.getElementById('tw-status');
      if (statusEl) {
        statusEl.textContent = s.watcherStatus ?? '—';
        statusEl.style.color = s.watcherStatus === 'ok' ? 'var(--accent)' : 'var(--gold)';
      }
    }

    // Feed
    if (throwsRes.ok) {
      const throws = await throwsRes.json();
      renderThrowFeed(throws);
    }

    // Campaigns
    if (campaignsRes.ok) {
      const campaigns = await campaignsRes.json();
      renderCampaigns(campaigns);
    }
  } catch (e) {
    console.warn('[throw admin] loadThrowData error:', e.message);
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function renderThrowFeed(throws) {
  const tbody = document.getElementById('tw-feed-body');
  if (!tbody) return;
  if (!throws || !throws.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:20px">No throws yet</td></tr>';
    return;
  }
  tbody.innerHTML = throws.slice(0, 50).map(t => {
    const time = t.ts ? new Date(t.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    const from = t.fromHandle || (t.from ? t.from.slice(0,6) + '…' + t.from.slice(-4) : '—');
    const to   = t.toHandle   || (t.to   ? t.to.slice(0,6)   + '…' + t.to.slice(-4)   : '—');
    const amt  = t.amount != null ? '$' + parseFloat(t.amount).toFixed(2) : '—';
    const token = t.token || '—';
    const txLink = t.txHash
      ? `<a class="tw-tx-link" href="https://explorer.tempo.fan/tx/${t.txHash}" target="_blank" rel="noopener">${t.txHash.slice(0,8)}…</a>`
      : '—';
    return `<tr>
      <td>${time}</td>
      <td class="tw-addr">${from}</td>
      <td class="tw-addr">${to}</td>
      <td class="tw-amount">${amt}</td>
      <td class="muted">${token}</td>
      <td>${txLink}</td>
    </tr>`;
  }).join('');
}

function renderCampaigns(campaigns) {
  const list = document.getElementById('tw-campaigns-list');
  if (!list) return;
  if (!campaigns || !campaigns.length) {
    list.innerHTML = '<div class="muted" style="padding:16px;text-align:center">No campaigns yet — create one above</div>';
    return;
  }
  list.innerHTML = campaigns.map(c => {
    const statusClass = c.status === 'active' ? 'green' : c.status === 'paused' ? 'gold' : 'red';
    const impressions = c.impressions || 0;
    const spend = impressions > 0 ? '$' + ((impressions / 1000) * (c.cpm || 0)).toFixed(2) : '$0.00';
    return `<div class="tw-campaign-card">
      <div class="tw-campaign-top">
        <span class="tw-campaign-name">${c.advertiser || '—'}</span>
        <span class="badge ${statusClass}">${c.status || 'draft'}</span>
      </div>
      <div class="tw-campaign-copy">"${c.copy || ''}"</div>
      <div class="tw-campaign-meta">
        <span>Budget: $${c.budget || 0}</span>
        <span>CPM: $${c.cpm || 0}</span>
        <span>Impr: ${impressions}</span>
        <span>Spend: ${spend}</span>
        <span>${c.startDate || ''} → ${c.endDate || ''}</span>
      </div>
      <div class="tw-campaign-actions">
        ${c.status === 'active'
          ? `<button class="btn-ghost-sm" onclick="toggleCampaign('${c.id}','paused')">Pause</button>`
          : `<button class="btn-ghost-sm" onclick="toggleCampaign('${c.id}','active')">Activate</button>`}
        <button class="btn-ghost-sm" style="color:var(--red)" onclick="deleteCampaign('${c.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

function openCampaignForm() {
  document.getElementById('tw-campaign-form').classList.remove('hidden');
  // Default dates
  const today = new Date().toISOString().slice(0,10);
  const future = new Date(Date.now() + 30*24*60*60*1000).toISOString().slice(0,10);
  document.getElementById('tw-adv-start').value = today;
  document.getElementById('tw-adv-end').value   = future;
}
function closeCampaignForm() {
  document.getElementById('tw-campaign-form').classList.add('hidden');
  hideCampaignMsg();
}
function showCampaignMsg(text, isErr) {
  const el = document.getElementById('tw-form-msg');
  if (!el) return;
  el.textContent = text;
  el.className = 'tw-form-msg ' + (isErr ? 'err' : 'ok');
}
function hideCampaignMsg() {
  const el = document.getElementById('tw-form-msg');
  if (el) el.className = 'tw-form-msg hidden';
}

async function submitCampaign() {
  const body = {
    advertiser: document.getElementById('tw-adv-name').value.trim(),
    budget:     parseFloat(document.getElementById('tw-adv-budget').value) || 0,
    cpm:        parseFloat(document.getElementById('tw-adv-cpm').value)    || 0,
    copy:       document.getElementById('tw-adv-copy').value.trim(),
    imageUrl:   document.getElementById('tw-adv-img').value.trim(),
    target:     document.getElementById('tw-adv-target').value,
    startDate:  document.getElementById('tw-adv-start').value,
    endDate:    document.getElementById('tw-adv-end').value,
    status:     'active',
  };
  if (!body.advertiser || !body.copy) { showCampaignMsg('Advertiser and copy required', true); return; }
  try {
    const res = await fetch(`${API_BASE}/api/throw/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-gsb-token': operatorToken || '' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    showCampaignMsg('Campaign saved ✓', false);
    setTimeout(() => { closeCampaignForm(); loadThrowData(); }, 1200);
  } catch (e) {
    showCampaignMsg('Error: ' + e.message, true);
  }
}

async function toggleCampaign(id, newStatus) {
  try {
    await fetch(`${API_BASE}/api/throw/campaigns/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-gsb-token': operatorToken || '' },
      body: JSON.stringify({ status: newStatus }),
    });
    loadThrowData();
  } catch (e) { console.warn(e); }
}

async function deleteCampaign(id) {
  if (!confirm('Delete this campaign?')) return;
  try {
    await fetch(`${API_BASE}/api/throw/campaigns/${id}`, {
      method: 'DELETE',
      headers: { 'x-gsb-token': operatorToken || '' },
    });
    loadThrowData();
  } catch (e) { console.warn(e); }
}

async function sendBroadcastPush() {
  const title = document.getElementById('tw-push-title').value.trim();
  const body  = document.getElementById('tw-push-body').value.trim();
  const msgEl = document.getElementById('tw-push-msg');
  if (!title || !body) {
    if (msgEl) { msgEl.textContent = 'Title and body required'; msgEl.className = 'tw-push-msg err'; }
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/throw/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-gsb-token': operatorToken || '' },
      body: JSON.stringify({ title, body }),
    });
    const data = await res.json();
    if (msgEl) {
      msgEl.textContent = res.ok ? `Sent to ${data.sent || 0} wallets ✓` : 'Error: ' + (data.error || res.status);
      msgEl.className = 'tw-push-msg ' + (res.ok ? 'ok' : 'err');
      setTimeout(() => { msgEl.className = 'tw-push-msg hidden'; }, 4000);
    }
  } catch (e) {
    if (msgEl) { msgEl.textContent = 'Error: ' + e.message; msgEl.className = 'tw-push-msg err'; }
  }
}

// Hook into section navigation
const _origNavTo = window._navTo;
document.addEventListener('DOMContentLoaded', () => {
  // Load throw data when throw tab is clicked
  document.querySelectorAll('.nav-item[data-section="throw"]').forEach(el => {
    el.addEventListener('click', () => setTimeout(loadThrowData, 100));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  APP TESTS — 5-agent UI testing dashboard
// ══════════════════════════════════════════════════════════════════════════════

const AT_WORKER_URL = window.AT_WORKER_URL || 'https://playwright-worker-production.up.railway.app';

const AT_APPS = [
  {
    id: 'throw',
    name: 'THROW',
    url: 'https://www.throw5onit.com',
    authType: 'wallet-inject',
    badge: 'MQTT + Wallet',
  },
  {
    id: 'voluntrack',
    name: 'VolunTrack',
    url: 'https://voluntrack-nexus.lovable.app',
    authType: 'e2e-switcher',
    badge: 'Supabase + E2E',
  },
  {
    id: 'passithere',
    name: 'PassItHere',
    url: 'https://passithere.com',
    authType: 'e2e-switcher',
    badge: 'Supabase + E2E',
  },
];

// Load last results from localStorage
function atGetResults(appId) {
  try { return JSON.parse(localStorage.getItem('at_results_' + appId) || 'null'); } catch(_) { return null; }
}
function atSaveResults(appId, result) {
  try { localStorage.setItem('at_results_' + appId, JSON.stringify(result)); } catch(_) {}
}

function renderAppTestsSection() {
  const registry = document.getElementById('apptests-registry');
  if (!registry) return;
  registry.innerHTML = '';

  AT_APPS.forEach(app => {
    const last = atGetResults(app.id);
    const card = document.createElement('div');
    card.className = 'at-app-card';
    card.innerHTML = `
      <div class="at-app-header">
        <div>
          <div class="at-app-name">${app.name}</div>
          <div class="at-app-url">${app.url}</div>
        </div>
        <div class="at-app-badge">${app.badge}</div>
      </div>
      <div class="at-btn-row">
        <button class="at-run-quick" onclick="runAppTest('${app.id}','quick')">▶ Quick</button>
        <button class="at-run-full"  onclick="runAppTest('${app.id}','full')">⚡ Full Suite</button>
      </div>
      ${last ? `<div class="at-last-run">Last run: ${new Date(last.finishedAt).toLocaleString()} — ${last.summary?.passed}/${last.summary?.total} passed</div>` : ''}
      <div id="at-result-${app.id}"></div>
    `;
    registry.appendChild(card);

    // Render previous results inline
    if (last) renderAtResults(app.id, last);
  });
}

async function runAppTest(appId, mode) {
  const logWrap    = document.getElementById('apptests-log-wrap');
  const logEl      = document.getElementById('apptests-log');
  const workersEl  = document.getElementById('apptests-workers');
  const resultsEl  = document.getElementById('apptests-results');

  // Show log + workers
  logWrap.style.display   = '';
  workersEl.style.display = '';
  logEl.textContent       = '';
  resultsEl.innerHTML     = '';

  // Reset worker chips
  ['at-w1','at-w2','at-w3','at-w4','at-w5'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.className = 'at-worker';
  });

  const appendLog = (msg) => {
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  };

  appendLog(`[${new Date().toLocaleTimeString()}] Starting ${mode} suite for ${appId}…`);

  // Wake playwright-worker (may be spun down)
  appendLog(`[${new Date().toLocaleTimeString()}] Waking playwright-worker…`);
  try {
    await fetch(`${AT_WORKER_URL}/health`, { signal: AbortSignal.timeout(15000) });
  } catch(_) {
    appendLog('⚠️ playwright-worker not responding — it may still be spinning up (30s). Retrying…');
  }

  // Fetch E2E password from server
  let e2ePassword = '';
  try {
    const r = await fetch('/api/e2e-password', { headers: { 'x-operator': window._operatorToken || '' } });
    if (r.ok) { const j = await r.json(); e2ePassword = j.password || ''; }
  } catch(_) {}

  // POST to playwright-worker via our proxy (avoids CORS issues)
  const workerMap = { 'W1-Auth': 'at-w1', 'W2-Navigation': 'at-w2', 'W3-Buttons': 'at-w3', 'W4-Forms': 'at-w4', 'W5-Signals': 'at-w5' };

  try {
    const resp = await fetch('/api/run-app-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-operator': window._operatorToken || '' },
      body: JSON.stringify({ appId, mode, e2ePassword }),
    });

    if (!resp.ok) {
      appendLog(`❌ Server error: ${resp.status}`);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'log') {
            appendLog(evt.msg);
          } else if (evt.type === 'worker-start') {
            const chip = document.getElementById(workerMap[evt.worker]);
            if (chip) chip.className = 'at-worker running';
            appendLog(`\n── ${evt.worker} ──`);
          } else if (evt.type === 'worker-done') {
            const chip = document.getElementById(workerMap[evt.worker]);
            if (chip) chip.className = `at-worker ${evt.ok ? 'pass' : 'fail'}`;
          } else if (evt.type === 'done') {
            finalResult = evt.result;
          }
        } catch(_) {}
      }
    }

    if (finalResult) {
      atSaveResults(appId, finalResult);
      renderAtResults(appId, finalResult);
      appendLog(`\n✅ Done — ${finalResult.summary?.passed}/${finalResult.summary?.total} passed in ${(finalResult.durationMs/1000).toFixed(1)}s`);
      renderAppTestsSection(); // refresh last-run timestamps
    }

  } catch(e) {
    appendLog(`❌ Error: ${e.message}`);
  }
}

function renderAtResults(appId, result) {
  const el = document.getElementById('at-result-' + appId);
  if (!el || !result) return;

  const allItems = Object.entries(result.workers || {}).map(([worker, items]) => {
    const arr = Array.isArray(items) ? items : [items];
    return arr.map(item => ({ worker, ...item }));
  }).flat();

  const passed = allItems.filter(r => r.ok || r.ok === undefined).length;
  const failed = allItems.filter(r => r.ok === false).length;

  const summaryClass = failed === 0 ? 'pass' : 'fail';
  const summaryIcon  = failed === 0 ? '✅' : '❌';

  el.innerHTML = `
    <div class="at-summary-bar ${summaryClass}">
      <div class="at-summary-count">${summaryIcon} ${passed}/${allItems.length}</div>
      <div class="at-summary-label">tests passed · ${(result.durationMs/1000||0).toFixed(1)}s · ${result.mode || ''}</div>
    </div>
    <div class="at-result-section">
      ${allItems.slice(0, 12).map(item => `
        <div class="at-result-row">
          <span class="at-result-icon">${item.ok === false ? '❌' : item.skipped ? '⏭' : '✅'}</span>
          <span class="at-result-name">${item.screen || item.button || item.form || item.test || item.worker || 'check'}</span>
          <span class="at-result-note">${item.note || item.error || ''}</span>
        </div>
      `).join('')}
      ${allItems.length > 12 ? `<div style="font-size:11px;color:var(--text-2);padding-top:6px">+${allItems.length-12} more</div>` : ''}
    </div>
  `;
}

// Init when tab is clicked
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-item[data-section="apptests"]').forEach(el => {
    el.addEventListener('click', () => setTimeout(renderAppTestsSection, 100));
  });
});

// ── LocalIntel Capability Node Definitions ────────────────────────────────────
const LI_NODES = [
  {
    id: 'acs', icon: '👥', label: 'ACS Demographics',
    source: 'Census Bureau · Annual',
    color: '#3B82F6',
    statusKey: 'acs_population',
    questions: ['What is the median household income?', 'What % own their home?', 'What % work from home?'],
    signals: ['acs_population','acs_median_hhi','acs_owner_occ_pct','acs_college_pct','acs_poverty_pct'],
    demoZip: '32082',
  },
  {
    id: 'irs', icon: '💰', label: 'IRS Income (SOI)',
    source: 'IRS Statistics of Income · Annual',
    color: '#10B981',
    statusKey: 'irs_agi_median',
    questions: ['What is the true median AGI?', 'What share of income is wages vs investment?', 'How many returns filed?'],
    signals: ['irs_agi_median','irs_returns','irs_wage_share'],
    demoZip: '32082',
  },
  {
    id: 'irs_mig', icon: '✈️', label: 'IRS Migration Flow',
    source: 'IRS SOI Migration · Annual',
    color: '#06B6D4',
    statusKey: 'irs_mig_net_returns',
    questions: ['Is this ZIP gaining or losing residents?', 'Where are people moving from?', 'How much income is migrating in?'],
    signals: ['irs_mig_net_returns','irs_mig_net_agi','irs_mig_top_origin'],
    demoZip: '32082',
  },
  {
    id: 'zbp', icon: '🏢', label: 'Census Business Patterns',
    source: 'Census ZBP/CBP · Annual',
    color: '#8B5CF6',
    statusKey: 'zbp_total_establishments',
    questions: ['How many businesses are in this ZIP?', 'What sectors dominate?', 'How many employees?'],
    signals: ['zbp_total_establishments','cbp_total_establishments','cbp_dominant_sector'],
    demoZip: '32082',
  },
  {
    id: 'osm', icon: '🗺️', label: 'OpenStreetMap (OSM)',
    source: 'Overpass API · Weekly',
    color: '#F97316',
    statusKey: 'osm_biz_count',
    questions: ['How many businesses have phone numbers?', 'What % have hours posted?', 'Food/retail/healthcare counts?'],
    signals: ['osm_biz_count','osm_food_count','osm_with_phone_pct','osm_with_hours_pct'],
    demoZip: '32082',
  },
  {
    id: 'permits', icon: '🏗️', label: 'Building Permits (BPS)',
    source: 'Census BPS · Monthly/Annual',
    color: '#EAB308',
    statusKey: 'bps_total_units_annual',
    questions: ['How much construction is happening?', 'Residential or commercial dominant?', 'What is the permit velocity?'],
    signals: ['bps_total_units_annual','bps_res_multifam_annual','bps_commercial_mo'],
    demoZip: '32082',
  },
  {
    id: 'fcc', icon: '📡', label: 'FCC Broadband (BDC)',
    source: 'FCC BDC API · Semiannual',
    color: '#6366F1',
    statusKey: 'fcc_updated_at',
    questions: ['What % have 25/3 Mbps broadband?', 'Is fiber available?', 'How many providers compete?', 'BEAD-eligible?'],
    signals: ['fcc_pct_25_3','fcc_provider_count','fcc_fiber_available','fcc_bead_unserved_pct'],
    demoZip: '32082',
  },
  {
    id: 'sunbiz', icon: '📋', label: 'Sunbiz Entity Registry',
    source: 'Florida DOS · Monthly',
    color: '#EC4899',
    statusKey: 'sunbiz_active_entities',
    questions: ['How many active businesses registered?', 'New formations last 12 months?', 'Is formation accelerating?'],
    signals: ['sunbiz_active_entities','sunbiz_new_12mo','sunbiz_net_12mo'],
    demoZip: '32082',
  },
  {
    id: 'world', icon: '🌍', label: 'World Model Score',
    source: 'LocalIntel · Daily',
    color: '#EF4444',
    statusKey: 'sig_growth_score',
    questions: ['What is the growth score vs peer ZIPs?', 'What is the opportunity score?', 'What market stage is this ZIP?', 'Any statistical anomalies?'],
    signals: ['sig_growth_score','sig_opportunity_score','sig_market_maturity','sig_peer_cohort'],
    demoZip: '32082',
  },
  {
    id: 'oracle', icon: '🔮', label: 'MCP Oracle',
    source: 'LocalIntel API · On-demand',
    color: '#F59E0B',
    statusKey: null, // always live — it's the API layer
    questions: ['What are the top business gaps?', 'What is restaurant saturation?', 'What consumer profile?', 'What would you build here?'],
    signals: ['nl-query','oracle','brief','market-gaps'],
    demoZip: '32082',
  },
];

// ── LocalIntel World Model panel ──────────────────────────────────────────────
const LI_ADMIN_TOKEN = 'localintel-migrate-2026';
const LI_BASE        = API_BASE + '/api/local-intel';

// Auto-load when tab is activated (click) or on page init (default tab)
document.addEventListener('click', e => {
  const item = e.target.closest('[data-section="localintel"]');
  if (item) {
    setTimeout(loadLocalIntelPanel, 100);
  }
});

// LocalIntel is the default active tab — load it on page init
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(loadLocalIntelPanel, 200);
});

async function loadLocalIntelPanel() {
  await Promise.all([
    loadFccStatus(),
    loadAnomalies(),
    loadFredBeaStatus(),
    loadLodesQwiStatus(),
    loadQcewStatus(),
    loadWorkerStatus(),
    loadCesStatus(),
  ]);
}

// ── FCC Tier 1 status ─────────────────────────────────────────────────────────
async function loadFccStatus() {
  try {
    // Query zip_signals for FCC coverage summary
    const r = await fetch(`${LI_BASE}/zip-signals/32082`, {
      headers: { 'x-admin-token': LI_ADMIN_TOKEN }
    });
    if (!r.ok) throw new Error('no data');
    const d = await r.json();
    const sig = d.signals || {};

    // Render capability node cards with signal presence status
    renderLiNodes(sig);

    const vintage = sig.fcc_vintage_date || '—';
    const updated = sig.fcc_updated_at
      ? new Date(sig.fcc_updated_at).toLocaleDateString()
      : '—';

    document.getElementById('li-fcc-vintage').textContent = vintage;
    document.getElementById('li-fcc-updated').textContent = updated;

    // Get count of ZIPs with FCC data
    const statsR = await fetch(`${LI_BASE}/admin/stats`, {
      headers: { 'x-admin-token': LI_ADMIN_TOKEN }
    });
    if (statsR.ok) {
      // stats endpoint doesn't have fcc count — just show last updated context
    }

    // Chip status
    setChipStatus('fcc',
      sig.fcc_updated_at ? 'ok' : 'warn',
      sig.fcc_updated_at ? `v${vintage}` : 'no data yet'
    );
    document.getElementById('li-fcc-zips').textContent = '—'; // populated by anomaly count or stats later

  } catch (e) {
    setChipStatus('fcc', 'warn', 'checking…');
    renderLiNodes(null);
  }

  // Check other worker chips via anomaly endpoint (confirms world model is running)
  try {
    const r = await fetch(`${LI_BASE}/anomalies?limit=1`, {
      headers: { 'x-admin-token': LI_ADMIN_TOKEN }
    });
    if (r.ok) {
      setChipStatus('world', 'ok', 'running');
      setChipStatus('irs',   'ok', 'running');
      setChipStatus('acs',   'ok', 'running');
      setChipStatus('permit','ok', 'running');
    } else {
      ['world','irs','acs','permit'].forEach(k => setChipStatus(k, 'warn', 'no data'));
    }
  } catch (e) {
    ['world','irs','acs','permit'].forEach(k => setChipStatus(k, 'err', 'error'));
  }
}


// ── LocalIntel Capability Node Renderer ───────────────────────────────────────
function renderLiNodes(signals) {
  const grid = document.getElementById('li-nodes-grid');
  if (!grid) return;
  let liveCount = 0;

  grid.innerHTML = LI_NODES.map(node => {
    const isLive = node.statusKey === null ? true : (signals && signals[node.statusKey] != null);
    if (isLive) liveCount++;

    const statusDot = isLive
      ? '<span class="li-node-dot live" title="Live data"></span>'
      : '<span class="li-node-dot pending" title="Pending — worker running"></span>';

    const questions = node.questions.map(q =>
      `<div class="li-node-q">Q: ${q}</div>`
    ).join('');

    const sigChips = node.signals.map(s =>
      `<span class="li-node-sig">${s}</span>`
    ).join('');

    return `
      <div class="li-node-card" style="--node-color:${node.color}">
        <div class="li-node-head">
          <span class="li-node-icon">${node.icon}</span>
          <div class="li-node-info">
            <span class="li-node-label">${node.label}</span>
            <span class="li-node-source">${node.source}</span>
          </div>
          ${statusDot}
        </div>
        <div class="li-node-questions">${questions}</div>
        <div class="li-node-sigs">${sigChips}</div>
        <button class="li-node-demo-btn" onclick="demoNode('${node.id}','${node.demoZip}')">Demo ▶</button>
        <div class="li-node-demo-result" id="li-node-demo-${node.id}" style="display:none"></div>
      </div>
    `;
  }).join('');

  const countEl = document.getElementById('li-nodes-live-count');
  if (countEl) countEl.textContent = liveCount + ' / ' + LI_NODES.length + ' live';
}

async function demoNode(nodeId, zip) {
  const out = document.getElementById('li-node-demo-' + nodeId);
  if (!out) return;
  const showing = out.style.display !== 'none' && out.style.display !== '';
  if (showing) { out.style.display = 'none'; return; }
  out.style.display = 'block';
  out.textContent = 'Loading...';

  try {
    let url, headers = { 'x-admin-token': LI_ADMIN_TOKEN };
    if (nodeId === 'oracle') {
      url = `${LI_BASE}/oracle?zip=${zip}`;
    } else {
      url = `${LI_BASE}/zip-signals/${zip}`;
    }
    const r = await fetch(url, { headers });
    const data = await r.json();

    // For zip-signals, filter to just this node's signals
    const node = LI_NODES.find(n => n.id === nodeId);
    let display = data;
    if (nodeId !== 'oracle' && data.signals && node) {
      display = {};
      node.signals.forEach(s => { if (data.signals[s] != null) display[s] = data.signals[s]; });
      if (Object.keys(display).length === 0) display = { status: 'pending', message: 'Worker has not populated this ZIP yet — check Railway logs' };
    }

    out.textContent = JSON.stringify(display, null, 2);
  } catch(e) {
    out.textContent = 'Error: ' + e.message;
  }
}

function setChipStatus(key, status, meta) {
  const dot  = document.getElementById(`li-dot-${key}`);
  const metaEl = document.getElementById(`li-meta-${key}`);
  if (dot)   { dot.className = `li-chip-dot ${status}`; }
  if (metaEl){ metaEl.textContent = meta; }
}

// ── FCC Tier 2 deep dive trigger ──────────────────────────────────────────────
async function triggerFccDeepDive() {
  const btn = document.getElementById('li-t2-trigger');
  const res = document.getElementById('li-t2-result');
  if (!btn || !res) return;

  const confirmed = confirm(
    'Run FCC BDC Tier 2 deep dive?\n\n' +
    'This downloads ~500MB of location-level provider data for all of Florida ' +
    'and aggregates it to ZIP level.\n\n' +
    'Recommended only for annual baseline refresh or paid consultation customers.\n\n' +
    'Continue?'
  );
  if (!confirmed) return;

  btn.disabled = true;
  btn.textContent = 'Requesting…';
  res.style.display = 'block';
  res.textContent = 'Submitting request…';

  try {
    const r = await fetch(`${LI_BASE}/admin/fcc-deep-dive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': LI_ADMIN_TOKEN,
      },
      body: JSON.stringify({ dry_run: false }),
    });
    const data = await r.json();
    res.textContent = JSON.stringify(data, null, 2);

    if (data.status === 'not_implemented') {
      btn.textContent = 'Implementation Queued';
      document.getElementById('li-t2-last-run').textContent = 'Never';
    } else {
      btn.textContent = 'Requested ✓';
      document.getElementById('li-t2-last-run').textContent = new Date().toLocaleDateString();
    }
  } catch (e) {
    res.textContent = 'Error: ' + e.message;
    btn.disabled = false;
    btn.textContent = 'Run Deep Dive';
  }
}

// ── ZIP signal lookup ─────────────────────────────────────────────────────────
async function lookupZipSignals() {
  const zip = (document.getElementById('li-zip-input')?.value || '').trim();
  const out = document.getElementById('li-zip-result');
  if (!zip || !/^\d{5}$/.test(zip)) {
    if (out) out.innerHTML = '<span style="color:#EF4444">Enter a valid 5-digit ZIP</span>';
    return;
  }
  if (out) out.innerHTML = '<span style="color:#888">Loading…</span>';

  try {
    const r = await fetch(`${LI_BASE}/zip-signals/${zip}`, {
      headers: { 'x-admin-token': LI_ADMIN_TOKEN }
    });
    const data = await r.json();
    if (!data.signals) throw new Error(data.error || 'No signals found');

    const sig = data.signals;
    const rows = Object.entries(sig)
      .filter(([k]) => !k.includes('_at') || k === 'fcc_updated_at')
      .map(([k, v]) => {
        const val = v === null ? '<span style="color:#444">null</span>'
          : typeof v === 'boolean' ? (v ? '<span style="color:#16A34A">✓</span>' : '<span style="color:#666">—</span>')
          : `<span style="color:#e0e0e0">${v}</span>`;
        return `<tr>
          <td style="padding:3px 10px 3px 0;color:#888;white-space:nowrap">${k}</td>
          <td style="padding:3px 0">${val}</td>
        </tr>`;
      }).join('');

    if (out) out.innerHTML = `
      <div style="margin-bottom:6px;color:#16A34A;font-weight:600">ZIP ${zip} — ${Object.keys(sig).length} signals</div>
      <table style="border-collapse:collapse;width:100%;font-family:monospace">${rows}</table>
    `;
  } catch (e) {
    if (out) out.innerHTML = `<span style="color:#EF4444">${e.message}</span>`;
  }
}

// ── Open anomalies ────────────────────────────────────────────────────────────
async function loadAnomalies() {
  const out = document.getElementById('li-anomalies-list');
  if (!out) return;
  out.textContent = 'Loading…';

  try {
    const r = await fetch(`${LI_BASE}/anomalies`, {
      headers: { 'x-admin-token': LI_ADMIN_TOKEN }
    });
    const data = await r.json();
    const items = data.anomalies || data || [];

    if (!items.length) {
      out.innerHTML = '<span style="color:#16A34A">No open anomalies — world model nominal</span>';
      return;
    }

    const severity = { significant: '#EF4444', notable: '#F59E0B', extreme: '#FF0000' };
    out.innerHTML = items.slice(0, 15).map(a => `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border,#1a1a1a);">
        <span style="font-size:10px;font-weight:700;color:${severity[a.severity]||'#888'};min-width:70px">${(a.severity||'').toUpperCase()}</span>
        <div>
          <div style="color:var(--text-1,#e0e0e0);font-size:12px">ZIP ${a.zip} — ${a.signal_name}</div>
          <div style="color:var(--text-2,#888);font-size:11px;margin-top:2px">${a.question || a.notes || ''}</div>
        </div>
        <span style="margin-left:auto;font-size:10px;color:#444;white-space:nowrap">${a.zip}</span>
      </div>
    `).join('');
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
}

// ── FRED + BEA worker trigger + status ───────────────────────────────────────

// Generic worker trigger — used by FRED, BEA (and future workers)
async function triggerWorker(workerKey) {
  const btn = document.getElementById(`li-${workerKey}-trigger-btn`);
  const res = document.getElementById(`li-${workerKey}-trigger-result`);
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = 'Triggering…';
  if (res) res.textContent = '';

  try {
    const r = await fetch(`${API_BASE}/api/admin/trigger-${workerKey}`, {
      method: 'POST',
      headers: { 'x-operator-token': LI_ADMIN_TOKEN },
    });
    const data = await r.json();
    if (data.error) {
      btn.textContent = `ERROR: ${data.error}`;
      btn.disabled = false;
      if (res) { res.textContent = data.error; res.style.color = '#EF4444'; }
    } else {
      btn.textContent = 'Running ✓';
      if (res) res.textContent = data.message || 'Worker started';
      // Reload all status panels after worker starts (data will populate gradually)
      setTimeout(() => {
        loadFredBeaStatus();
        loadLodesQwiStatus();
        loadQcewStatus();
        loadWorkerStatus();
      }, 5000);
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Trigger ' + workerKey.toUpperCase();
    if (res) { res.textContent = 'Error: ' + e.message; res.style.color = '#EF4444'; }
  }
}

// Load FRED + BEA status from zip_signals
async function loadFredBeaStatus() {
  try {
    // Fetch ZIP signal data for 32082 (St. Johns) to show sample values
    const r = await fetch(`${LI_BASE}/zip-signals/32082`, {
      headers: { 'x-admin-token': LI_ADMIN_TOKEN },
    });
    const data = await r.json();
    const sig = data?.signals || data || {};

    // FRED stats
    const fredEl   = document.getElementById('li-fred-badge');
    const fredZips = document.getElementById('li-fred-zips');
    const fredVint = document.getElementById('li-fred-vintage');
    const fredSjc  = document.getElementById('li-fred-sjc');
    const fredDot  = document.getElementById('li-dot-fred');
    const fredMeta = document.getElementById('li-meta-fred');

    if (sig.fred_unemployment_rate != null) {
      if (fredEl) { fredEl.textContent = 'LIVE'; fredEl.style.background='#14532d'; fredEl.style.color='#4ade80'; fredEl.style.border='1px solid #22c55e'; }
      if (fredZips) fredZips.textContent = '—'; // populated by full count query
      if (fredVint) fredVint.textContent = sig.fred_vintage || '—';
      if (fredSjc)  fredSjc.textContent  = sig.fred_unemployment_rate != null ? sig.fred_unemployment_rate + '%' : '—';
      if (fredDot)  fredDot.className    = 'li-chip-dot li-dot-live';
      if (fredMeta) fredMeta.textContent = sig.fred_vintage || 'live';
    } else {
      if (fredEl) { fredEl.textContent = 'PENDING'; fredEl.style.background='#1e3a5f'; fredEl.style.color='#60a5fa'; }
      if (fredDot)  fredDot.className   = 'li-chip-dot';
      if (fredMeta) fredMeta.textContent = 'not yet run';
    }

    // BEA stats
    const beaEl   = document.getElementById('li-bea-badge');
    const beaZips = document.getElementById('li-bea-zips');
    const beaVint = document.getElementById('li-bea-vintage');
    const beaSjc  = document.getElementById('li-bea-sjc');
    const beaVsfl = document.getElementById('li-bea-vs-fl');
    const beaDot  = document.getElementById('li-dot-bea');
    const beaMeta = document.getElementById('li-meta-bea');

    if (sig.bea_per_capita_income != null) {
      if (beaEl)   { beaEl.textContent = 'LIVE'; beaEl.style.background='#14532d'; beaEl.style.color='#4ade80'; beaEl.style.border='1px solid #22c55e'; }
      if (beaVint) beaVint.textContent = sig.bea_vintage || '—';
      if (beaSjc)  beaSjc.textContent  = '$' + (sig.bea_per_capita_income || 0).toLocaleString();
      if (beaVsfl) beaVsfl.textContent = sig.bea_income_vs_fl_avg != null ? sig.bea_income_vs_fl_avg + '×' : '—';
      if (beaDot)  beaDot.className    = 'li-chip-dot li-dot-live';
      if (beaMeta) beaMeta.textContent = sig.bea_vintage || 'live';
    } else {
      if (beaEl)   { beaEl.textContent = 'PENDING'; beaEl.style.background='#1a3a2a'; beaEl.style.color='#86efac'; }
      if (beaDot)  beaDot.className    = 'li-chip-dot';
      if (beaMeta) beaMeta.textContent = 'not yet run';
    }

  } catch (e) {
    console.warn('[fred/bea status]', e.message);
  }
}

// ── LODES + QWI status ────────────────────────────────────────────────────────
async function loadLodesQwiStatus() {
  try {
    const r = await fetch(`${LI_BASE}/zip-signals/32082`, {
      headers: { 'x-admin-token': LI_ADMIN_TOKEN },
    });
    const data = await r.json();
    const sig = data?.signals || data || {};

    // LODES
    const lodesBadge = document.getElementById('li-lodes-badge');
    const lodesDot   = document.getElementById('li-dot-lodes');
    const lodesMeta  = document.getElementById('li-meta-lodes');

    if (sig.lodes_jobs_here != null) {
      if (lodesBadge) { lodesBadge.textContent='LIVE'; lodesBadge.style.background='#14532d'; lodesBadge.style.color='#4ade80'; lodesBadge.style.border='1px solid #22c55e'; }
      if (lodesDot) lodesDot.className = 'li-chip-dot li-dot-live';
      if (lodesMeta) lodesMeta.textContent = sig.lodes_vintage || 'live';
      const sjcJobs = document.getElementById('li-lodes-sjc-jobs');
      const sjcNet  = document.getElementById('li-lodes-sjc-net');
      const lodesV  = document.getElementById('li-lodes-vintage');
      if (sjcJobs) sjcJobs.textContent = sig.lodes_jobs_here?.toLocaleString() || '—';
      if (sjcNet)  sjcNet.textContent  = sig.lodes_net_flow != null ? (sig.lodes_net_flow > 0 ? '+' : '') + sig.lodes_net_flow.toLocaleString() : '—';
      if (lodesV)  lodesV.textContent  = sig.lodes_vintage || '—';
    } else {
      if (lodesBadge) { lodesBadge.textContent='PENDING'; lodesBadge.style.background='#1e1a3f'; lodesBadge.style.color='#a78bfa'; }
      if (lodesDot) lodesDot.className = 'li-chip-dot';
      if (lodesMeta) lodesMeta.textContent = 'not yet run';
    }

    // QWI
    const qwiBadge = document.getElementById('li-qwi-badge');
    const qwiDot   = document.getElementById('li-dot-qwi');
    const qwiMeta  = document.getElementById('li-meta-qwi');

    if (sig.qwi_employment != null) {
      if (qwiBadge) { qwiBadge.textContent='LIVE'; qwiBadge.style.background='#14532d'; qwiBadge.style.color='#4ade80'; qwiBadge.style.border='1px solid #22c55e'; }
      if (qwiDot) qwiDot.className = 'li-chip-dot li-dot-live';
      if (qwiMeta) qwiMeta.textContent = sig.qwi_vintage || 'live';
      const qwiEmp  = document.getElementById('li-qwi-sjc-emp');
      const qwiEarn = document.getElementById('li-qwi-sjc-earn');
      const qwiTurn = document.getElementById('li-qwi-sjc-turn');
      const qwiV    = document.getElementById('li-qwi-vintage');
      if (qwiEmp)  qwiEmp.textContent  = sig.qwi_employment?.toLocaleString() || '—';
      if (qwiEarn) qwiEarn.textContent = sig.qwi_avg_monthly_earn ? '$' + sig.qwi_avg_monthly_earn.toLocaleString() : '—';
      if (qwiTurn) qwiTurn.textContent = sig.qwi_turnover_rate != null ? sig.qwi_turnover_rate + '%' : '—';
      if (qwiV)    qwiV.textContent    = sig.qwi_vintage || '—';
    } else {
      if (qwiBadge) { qwiBadge.textContent='PENDING'; qwiBadge.style.background='#1a2a3f'; qwiBadge.style.color='#38bdf8'; }
      if (qwiDot) qwiDot.className = 'li-chip-dot';
      if (qwiMeta) qwiMeta.textContent = 'not yet run';
    }
  } catch (e) {
    console.warn('[lodes/qwi status]', e.message);
  }
}

// ── QCEW (BLS Quarterly Census of Employment and Wages) status ────────────────
async function loadQcewStatus() {
  try {
    const r = await fetch(`${LI_BASE}/zip-signals/32082`, {
      headers: { 'x-admin-token': LI_ADMIN_TOKEN },
    });
    const data = await r.json();
    const sig = data?.signals || data || {};

    const qcewBadge = document.getElementById('li-qcew-badge');
    const qcewDot   = document.getElementById('li-dot-qcew');
    const qcewMeta  = document.getElementById('li-meta-qcew');

    if (sig.qcew_employment != null) {
      if (qcewBadge) { qcewBadge.textContent='LIVE'; qcewBadge.style.background='#14532d'; qcewBadge.style.color='#4ade80'; qcewBadge.style.border='1px solid #22c55e'; }
      if (qcewDot)   qcewDot.className = 'li-chip-dot li-dot-live';
      if (qcewMeta)  qcewMeta.textContent = sig.qcew_vintage || 'live';

      const empEl   = document.getElementById('li-qcew-sjc-emp');
      const wagesEl = document.getElementById('li-qcew-sjc-wages');
      const estabEl = document.getElementById('li-qcew-sjc-estab');
      const empYoy  = document.getElementById('li-qcew-emp-yoy');
      const wageYoy = document.getElementById('li-qcew-wage-yoy');
      const vintEl  = document.getElementById('li-qcew-vintage');

      if (empEl)   empEl.textContent   = sig.qcew_employment?.toLocaleString() || '—';
      if (wagesEl) wagesEl.textContent = sig.qcew_avg_weekly_wages ? '$' + sig.qcew_avg_weekly_wages.toLocaleString() + '/wk' : '—';
      if (estabEl) estabEl.textContent = sig.qcew_establishments?.toLocaleString() || '—';
      if (empYoy)  empYoy.textContent  = sig.qcew_emp_yoy_pct  != null ? (sig.qcew_emp_yoy_pct > 0 ? '+' : '') + sig.qcew_emp_yoy_pct + '%' : '—';
      if (wageYoy) wageYoy.textContent = sig.qcew_wage_yoy_pct != null ? (sig.qcew_wage_yoy_pct > 0 ? '+' : '') + sig.qcew_wage_yoy_pct + '%' : '—';
      if (vintEl)  vintEl.textContent  = sig.qcew_vintage || '—';
    } else {
      if (qcewBadge) { qcewBadge.textContent='PENDING'; qcewBadge.style.background='#1a2a1f'; qcewBadge.style.color='#86efac'; }
      if (qcewDot)   qcewDot.className = 'li-chip-dot';
      if (qcewMeta)  qcewMeta.textContent = 'not yet run';
    }
  } catch (e) {
    console.warn('[qcew status]', e.message);
  }
}

// ── Worker heartbeat status — stamps last_run on every chip ──────────────────
// Pulls /api/admin/worker-status and updates li-meta-* chip labels with
// human-readable "Xh ago" or "Xd ago" so the dashboard always shows when
// each data source was last ingested.
async function loadWorkerStatus() {
  try {
    const r = await fetch(`${API_BASE}/api/admin/worker-status`, {
      headers: { 'x-operator-token': LI_ADMIN_TOKEN },
    });
    if (!r.ok) return;
    const data = await r.json();
    const workers = data.workers || {};

    // Map: worker_name → chip meta element id
    const chipMap = {
      acsWorker:          'li-meta-acs',
      censusLayerWorker:  'li-meta-acs',   // same chip
      oracleWorker:       'li-meta-world',
      worldModelWorker:   'li-meta-world',
      fredWorker:         'li-meta-fred',
      beaWorker:          'li-meta-bea',
      lodesWorker:        'li-meta-lodes',
      qwiWorker:          'li-meta-qwi',
      qcewWorker:         'li-meta-qcew',
      cesWorker:          'li-meta-ces',
      fccBroadbandWorker: 'li-meta-fcc',
      irsMigrationWorker: 'li-meta-irs',
      permitWorker:       'li-meta-permit',
      sjcArcGisWorker:    'li-meta-permit',
    };

    function ageLabel(ageHours) {
      if (ageHours == null) return 'never';
      if (ageHours < 1)  return Math.round(ageHours * 60) + 'm ago';
      if (ageHours < 48) return Math.round(ageHours) + 'h ago';
      return Math.round(ageHours / 24) + 'd ago';
    }

    for (const [workerName, info] of Object.entries(workers)) {
      const elId = chipMap[workerName];
      if (!elId) continue;
      const el = document.getElementById(elId);
      if (!el) continue;
      // Only overwrite if the element still shows a placeholder or 'not yet run'
      // so that signal-based status (e.g. LIVE + vintage) takes precedence.
      // Worker status is the fallback when signals haven't loaded yet.
      if (el.textContent === 'checking…' || el.textContent === 'not yet run' || el.textContent === 'never') {
        el.textContent = ageLabel(info.age_hours);
      }
    }
  } catch (e) {
    // Non-fatal — chips just stay at default text
    console.warn('[worker-status]', e.message);
  }
}

// ── CES sector employment + AI investment scores status ───────────────────────
async function loadCesStatus() {
  try {
    const r = await fetch(`${LI_BASE}/zip-signals/32082`, {
      headers: { 'x-admin-token': LI_ADMIN_TOKEN },
    });
    const data = await r.json();
    const sig = data?.signals || data || {};

    const cesBadge = document.getElementById('li-ces-badge');
    const cesDot   = document.getElementById('li-dot-ces');
    const cesMeta  = document.getElementById('li-meta-ces');

    if (sig.ces_msa_code) {
      if (cesBadge) { cesBadge.textContent='LIVE'; cesBadge.style.background='#14532d'; cesBadge.style.color='#4ade80'; cesBadge.style.border='1px solid #22c55e'; }
      if (cesDot)   cesDot.className = 'li-chip-dot li-dot-live';
      if (cesMeta)  cesMeta.textContent = sig.ces_vintage || 'live';

      const msaEl   = document.getElementById('li-ces-msa');
      const totEl   = document.getElementById('li-ces-total');
      const totYoy  = document.getElementById('li-ces-total-yoy');
      const healthEl = document.getElementById('li-ces-health');
      const constEl  = document.getElementById('li-ces-const');
      const vintEl   = document.getElementById('li-ces-vintage');
      const aiRisk   = document.getElementById('li-ces-ai-risk');
      const invScore = document.getElementById('li-ces-inv-score');
      const invTier  = document.getElementById('li-ces-inv-tier');
      const domSec   = document.getElementById('li-ces-dom-sector');

      if (msaEl)   msaEl.textContent   = sig.ces_msa_name || '—';
      if (totEl)   totEl.textContent   = sig.ces_total_nonfarm ? sig.ces_total_nonfarm.toLocaleString() + 'k' : '—';
      if (totYoy)  totYoy.textContent  = sig.ces_total_yoy_pct != null ? (sig.ces_total_yoy_pct > 0 ? '+' : '') + sig.ces_total_yoy_pct + '%' : '—';
      if (healthEl) healthEl.textContent = sig.ces_healthcare_yoy_pct != null ? (sig.ces_healthcare_yoy_pct > 0 ? '+' : '') + sig.ces_healthcare_yoy_pct + '%' : '—';
      if (constEl)  constEl.textContent = sig.ces_construction_yoy_pct != null ? (sig.ces_construction_yoy_pct > 0 ? '+' : '') + sig.ces_construction_yoy_pct + '%' : '—';
      if (vintEl)   vintEl.textContent  = sig.ces_vintage || '—';
      if (aiRisk)   aiRisk.textContent  = sig.ai_displacement_risk != null ? sig.ai_displacement_risk + '/100' : '—';
      if (invScore) invScore.textContent = sig.investment_opportunity_score != null ? sig.investment_opportunity_score + '/100' : '—';
      if (invTier)  invTier.textContent  = sig.investment_tier || '—';
      if (domSec)   domSec.textContent   = sig.dominant_growth_sector || '—';
    } else {
      if (cesBadge) { cesBadge.textContent='PENDING'; cesBadge.style.background='#1a1a3f'; cesBadge.style.color='#a78bfa'; }
      if (cesDot)   cesDot.className = 'li-chip-dot';
      if (cesMeta)  cesMeta.textContent = 'not yet run';
    }
  } catch (e) {
    console.warn('[ces status]', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  CALL TRANSCRIPTS + DEAD ENDS — LocalIntel admin panels (B15)
// ══════════════════════════════════════════════════════════════════════════════

function formatCallTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} ${h}:${m} ${ampm}`;
}

function formatDuration(sec) {
  if (sec == null || isNaN(sec)) return '—';
  const s = Math.floor(Number(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return r + 's';
  return m + 'm ' + r + 's';
}

function transcriptStatusClass(status) {
  const s = (status || '').toLowerCase();
  if (s === 'transcribed' || s === 'completed' || s === 'ok') return 'green';
  if (s === 'failed' || s === 'error') return 'red';
  return 'gold';
}

async function loadTranscripts() {
  const tbody = document.getElementById('tx-tbody');
  const badge = document.getElementById('tx-count-badge');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="muted center">Loading…</td></tr>';
  if (badge) badge.textContent = '…';

  try {
    const r = await fetch(`${LI_BASE}/call-transcripts?limit=50`, {
      headers: { 'x-admin-token': LI_ADMIN_TOKEN },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const items = Array.isArray(data) ? data : (data.transcripts || data.items || data.calls || []);

    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted center" style="padding:32px">No calls yet — call (904) 506-7476 to test</td></tr>';
      if (badge) badge.textContent = '0 calls';
      return;
    }

    if (badge) badge.textContent = `${items.length} call${items.length === 1 ? '' : 's'}`;

    tbody.innerHTML = '';
    items.forEach((item, idx) => {
      const caller = item.caller_id || item.from || item.caller || '—';
      const zip = item.zip_code || item.zip || '—';
      const dur = formatDuration(item.duration_sec ?? item.duration ?? item.duration_seconds);
      const status = item.status || (item.transcription_text ? 'transcribed' : 'pending');
      const recUrl = item.recording_url || null;
      const transcript = item.transcription_text || item.transcript || item.transcript_text || '';
      const truncated = transcript.length > 100 ? transcript.slice(0, 100) + '…' : (transcript || '—');

      const tr = document.createElement('tr');
      tr.className = 'tx-transcript-row';
      tr.dataset.rowIdx = idx;
      tr.innerHTML = `
        <td class="mono">${esc(caller)}</td>
        <td class="mono">${esc(zip)}</td>
        <td class="mono">${esc(dur)}</td>
        <td><span class="badge ${transcriptStatusClass(status)}">${esc(status)}</span></td>
        <td>${recUrl ? `<audio controls style="height:28px;max-width:200px;" src="${esc(recUrl)}"></audio>` : '<span class="muted">—</span>'}</td>
        <td class="tx-transcript-cell" data-full="${esc(transcript)}">${esc(truncated)}</td>`;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.tx-transcript-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const row = cell.parentElement;
        const full = cell.dataset.full || '';
        if (!full) return;
        const expanded = row.classList.toggle('expanded');
        cell.textContent = expanded ? full : (full.length > 100 ? full.slice(0, 100) + '…' : full);
      });
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted center" style="padding:24px;color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
    if (badge) badge.textContent = 'error';
  }
}

let _deadEndsCache = [];

function renderDeadEnds(items, filter) {
  const tbody = document.getElementById('de-tbody');
  const badge = document.getElementById('de-count-badge');
  if (!tbody) return;

  const filtered = filter
    ? items.filter(it => (it.fail_reason || it.reason || '') === filter)
    : items;

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted center" style="padding:32px">${items.length ? 'No matches for this filter' : 'No dead ends logged yet'}</td></tr>`;
    if (badge) badge.textContent = '0';
    return;
  }

  if (badge) badge.textContent = `${filtered.length}${filter ? ' / ' + items.length : ''}`;

  tbody.innerHTML = '';
  filtered.forEach(item => {
    const time = formatCallTime(item.created_at || item.ts || item.timestamp);
    const query = item.query || item.raw_query || item.query_text || '—';
    const zip = item.zip || item.zip_code || '—';
    const channel = (item.channel || '—').toLowerCase();
    const failReason = item.fail_reason || item.reason || 'unknown';
    const intentPath = item.intent_path || item.intent || item.attempted_intent || '—';

    const channelClass = ['web','twilio','voice'].includes(channel) ? `channel-${channel}` : '';
    const failClass = `fail-${failReason}`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(time)}</td>
      <td class="tx-query-cell">${esc(query)}</td>
      <td class="mono">${esc(zip)}</td>
      <td><span class="badge ${channelClass}">${esc(channel)}</span></td>
      <td><span class="badge ${failClass}">${esc(failReason)}</span></td>
      <td class="mono muted">${esc(intentPath)}</td>`;
    tbody.appendChild(tr);
  });
}

async function loadDeadEnds() {
  const tbody = document.getElementById('de-tbody');
  const badge = document.getElementById('de-count-badge');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="muted center">Loading…</td></tr>';
  if (badge) badge.textContent = '…';

  try {
    const r = await fetch(`${LI_BASE}/dead-ends?limit=100`, {
      headers: { 'x-admin-token': LI_ADMIN_TOKEN },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const items = Array.isArray(data) ? data : (data.dead_ends || data.deadEnds || data.items || []);
    _deadEndsCache = items;
    const filter = document.getElementById('de-filter')?.value || '';
    renderDeadEnds(items, filter);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted center" style="padding:24px;color:var(--red)">Error: ${esc(e.message)}</td></tr>`;
    if (badge) badge.textContent = 'error';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-item[data-section="transcripts"]').forEach(el => {
    el.addEventListener('click', () => setTimeout(loadTranscripts, 50));
  });
  document.querySelectorAll('.nav-item[data-section="deadends"]').forEach(el => {
    el.addEventListener('click', () => setTimeout(loadDeadEnds, 50));
  });
  document.getElementById('tx-refresh-btn')?.addEventListener('click', loadTranscripts);
  document.getElementById('de-refresh-btn')?.addEventListener('click', loadDeadEnds);
  document.getElementById('de-filter')?.addEventListener('change', () => {
    const filter = document.getElementById('de-filter').value;
    renderDeadEnds(_deadEndsCache, filter);
  });
});

// Test the labor_market_intel MCP tool live against ZIP 32082
async function testLaborMarket() {
  const outEl = document.getElementById('li-ces-test-output');
  const btn   = document.getElementById('li-ces-test-btn');
  if (!outEl || !btn) return;

  btn.disabled = true;
  btn.textContent = 'Fetching…';
  outEl.style.display = 'block';
  outEl.textContent = 'Calling /api/local-intel/labor-market/32082 …';

  try {
    const r = await fetch(`${LI_BASE}/labor-market/32082`, {
      headers: { 'x-admin-token': LI_ADMIN_TOKEN },
    });
    const data = await r.json();
    if (data.error) {
      outEl.textContent = 'Error: ' + data.error + (data.hint ? '\nHint: ' + data.hint : '');
      outEl.style.color = '#f87171';
    } else {
      outEl.textContent = JSON.stringify(data, null, 2);
      outEl.style.color = '#a3e635';
    }
  } catch (e) {
    outEl.textContent = 'Error: ' + e.message;
    outEl.style.color = '#f87171';
  } finally {
    btn.disabled = false;
    btn.textContent = 'TEST ZIP 32082';
  }
}
