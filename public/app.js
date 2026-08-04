// NFT Minter Panel — Frontend Logic

const socket = io();
let currentJobId = null;

// ─── Socket.IO ───

socket.on('connect', () => {
  document.getElementById('server-status').textContent = 'Connected';
});

socket.on('disconnect', () => {
  document.getElementById('server-status').textContent = 'Disconnected';
});

socket.on('log', ({ id, line }) => {
  // Feed to console (existing)
  appendLog(line, id);
  // Feed to logs tab
  const cleanLine = line.replace(/^\[[\d:]+\]\s*/, '');
  addLogEntry(id ? `job:${id}` : 'system', cleanLine);
});

socket.on('status', (data) => {
  if (data.id === currentJobId) {
    updateJobStatus(data);
  }
  // Refresh jobs list periodically
  refreshJobs();
});

// ─── Tab navigation ───

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

    // Load job logs when jobs/logs tab is opened
    if (tab.dataset.tab === 'jobs' || tab.dataset.tab === 'logs') {
      loadJobLogs();
    }
  });
});

// ─── Init ───

async function init() {
  await loadChains();
  await loadWallets();
  await loadConfig();
  await refreshJobs();
}

async function api(method, path, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`/api${path}`, opts);
  if (r.status === 401) {
    window.location.href = '/login.html';
    return { error: 'unauthorized' };
  }
  return r.json();
}

// ─── Chains ───

async function loadChains() {
  const chains = await api('GET', '/chains');
  const chainIds = {};
  chains.forEach(c => chainIds[c.name] = c.id);

  // Populate dropdowns
  for (const selectId of ['mint-chain', 'mass-chain']) {
    const select = document.getElementById(selectId);
    const current = select.value;
    select.innerHTML = '';
    for (const chain of chains) {
      select.appendChild(new Option(`${chain.name} (${chain.id})`, chain.name));
    }
    if (current && chainIds[current]) select.value = current;
    else if (chains.find(c => c.name === 'robinhood')) select.value = 'robinhood';
  }

  // Populate chains table
  const tbody = document.querySelector('#chains-table tbody');
  if (tbody) {
    tbody.innerHTML = '';
    for (const chain of chains) {
      const tr = document.createElement('tr');
      const rpcDisplay = chain.rpc.length > 40 ? chain.rpc.slice(0, 37) + '...' : chain.rpc;
      const isPrivate = chain.rpc.includes('alchemy') || chain.rpc.includes('infura') || chain.rpc.includes('quicknode') || chain.rpc.includes('QN_');
      tr.innerHTML = `
        <td><strong>${chain.name}</strong>${chain.native ? ' <span class="badge-native">native</span>' : ''}</td>
        <td>${chain.id}</td>
        <td title="${chain.rpc}">${rpcDisplay}${isPrivate ? ' 🔒' : ''}</td>
        <td>${chain.explorer ? chain.explorer.slice(0, 30) + '...' : '—'}</td>
        <td>${chain.seadrop ? chain.seadrop.slice(0, 10) + '...' : '—'}</td>
        <td>
          ${!chain.native ? `<button class="btn btn-sm btn-danger" onclick="deleteChain('${chain.name}')">🗑</button>` : ''}
          <button class="btn btn-sm btn-secondary" onclick="testChainRpc('${chain.rpc}')">🔌</button>
        </td>
      `;
      tbody.appendChild(tr);
    }
  }
}

// ─── Chain Management ───

window.deleteChain = async function(name) {
  const data = await api('DELETE', `/chains/${name}`);
  if (data.error) return alert(data.error);
  await loadChains();
  appendLog(`[CHAIN] Deleted ${name}`);
};

window.testChainRpc = async function(rpc) {
  await testRpc(rpc);
};

async function testRpc(rpc) {
  const result = document.getElementById('chain-test-result');
  result.innerHTML = '<span style="color:var(--text-dim)">Testing...</span>';
  result.classList.remove('hidden');

  const data = await api('POST', '/chains/test', { rpc });
  if (data.status === 'ok') {
    result.innerHTML = `
      <div style="color:var(--success)">✅ RPC Connected!</div>
      <div class="stat">Chain ID: <strong>${data.chainId}</strong></div>
      <div class="stat">Block: <strong>${data.blockNumber.toLocaleString()}</strong></div>
      <div class="stat">ENS: <strong>${data.ens || 'N/A'}</strong></div>
    `;
    return data;
  } else {
    result.innerHTML = `<span style="color:var(--danger)">❌ ${data.error}</span>`;
    return null;
  }
}

