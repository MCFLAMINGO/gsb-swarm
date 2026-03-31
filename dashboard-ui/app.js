// GSB Intelligence Dashboard — Client
const API_BASE = '__PORT_8080__'.startsWith('__') ? 'http://localhost:8080' : '__PORT_8080__';
const WS_BASE  = API_BASE.replace(/^http/, 'ws');

// ── State ─────────────────────────────────────────────────────────────────────
let latestBrief  = null;
let jobCount     = 0;
let ws           = null;
let currentThread = '';
let acpReady     = false;
let workers      = [];

// ── Boot ──────────────────────────────────────────────────────────────────────
(async function init() {
  await loadWorkers();
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
  const cmdBtn = document.getElementById('cmd-send');
  const cmdIn  = document.getElementById('cmd-input');
  dot.className   = 'dot ' + (acpReady ? 'connected' : 'error');
  label.textContent = acpReady ? 'CEO wallet ready' : (data.error ? 'Wallet error' : 'Initializing…');
  btn.disabled    = !acpReady;
  btn.textContent = acpReady ? 'Fire Job →' : 'Waiting for wallet…';
  cmdBtn.disabled = !acpReady;
  cmdIn.disabled  = !acpReady;
  cmdIn.placeholder = acpReady
    ? 'Tell the agents what to do — e.g. "analyze $GSB token and write a thread"'
    : 'Waiting for CEO wallet…';
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
  if (!acpReady) return;

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
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ worker: workerName, requirement }),
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
  btn.addEventListener('click', () => {
    const sel = document.getElementById('fire-worker');
    const ta  = document.getElementById('fire-requirement');
    sel.value = btn.dataset.worker;
    ta.value  = btn.dataset.req;
    ta.dataset.edited = '1';
    // Scroll to fire button
    document.getElementById('fire-btn').scrollIntoView({ behavior: 'smooth' });
  });
});

// ── Graduation buttons ────────────────────────────────────────────────────────
document.querySelectorAll('.btn-grad').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!acpReady || btn.disabled) return;
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
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ worker: workerName, requirement: worker.defaultReq }),
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
  if (!text || !acpReady) return;

  // Echo user command into history
  addCmdMsg('user', `> ${text}`);
  cmdInput.value = '';

  // Disable while firing
  cmdSend.disabled = true;
  cmdInput.disabled = true;

  try {
    const r = await fetch(`${API_BASE}/api/command`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
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
  header.innerHTML = '&#9670; CEO INTELLIGENCE BRIEF';

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
  if (!hintShown && acpReady) {
    hintShown = true;
    addCmdMsg('info', 'Try: "analyze $GSB token" · "profile wallet 0x…" · "scan for alpha" · "write a thread" · "run full brief"');
  }
});