document.getElementById('chain-test').addEventListener('click', async () => {
  const rpc = document.getElementById('chain-rpc').value.trim();
  if (!rpc) return alert('Enter RPC URL first');
  await testRpc(rpc);
});

document.getElementById('chain-add').addEventListener('click', async () => {
  const name = document.getElementById('chain-name').value.trim();
  const id = document.getElementById('chain-id').value;
  const rpc = document.getElementById('chain-rpc').value.trim();
  const explorer = document.getElementById('chain-explorer').value.trim();
  const seadrop = document.getElementById('chain-seadrop').value.trim();

  if (!name || !id || !rpc) return alert('Name, ID, and RPC are required');

  const data = await api('POST', '/chains', { name, id, rpc, explorer, seadrop });
  if (data.error) return alert(data.error);

  // Clear form
  document.getElementById('chain-name').value = '';
  document.getElementById('chain-id').value = '';
  document.getElementById('chain-rpc').value = '';
  document.getElementById('chain-explorer').value = '';
  document.getElementById('chain-seadrop').value = '';

  await loadChains();
  appendLog(`[CHAIN] Added ${name} (ID: ${id})`);
  alert(`Chain "${name}" added!`);
});

// ─── Wallets ───

async function loadWallets() {
  const wallets = await api('GET', '/wallets');
  document.getElementById('wallet-count').textContent = `${wallets.length || 0} wallets`;

  // Mint wallet selector
  const mintSelect = document.getElementById('mint-wallet');
  mintSelect.innerHTML = '';
  wallets.forEach(w => {
    mintSelect.appendChild(new Option(`${w.address.slice(0, 8)}...${w.address.slice(-4)}`, w.index - 1));
  });

  // Mass mint checkboxes
  const massList = document.getElementById('mass-wallets');
  massList.innerHTML = '';
  wallets.forEach(w => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = w.index - 1;
    cb.checked = true;
    label.appendChild(cb);
    label.append(` #${w.index} ${w.address.slice(0, 10)}...${w.address.slice(-6)}`);
    massList.appendChild(label);
  });

  // Wallets table
  const tbody = document.querySelector('#wallets-table tbody');
  tbody.innerHTML = '';
  wallets.forEach(w => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${w.index}</td>
      <td>${w.address}</td>
      <td id="bal-${w.address}">—</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteWallet(${w.index}, '${w.address}')">🗑</button></td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('wallet-refresh').addEventListener('click', loadWallets);

window.deleteWallet = async function(index, address) {
  const data = await api('DELETE', `/wallets/${address}`);
  if (data.error) return alert(data.error);
  appendLog(`[WALLET] Deleted #${index} (${address.slice(0, 10)}...). Total: ${data.total}`);
  await loadWallets();
};

document.getElementById('wallet-generate').addEventListener('click', async () => {
  const count = parseInt(document.getElementById('wallet-gen-count').value);
  if (!count || count < 1) return alert('Enter valid count (1-100)');

  const btn = document.getElementById('wallet-generate');
  btn.disabled = true;
  btn.textContent = '⏳ Generating...';

  const result = await api('POST', '/wallets/generate', { count });
  const panel = document.getElementById('wallet-gen-result');

  if (result.error) {
    panel.innerHTML = `<span style="color:var(--danger)">❌ ${result.error}</span>`;
  } else {
    let html = `<div style="color:var(--success)">✅ Generated ${result.generated} wallet(s) — Total: ${result.total}</div>`;
    html += '<div class="table-wrap" style="margin-top:8px"><table style="font-size:0.8rem"><thead><tr><th>#</th><th>Address</th></tr></thead><tbody>';
    for (const w of result.newWallets) {
      html += `<tr><td>${w.index}</td><td>${w.address}</td></tr>`;
    }
    html += '</tbody></table></div>';
    panel.innerHTML = html;
    appendLog(`[WALLET] Generated ${result.generated} wallets. Total: ${result.total}`);
    await loadWallets(); // Refresh wallet list
  }

  panel.classList.remove('hidden');
  btn.disabled = false;
  btn.textContent = '⚡ Generate Wallets';
});

document.getElementById('wallet-check-all').addEventListener('click', async () => {
  const wallets = await api('GET', '/wallets');
  for (const w of wallets) {
    const data = await api('GET', `/wallet/${w.address}`);
    const cell = document.getElementById(`bal-${w.address}`);
    if (cell) {
      const chains = Object.entries(data.balances)
        .filter(([_, v]) => v.balance && parseFloat(v.balance) > 0)
        .map(([chain, v]) => `<span class="balance-chip has">${chain}: ${parseFloat(v.balance).toFixed(4)}</span>`);
      const zeroChains = Object.entries(data.balances)
        .filter(([_, v]) => v.balance && parseFloat(v.balance) === 0)
        .map(([chain]) => `<span class="balance-chip zero">${chain}: 0</span>`);
      cell.innerHTML = `<div class="balance-row">${chains.join('')}${zeroChains.join('')}</div>`;
    }
  }
});

// ─── Resolve ───

document.getElementById('mint-resolve').addEventListener('click', async () => {
  const input = document.getElementById('mint-input').value.trim();
  if (!input) return;
  const data = await api('POST', '/resolve', { input });
  const info = document.getElementById('mint-resolve-info');
  if (data.error) {
    info.innerHTML = `<span style="color:var(--danger)">❌ ${data.error}</span>`;
  } else {
    document.getElementById('mint-chain').value = data.chain;
    info.innerHTML = `
      <h3>📍 Resolved</h3>
      <div class="stat">Contract: <strong>${data.contract}</strong></div>
      <div class="stat">Chain: <strong>${data.chain}</strong></div>
      ${data.name ? `<div class="stat">Collection: <strong>${data.name}</strong></div>` : ''}
      ${data.totalSupply !== undefined ? `<div class="stat">Total Supply: <strong>${data.totalSupply}</strong></div>` : ''}
    `;
  }
  info.classList.remove('hidden');
});

// ─── Mint ───

async function doMint(dryRun) {
  const input = document.getElementById('mint-input').value.trim();
  const chain = document.getElementById('mint-chain').value;
  const amount = parseInt(document.getElementById('mint-amount').value);
  const walletIndex = parseInt(document.getElementById('mint-wallet').value);

  if (!input) return alert('Enter URL or contract address');

  const btn = dryRun ? document.getElementById('mint-dryrun') : document.getElementById('mint-execute');
  btn.disabled = true;
  showConsole();

  const data = await api('POST', '/mint', { input, chain, amount, walletIndex, dryRun });
  if (data.error) {
    appendLog(`[ERROR] ${data.error}`);
    btn.disabled = false;
    return;
  }

  currentJobId = data.jobId;
  appendLog(`[JOB] ${data.jobId} — ${dryRun ? 'dry-run' : 'execute'} mint on ${chain}`);
}

document.getElementById('mint-dryrun').addEventListener('click', () => doMint(true));
document.getElementById('mint-execute').addEventListener('click', () => doMint(false));

// ─── Mass mint ───

document.getElementById('mass-select-all').addEventListener('click', () => {
  document.querySelectorAll('#mass-wallets input[type="checkbox"]').forEach(cb => cb.checked = true);
});

document.getElementById('mass-select-none').addEventListener('click', () => {
  document.querySelectorAll('#mass-wallets input[type="checkbox"]').forEach(cb => cb.checked = false);
});

document.getElementById('mass-execute').addEventListener('click', async () => {
  const input = document.getElementById('mass-input').value.trim();
  const chain = document.getElementById('mass-chain').value;
  const amount = parseInt(document.getElementById('mass-amount').value);
  const concurrent = parseInt(document.getElementById('mass-concurrent').value);
  const walletIndices = Array.from(document.querySelectorAll('#mass-wallets input[type="checkbox"]:checked'))
    .map(cb => parseInt(cb.value));

  if (!input) return alert('Enter URL or contract address');
  if (walletIndices.length === 0) return alert('Select at least one wallet');

  const btn = document.getElementById('mass-execute');
  btn.disabled = true;
  showConsole();

  const data = await api('POST', '/mass-mint', { input, chain, amount, walletIndices, maxConcurrent: concurrent });
  if (data.error) {
    appendLog(`[ERROR] ${data.error}`);
    btn.disabled = false;
    return;
  }

  currentJobId = data.jobId;
  appendLog(`[JOB] ${data.jobId} — mass mint ${walletIndices.length} wallets × ${amount} on ${chain}`);
});

// ─── Config ───

async function loadConfig() {
  const config = await api('GET', '/config');
  const form = document.getElementById('config-form');
  form.innerHTML = '';

  for (const [key, value] of Object.entries(config)) {
    const div = document.createElement('div');
    div.className = 'config-item';
    div.innerHTML = `<label>${key}</label><input type="text" id="cfg-${key}" value="${value}">`;
    form.appendChild(div);
  }
}

document.getElementById('config-save').addEventListener('click', async () => {
  const inputs = document.querySelectorAll('[id^="cfg-"]');
  const config = {};
  inputs.forEach(inp => {
    const key = inp.id.replace('cfg-', '');
    config[key] = inp.value;
  });
  const data = await api('POST', '/config', { config });
  alert(data.status === 'ok' ? 'Saved!' : 'Error: ' + data.error);
});

// ─── Jobs ───

async function refreshJobs() {
  const jobs = await api('GET', '/jobs');
  const list = document.getElementById('jobs-list');
  list.innerHTML = '';

  for (const job of jobs) {
    const card = document.createElement('div');
    card.className = 'job-card';
    const typeIcon = job.type === 'mass-mint' ? '👥' : '🎨';
    const time = new Date(job.createdAt).toLocaleTimeString();
    card.innerHTML = `
      <div class="job-header">
        <span>${typeIcon} ${job.type} — ${time}</span>
        <span class="job-status ${job.status}">${job.status.toUpperCase()}</span>
      </div>
      <div class="stat">Job ID: ${job.id}</div>
      ${job.result ? `<div class="stat">Result: <code>${JSON.stringify(job.result).slice(0, 200)}</code></div>` : ''}
      ${job.error ? `<div class="stat" style="color:var(--danger)">Error: ${job.error}</div>` : ''}
      <details><summary>Logs (${job.logs.length})</summary>
        <pre style="font-size:0.8rem;margin-top:8px;white-space:pre-wrap">${job.logs.join('\n')}</pre>
      </details>
    `;
    list.appendChild(card);
  }
}

document.getElementById('jobs-refresh').addEventListener('click', refreshJobs);

// ─── Logs Tab ───

const allLogs = []; // { time, source, message, level }
let logsAutoScroll = true;

function addLogEntry(source, message, level = '') {
  const entry = {
    time: new Date().toISOString().slice(11, 19),
    source: source || 'system',
    message,
    level: level || (message.includes('❌') || message.includes('[FAIL]') || message.includes('[ERROR]') ? 'error' :
           message.includes('✅') || message.includes('[OK]') || message.includes('[DONE]') ? 'success' :
           message.includes('[WARN]') || message.includes('[SIM]') ? 'warn' : ''),
  };
  allLogs.push(entry);

  // Keep max 1000 entries
  if (allLogs.length > 1000) allLogs.splice(0, 100);

  renderLogEntry(entry);
}

function renderLogEntry(entry) {
  const output = document.getElementById('logs-output');
  if (!output) return;

  // Apply filter
  const filter = document.getElementById('logs-filter')?.value?.toLowerCase() || '';
  const sourceFilter = document.getElementById('logs-source')?.value || 'all';

  if (filter && !entry.message.toLowerCase().includes(filter)) return;
  if (sourceFilter !== 'all' && entry.source !== sourceFilter) return;

  const div = document.createElement('div');
  div.className = `log-line ${entry.level}`;
  div.innerHTML = `
    <span class="log-time">${entry.time}</span>
    <span class="log-source">[${entry.source}]</span>
    <span class="log-message">${entry.message}</span>
  `;
  output.appendChild(div);

  if (logsAutoScroll) {
    output.scrollTop = output.scrollHeight;
  }
}

function renderAllLogs() {
  const output = document.getElementById('logs-output');
  if (!output) return;
  output.innerHTML = '';

  const filter = document.getElementById('logs-filter')?.value?.toLowerCase() || '';
  const sourceFilter = document.getElementById('logs-source')?.value || 'all';

  for (const entry of allLogs) {
    if (filter && !entry.message.toLowerCase().includes(filter)) continue;
    if (sourceFilter !== 'all' && entry.source !== sourceFilter) continue;

    const div = document.createElement('div');
    div.className = `log-line ${entry.level}`;
    div.innerHTML = `
      <span class="log-time">${entry.time}</span>
      <span class="log-source">[${entry.source}]</span>
      <span class="log-message">${entry.message}</span>
    `;
    output.appendChild(div);
  }

  if (logsAutoScroll) output.scrollTop = output.scrollHeight;
}

document.getElementById('logs-filter').addEventListener('input', renderAllLogs);
document.getElementById('logs-source').addEventListener('change', renderAllLogs);

document.getElementById('logs-clear').addEventListener('click', () => {
  allLogs.length = 0;
  document.getElementById('logs-output').innerHTML = '';
});

document.getElementById('logs-download').addEventListener('click', () => {
  const text = allLogs.map(e => `${e.time} [${e.source}] ${e.message}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nft-minter-logs-${new Date().toISOString().slice(0, 19)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

// Auto-load job logs when jobs tab is opened
async function loadJobLogs() {
  const jobs = await api('GET', '/jobs');
  for (const job of jobs) {
    for (const line of job.logs) {
      // Parse job log lines into entries
      const cleanLine = line.replace(/^\[[\d:]+\]\s*/, '');
      if (!allLogs.some(e => e.message === cleanLine && e.source === `job:${job.id}`)) {
        addLogEntry(`job:${job.id}`, cleanLine);
      }
    }
  }
}

// Auto-scroll toggle: pause when user scrolls up, resume when scrolled to bottom
document.getElementById('logs-output')?.addEventListener('scroll', () => {
  const el = document.getElementById('logs-output');
  const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  logsAutoScroll = isAtBottom;
});

// ─── Console ───

function showConsole() {
  document.getElementById('console-panel').classList.remove('hidden');
}

function appendLog(line, jobId = null) {
  const output = document.getElementById('console-output');
  const div = document.createElement('div');
  div.className = 'log-line';
  if (line.includes('✅') || line.includes('[OK]') || line.includes('[DONE]')) div.classList.add('success');
  if (line.includes('❌') || line.includes('[FAIL]') || line.includes('[ERROR]')) div.classList.add('error');
  if (line.includes('[WARN]') || line.includes('[SIM]')) div.classList.add('warn');
  div.textContent = line;
  output.appendChild(div);
  output.scrollTop = output.scrollHeight;
}

document.getElementById('console-clear').addEventListener('click', () => {
  document.getElementById('console-output').innerHTML = '';
});

document.getElementById('console-toggle').addEventListener('click', () => {
  const output = document.getElementById('console-output');
  const header = document.querySelector('.console-header span');
  if (output.style.display === 'none') {
    output.style.display = 'block';
    document.getElementById('console-toggle').textContent = '−';
  } else {
    output.style.display = 'none';
    document.getElementById('console-toggle').textContent = '+';
  }
});

function updateJobStatus(data) {
  if (data.status === 'completed') {
    appendLog('[DONE] Job completed');
  } else if (data.status === 'failed') {
    appendLog(`[FAIL] ${data.error || 'Job failed'}`);
  }
  // Re-enable buttons
  document.querySelectorAll('.btn').forEach(b => b.disabled = false);
}

// ─── Start ───

// Auth: check status and show logout if enabled
async function checkAuth() {
  const r = await fetch('/api/auth/status');
  const data = await r.json();
  if (data.enabled) {
    document.getElementById('logout-btn').style.display = 'inline-flex';
    // Show change password form in Config
    const section = document.getElementById('auth-section');
    section.innerHTML = '<div class="info-panel" style="color:var(--success)">✅ Password protection enabled</div>';
    document.getElementById('change-password-form').classList.remove('hidden');
  } else {
    document.getElementById('logout-btn').style.display = 'none';
    const section = document.getElementById('auth-section');
    section.innerHTML = '<div class="info-panel" style="color:var(--warning)">⚠️ No password set — panel is open. Set password via login page.</div>';
  }
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

document.getElementById('change-password-btn').addEventListener('click', async () => {
  const oldPw = document.getElementById('old-password').value;
  const newPw = document.getElementById('new-password').value;
  const confirmPw = document.getElementById('confirm-password').value;

  if (!oldPw || !newPw) return alert('Fill all fields');
  if (newPw.length < 1) return alert('Password must be at least 1 character');
  if (newPw !== confirmPw) return alert('Passwords do not match');

  const r = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
  });
  const data = await r.json();

  if (data.status === 'ok') {
    alert('Password changed!');
    document.getElementById('old-password').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-password').value = '';
  } else {
    alert('Error: ' + data.error);
  }
});

checkAuth();
init();
