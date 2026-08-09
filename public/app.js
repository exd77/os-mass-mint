// NFT Minter Panel — Frontend Logic

const socket = io();
let currentJobId = null;
const dashboardState = { wallets: [], chains: [], jobs: [], range: 14 };

const INTERACTIVE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setButtonBusy(button, busy, busyLabel = 'Working…') {
  if (!button) return;
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent.trim();
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.classList.toggle('is-loading', busy);
  button.textContent = busy ? busyLabel : button.dataset.defaultLabel;
}

function setPanelState(panel, message, state = 'info') {
  if (!panel) return;
  panel.textContent = message;
  panel.classList.remove('hidden', 'is-error', 'is-success', 'is-loading');
  panel.classList.add(`is-${state}`);
  panel.setAttribute('role', state === 'error' ? 'alert' : 'status');
}

function setFieldValidity(input, message = '') {
  if (!input) return;
  input.setAttribute('aria-invalid', message ? 'true' : 'false');

  const describedIds = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  const helper = describedIds.map(id => document.getElementById(id)).find(Boolean);
  if (helper) {
    if (!helper.dataset.defaultMessage) helper.dataset.defaultMessage = helper.textContent;
    helper.textContent = message || helper.dataset.defaultMessage;
    helper.classList.toggle('field-error', Boolean(message));
  }

  if (message) input.focus();
}


function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch (_) {
    return false;
  }
}

function isValidEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

function syncBodyScrollLock() {
  const sidebarOpen = document.getElementById('sidebar')?.classList.contains('open');
  const modalOpen = Boolean(document.querySelector('.modal:not(.hidden)'));
  document.body.classList.toggle('scroll-locked', Boolean(sidebarOpen || modalOpen));
}


function setTableLoading(selector, columnCount, message) {
  const tbody = document.querySelector(`${selector} tbody`);
  if (!tbody) return;
  tbody.replaceChildren();
  const row = document.createElement('tr');
  row.className = 'table-empty-row table-loading-row';
  const cell = document.createElement('td');
  cell.colSpan = columnCount;
  cell.textContent = message;
  row.appendChild(cell);
  tbody.appendChild(row);
  tbody.closest('table')?.setAttribute('aria-busy', 'true');
}

function finishTableLoading(tbody) {
  tbody?.closest('table')?.setAttribute('aria-busy', 'false');
}

function isRobinhoodChain(chain) {
  return /robinhood/i.test(String(chain?.name || ''));
}

function preferredChainName(chains, current = '') {
  if (current && chains.some(chain => chain.name === current)) return current;
  return chains.find(isRobinhoodChain)?.name || chains[0]?.name || '';
}

function updateDashboardChainBadge() {
  const select = document.getElementById('dashboard-mint-chain');
  const icon = document.getElementById('dashboard-chain-icon');
  const label = document.getElementById('dashboard-chain-label');
  const trigger = document.getElementById('dashboard-chain-trigger');
  if (!select || !icon || !label || !trigger) return;

  const selected = dashboardState.chains.find(chain => chain.name === select.value);
  const name = String(selected?.name || select.value || 'Select chain');
  icon.textContent = selected && isRobinhoodChain(selected) ? 'R' : (selected ? name.slice(0, 1).toUpperCase() : 'N');
  icon.title = selected ? `${selected.name} · Chain ID ${selected.id}` : 'Network';
  label.textContent = selected && isRobinhoodChain(selected) ? 'Robinhood' : name;
  trigger.disabled = select.disabled || dashboardState.chains.length === 0;
  trigger.setAttribute('aria-label', selected ? `Network: ${selected.name}. Open network selector` : 'Select a network');
}

function updateDashboardWalletBadge() {
  const select = document.getElementById('dashboard-mint-wallet');
  const label = document.getElementById('dashboard-wallet-label');
  const display = document.getElementById('dashboard-wallet-display');
  const trigger = document.getElementById('dashboard-wallet-trigger');
  if (!select || !label || !display || !trigger) return;

  const walletIndex = Number.parseInt(select.value, 10);
  const selected = dashboardState.wallets.find(wallet => wallet.index - 1 === walletIndex);

  if (selected) {
    const address = String(selected.address || '');
    const short = address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;
    label.textContent = `Wallet #${selected.index}`;
    display.textContent = `Wallet #${selected.index} · ${short}`;
    display.classList.remove('is-placeholder');
    trigger.setAttribute('aria-label', `Execution wallet ${selected.index}. Open wallet selector`);
  } else {
    label.textContent = 'Wallets';
    display.textContent = dashboardState.wallets.length ? 'Select wallets' : 'No wallets configured';
    display.classList.add('is-placeholder');
    trigger.setAttribute('aria-label', 'Select execution wallets');
  }

  const walletSelectorDisabled = select.disabled || dashboardState.wallets.length === 0;
  trigger.disabled = walletSelectorDisabled;
  display.disabled = walletSelectorDisabled;
  display.setAttribute('aria-label', dashboardState.wallets.length
    ? `${display.textContent}. Open wallet selector`
    : 'No wallets configured');
}


const mintSelectorModal = document.getElementById('mint-selector-modal');
const mintSelectorCard = mintSelectorModal?.querySelector('.mint-selector-card');
const mintSelectorTitle = document.getElementById('mint-selector-title');
const mintSelectorDescription = document.getElementById('mint-selector-description');
const mintSelectorSearch = document.getElementById('mint-selector-search-input');
const mintSelectorOptions = document.getElementById('mint-selector-options');
const mintSelectorEmpty = document.getElementById('mint-selector-empty');
let mintSelectorType = '';
let mintSelectorReturnFocus = null;

function getMintSelectorItems(type) {
  if (type === 'chain') {
    return dashboardState.chains.map(chain => ({
      value: chain.name,
      label: isRobinhoodChain(chain) ? 'Robinhood' : chain.name,
      subtitle: `Chain ID ${chain.id}`,
      icon: isRobinhoodChain(chain) ? 'R' : String(chain.name || 'N').slice(0, 1).toUpperCase(),
      keywords: `${chain.name} ${chain.id}`,
    }));
  }

  const items = dashboardState.wallets.map(wallet => {
    const address = String(wallet.address || '');
    const short = address.length > 20 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address;
    return {
      value: String(wallet.index - 1),
      label: `Wallet #${wallet.index}`,
      subtitle: short,
      icon: String(wallet.index),
      keywords: `${wallet.index} ${address}`,
    };
  });

  return items;
}

function currentMintSelectorValue() {
  const selectId = mintSelectorType === 'chain' ? 'dashboard-mint-chain' : 'dashboard-mint-wallet';
  return document.getElementById(selectId)?.value || '';
}

function visibleMintSelectorRows() {
  return [...(mintSelectorOptions?.querySelectorAll('.mint-selector-option') || [])]
    .filter(row => !row.hidden);
}

function renderMintSelectorOptions(query = '') {
  if (!mintSelectorOptions || !mintSelectorEmpty) return;
  const selectedValue = currentMintSelectorValue();
  const normalized = query.trim().toLowerCase();
  const allItems = getMintSelectorItems(mintSelectorType);
  const items = allItems.filter(item => {
    const haystack = `${item.label} ${item.subtitle} ${item.keywords}`.toLowerCase();
    return !normalized || haystack.includes(normalized);
  });

  mintSelectorOptions.replaceChildren();
  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mint-selector-option';
    row.dataset.value = item.value;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(item.value === selectedValue));
    row.tabIndex = item.value === selectedValue ? 0 : -1;

    const icon = document.createElement('span');
    icon.className = `mint-selector-option-icon ${mintSelectorType}`;
    icon.textContent = item.icon;
    icon.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('span');
    copy.className = 'mint-selector-option-copy';
    const strong = document.createElement('strong');
    strong.textContent = item.label;
    const small = document.createElement('small');
    small.textContent = item.subtitle;
    copy.append(strong, small);

    const check = document.createElement('span');
    check.className = 'mint-selector-check';
    check.textContent = item.value === selectedValue ? '✓' : '';
    check.setAttribute('aria-hidden', 'true');

    row.append(icon, copy, check);
    mintSelectorOptions.appendChild(row);
  }

  const rows = visibleMintSelectorRows();
  if (rows.length && !rows.some(row => row.tabIndex === 0)) rows[0].tabIndex = 0;
  mintSelectorEmpty.hidden = rows.length > 0;
  mintSelectorOptions.hidden = rows.length === 0;
  if (!rows.length) {
    const resource = mintSelectorType === 'chain' ? 'networks' : 'wallets';
    mintSelectorEmpty.textContent = allItems.length
      ? `No matching ${resource}.`
      : `No ${resource} configured.`;
  }
}

function setMintSelectorOpen(open, type = mintSelectorType) {
  if (!mintSelectorModal || !mintSelectorSearch) return;
  if (open) {
    mintSelectorType = type;
    mintSelectorReturnFocus = document.activeElement;
    const isChain = type === 'chain';
    mintSelectorTitle.textContent = isChain ? 'Select network' : 'Select execution wallets';
    mintSelectorDescription.textContent = isChain
      ? 'Choose the network used to resolve and mint the collection.'
      : 'Choose one wallet or run the mint in parallel.';
    mintSelectorSearch.placeholder = isChain ? 'Search networks' : 'Search wallets or addresses';
    mintSelectorSearch.value = '';
    renderMintSelectorOptions();
  }

  mintSelectorModal.classList.toggle('hidden', !open);
  mintSelectorModal.setAttribute('aria-hidden', String(!open));
  document.getElementById('dashboard-chain-trigger')?.setAttribute('aria-expanded', String(open && mintSelectorType === 'chain'));
  document.getElementById('dashboard-wallet-trigger')?.setAttribute('aria-expanded', String(open && mintSelectorType === 'wallet'));
  document.getElementById('dashboard-wallet-display')?.setAttribute('aria-expanded', String(open && mintSelectorType === 'wallet'));
  syncBodyScrollLock();

  if (open) {
    requestAnimationFrame(() => mintSelectorSearch.focus());
  } else {
    mintSelectorSearch.value = '';
    if (mintSelectorReturnFocus instanceof HTMLElement) mintSelectorReturnFocus.focus();
    mintSelectorReturnFocus = null;
    mintSelectorType = '';
  }
}

function selectMintSelectorValue(value) {
  const selectId = mintSelectorType === 'chain' ? 'dashboard-mint-chain' : 'dashboard-mint-wallet';
  const select = document.getElementById(selectId);
  if (!select || ![...select.options].some(option => option.value === value)) return;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  setMintSelectorOpen(false);
}

function moveMintSelectorFocus(direction) {
  const rows = visibleMintSelectorRows();
  if (!rows.length) return;
  const currentIndex = rows.indexOf(document.activeElement);
  const nextIndex = currentIndex < 0
    ? (direction > 0 ? 0 : rows.length - 1)
    : (currentIndex + direction + rows.length) % rows.length;
  rows.forEach((row, index) => { row.tabIndex = index === nextIndex ? 0 : -1; });
  rows[nextIndex].focus();
}

function isMintSelectorOpen() {
  return Boolean(mintSelectorModal && !mintSelectorModal.classList.contains('hidden'));
}

function syncDashboardSelectorTriggers() {
  updateDashboardChainBadge();
  updateDashboardWalletBadge();
}

mintSelectorSearch?.addEventListener('input', event => renderMintSelectorOptions(event.target.value));
mintSelectorSearch?.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveMintSelectorFocus(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveMintSelectorFocus(-1);
  } else if (event.key === 'Enter') {
    const first = visibleMintSelectorRows()[0];
    if (first) {
      event.preventDefault();
      selectMintSelectorValue(first.dataset.value);
    }
  }
});

mintSelectorOptions?.addEventListener('click', event => {
  const row = event.target.closest('.mint-selector-option');
  if (row) selectMintSelectorValue(row.dataset.value);
});
mintSelectorOptions?.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveMintSelectorFocus(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveMintSelectorFocus(-1);
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const rows = visibleMintSelectorRows();
    const target = event.key === 'Home' ? rows[0] : rows.at(-1);
    if (target) {
      rows.forEach(row => { row.tabIndex = row === target ? 0 : -1; });
      target.focus();
    }
  } else if (event.key === 'Enter' || event.key === ' ') {
    const row = event.target.closest('.mint-selector-option');
    if (row) {
      event.preventDefault();
      selectMintSelectorValue(row.dataset.value);
    }
  }
});

document.getElementById('dashboard-chain-trigger')?.addEventListener('click', () => setMintSelectorOpen(true, 'chain'));
document.getElementById('dashboard-wallet-trigger')?.addEventListener('click', () => setMintSelectorOpen(true, 'wallet'));
document.getElementById('dashboard-wallet-display')?.addEventListener('click', () => setMintSelectorOpen(true, 'wallet'));
document.getElementById('mint-selector-close')?.addEventListener('click', () => setMintSelectorOpen(false));
mintSelectorModal?.querySelectorAll('[data-close-mint-selector]').forEach(control => {
  control.addEventListener('click', () => setMintSelectorOpen(false));
});

// ─── Socket.IO ───

socket.on('connect', () => {
  const serverStatus = document.getElementById('server-status');
  if (serverStatus) {
    serverStatus.textContent = 'Connected';
    serverStatus.classList.add('ok');
  }
  updateDashboardConnection(true);
});

socket.on('disconnect', () => {
  const serverStatus = document.getElementById('server-status');
  if (serverStatus) {
    serverStatus.textContent = 'Disconnected';
    serverStatus.classList.remove('ok');
  }
  updateDashboardConnection(false);
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
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('active');
      t.removeAttribute('aria-current');
    });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-current', 'page');
    document.getElementById(`tab-${tab.dataset.tab}`)?.classList.add('active');

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
  try {
    const r = await fetch(`/api${path}`, opts);
    if (r.status === 401) {
      window.location.href = '/login.html';
      return { error: 'unauthorized' };
    }
    const text = await r.text();
    try {
      const data = JSON.parse(text);
      if (!r.ok && !data.error) return { error: `Request failed (${r.status})` };
      return data;
    } catch {
      return { error: `Unexpected server response (${r.status})` };
    }
  } catch (e) {
    return { error: e.message || 'request failed' };
  }
}

// ─── Chains ───

async function loadChains() {
  setTableLoading('#chains-table', 6, 'Loading chains…');
  const raw = await api('GET', '/chains');
  const loadError = Array.isArray(raw) ? '' : (raw?.error || 'Unable to load chains.');
  const chains = Array.isArray(raw) ? raw : [];
  dashboardState.chains = chains;
  renderDashboardNetworks(chains);

  for (const selectId of ['mint-chain', 'mass-chain', 'dashboard-mint-chain']) {
    const select = document.getElementById(selectId);
    if (!select) continue;
    const current = select.value;
    select.replaceChildren();
    if (!chains.length) {
      select.appendChild(new Option(loadError ? 'Chains unavailable' : 'No chains configured', ''));
      select.disabled = true;
      continue;
    }
    select.disabled = false;
    for (const chain of chains) {
      const label = selectId === 'dashboard-mint-chain'
        ? (isRobinhoodChain(chain) ? 'Robinhood' : chain.name)
        : (isRobinhoodChain(chain) ? `Robinhood Chain (${chain.id})` : `${chain.name} (${chain.id})`);
      select.appendChild(new Option(label, chain.name));
    }
    select.value = preferredChainName(chains, current);
  }
  syncDashboardSelectorTriggers();
  const dashboardMintButton = document.getElementById('dashboard-mint-execute');
  if (dashboardMintButton && !dashboardMintButton.dataset.busy) {
    dashboardMintButton.disabled = chains.length === 0 || dashboardState.wallets.length === 0;
  }

  const tbody = document.querySelector('#chains-table tbody');
  if (!tbody) return;
  tbody.replaceChildren();
  finishTableLoading(tbody);

  if (!chains.length) {
    const row = document.createElement('tr');
    row.className = 'table-empty-row';
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.innerHTML = loadError
      ? '<strong>Chains could not be loaded.</strong><span>Check the server connection and try Refresh.</span>'
      : '<strong>No chains configured.</strong><span>Add a network above to enable minting.</span>';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  for (const chain of chains) {
    const row = document.createElement('tr');
    const rpc = String(chain.rpc || '');
    const explorer = String(chain.explorer || '');
    const seadrop = String(chain.seadrop || '');
    const isPrivate = /alchemy|infura|quicknode|QN_/i.test(rpc);

    const nameCell = document.createElement('td');
    const name = document.createElement('strong');
    name.textContent = chain.name;
    nameCell.appendChild(name);
    if (chain.native) {
      const native = document.createElement('span');
      native.className = 'badge-native';
      native.textContent = 'native';
      nameCell.appendChild(native);
    }

    const idCell = document.createElement('td');
    idCell.textContent = chain.id;

    const rpcCell = document.createElement('td');
    rpcCell.className = 'mono';
    rpcCell.title = rpc;
    rpcCell.textContent = rpc.length > 34 ? `${rpc.slice(0, 31)}…` : rpc;
    if (isPrivate) {
      const privateBadge = document.createElement('span');
      privateBadge.className = 'badge-native';
      privateBadge.textContent = 'private';
      rpcCell.append(' ', privateBadge);
    }

    const explorerCell = document.createElement('td');
    explorerCell.className = 'mono';
    explorerCell.textContent = explorer ? `${explorer.slice(0, 28)}${explorer.length > 28 ? '…' : ''}` : '—';
    explorerCell.title = explorer;

    const seadropCell = document.createElement('td');
    seadropCell.className = 'mono';
    seadropCell.textContent = seadrop ? `${seadrop.slice(0, 10)}${seadrop.length > 10 ? '…' : ''}` : '—';
    seadropCell.title = seadrop;

    const actionsCell = document.createElement('td');
    actionsCell.className = 'table-actions';
    if (!chain.native) {
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'btn btn-sm btn-outline-danger';
      deleteButton.textContent = 'Delete';
      deleteButton.addEventListener('click', () => deleteChain(chain.name));
      actionsCell.appendChild(deleteButton);
    }
    const testButton = document.createElement('button');
    testButton.type = 'button';
    testButton.className = 'btn btn-sm btn-secondary';
    testButton.textContent = 'Test';
    testButton.addEventListener('click', () => testChainRpc(rpc));
    actionsCell.appendChild(testButton);

    row.append(nameCell, idCell, rpcCell, explorerCell, seadropCell, actionsCell);
    tbody.appendChild(row);
  }
}

// ─── Chain Management ───

window.deleteChain = async function(name) {
  if (!window.confirm(`Delete the “${name}” chain configuration? This cannot be undone.`)) return;
  const data = await api('DELETE', `/chains/${encodeURIComponent(name)}`);
  if (data.error) {
    toast(data.error, 'error');
    return;
  }
  await loadChains();
  appendLog(`[CHAIN] Deleted ${name}`);
  toast(`Chain ${name} deleted`, 'success');
};

window.testChainRpc = async function(rpc) {
  await testRpc(rpc);
};

async function testRpc(rpc) {
  const result = document.getElementById('chain-test-result');
  setPanelState(result, 'Testing RPC connection…', 'loading');

  const data = await api('POST', '/chains/test', { rpc });
  if (data.status === 'ok') {
    result.classList.remove('is-loading', 'is-error');
    result.classList.add('is-success');
    result.setAttribute('role', 'status');
    result.innerHTML = `
      <strong>RPC connected</strong>
      <div class="stat">Chain ID: <strong>${escapeHtml(data.chainId)}</strong></div>
      <div class="stat">Block: <strong>${escapeHtml(Number(data.blockNumber || 0).toLocaleString())}</strong></div>
      <div class="stat">ENS: <strong>${escapeHtml(data.ens || 'N/A')}</strong></div>
    `;
    return data;
  }

  setPanelState(result, data.error || 'RPC connection failed.', 'error');
  return null;
}

document.getElementById('chain-test').addEventListener('click', async () => {
  const rpcInput = document.getElementById('chain-rpc');
  const rpc = rpcInput.value.trim();
  setFieldValidity(rpcInput);
  if (!rpc) {
    setFieldValidity(rpcInput, 'RPC URL is required');
    setPanelState(document.getElementById('chain-test-result'), 'Enter an RPC URL before testing.', 'error');
    return;
  }
  if (!isValidHttpUrl(rpc)) {
    setFieldValidity(rpcInput, 'RPC URL must begin with http:// or https://');
    setPanelState(document.getElementById('chain-test-result'), 'Enter a valid HTTP or HTTPS RPC URL.', 'error');
    return;
  }
  const button = document.getElementById('chain-test');
  setButtonBusy(button, true, 'Testing…');
  await testRpc(rpc);
  setButtonBusy(button, false);
});

document.getElementById('chain-add').addEventListener('click', async () => {
  const nameInput = document.getElementById('chain-name');
  const idInput = document.getElementById('chain-id');
  const rpcInput = document.getElementById('chain-rpc');
  const name = nameInput.value.trim();
  const id = idInput.value;
  const rpc = rpcInput.value.trim();
  const explorer = document.getElementById('chain-explorer').value.trim();
  const seadrop = document.getElementById('chain-seadrop').value.trim();
  const resultPanel = document.getElementById('chain-test-result');

  const explorerInput = document.getElementById('chain-explorer');
  const seadropInput = document.getElementById('chain-seadrop');
  [nameInput, idInput, rpcInput, explorerInput, seadropInput].forEach(input => setFieldValidity(input));
  const numericChainId = Number.parseInt(id, 10);
  if (!name || !id || !rpc) {
    if (!name) setFieldValidity(nameInput, 'Chain name is required');
    else if (!id) setFieldValidity(idInput, 'Chain ID is required');
    else setFieldValidity(rpcInput, 'RPC URL is required');
    setPanelState(resultPanel, 'Chain name, Chain ID, and RPC URL are required.', 'error');
    return;
  }
  if (!Number.isInteger(numericChainId) || numericChainId < 1) {
    setFieldValidity(idInput, 'Chain ID must be a positive integer');
    setPanelState(resultPanel, 'Enter a valid positive numeric Chain ID.', 'error');
    return;
  }
  if (!isValidHttpUrl(rpc)) {
    setFieldValidity(rpcInput, 'RPC URL must begin with http:// or https://');
    setPanelState(resultPanel, 'Enter a valid HTTP or HTTPS RPC URL.', 'error');
    return;
  }
  if (explorer && !isValidHttpUrl(explorer)) {
    setFieldValidity(explorerInput, 'Explorer URL must begin with http:// or https://');
    setPanelState(resultPanel, 'Enter a valid explorer URL or leave it blank.', 'error');
    return;
  }
  if (seadrop && !isValidEvmAddress(seadrop)) {
    setFieldValidity(seadropInput, 'SeaDrop must be a valid 0x contract address');
    setPanelState(resultPanel, 'Enter a valid SeaDrop contract address or leave it blank.', 'error');
    return;
  }

  const button = document.getElementById('chain-add');
  setButtonBusy(button, true, 'Adding…');
  const data = await api('POST', '/chains', { name, id, rpc, explorer, seadrop });
  setButtonBusy(button, false);
  if (data.error) {
    setPanelState(resultPanel, data.error, 'error');
    return;
  }

  ['chain-name', 'chain-id', 'chain-rpc', 'chain-explorer', 'chain-seadrop'].forEach(id => {
    document.getElementById(id).value = '';
  });
  await loadChains();
  appendLog(`[CHAIN] Added ${name} (ID: ${id})`);
  setPanelState(resultPanel, `Chain “${name}” was added successfully.`, 'success');
  toast(`Chain ${name} added`, 'success');
});

// ─── Wallets ───

async function loadWallets() {
  setTableLoading('#wallets-table', 4, 'Loading wallets…');
  const massListLoading = document.getElementById('mass-wallets');
  if (massListLoading) {
    massListLoading.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'combo-empty';
    loading.textContent = 'Loading wallets…';
    massListLoading.appendChild(loading);
  }
  const raw = await api('GET', '/wallets');
  const loadError = Array.isArray(raw) ? '' : (raw?.error || 'Unable to load wallets.');
  const wallets = Array.isArray(raw) ? raw : [];
  dashboardState.wallets = wallets;
  renderDashboardWallets(wallets);
  document.getElementById('wallet-count').textContent = `${wallets.length} wallet${wallets.length === 1 ? '' : 's'}`;

  for (const selectId of ['mint-wallet', 'dashboard-mint-wallet']) {
    const select = document.getElementById(selectId);
    if (!select) continue;
    const current = select.value;
    select.replaceChildren();
    if (!wallets.length) {
      select.appendChild(new Option(loadError ? 'Wallets unavailable' : 'No wallets configured', ''));
      select.disabled = true;
      continue;
    }
    select.disabled = false;
    if (selectId === 'dashboard-mint-wallet') {
      select.appendChild(new Option('Select wallets', ''));
    }
    wallets.forEach(wallet => {
      const label = selectId === 'dashboard-mint-wallet'
        ? `Wallet #${wallet.index} · ${wallet.address.slice(0, 8)}…${wallet.address.slice(-4)}`
        : `#${wallet.index} · ${wallet.address.slice(0, 8)}…${wallet.address.slice(-4)}`;
      select.appendChild(new Option(label, wallet.index - 1));
    });
    if ([...select.options].some(option => option.value === current)) {
      select.value = current;
    } else if (selectId === 'dashboard-mint-wallet') {
      select.value = '';
    }
  }
  updateDashboardWalletBadge();

  const massList = document.getElementById('mass-wallets');
  massList.replaceChildren();
  if (!wallets.length) {
    const empty = document.createElement('p');
    empty.className = 'combo-empty';
    empty.textContent = loadError
      ? 'Wallets could not be loaded. Check the server connection.'
      : 'No wallets available. Generate a wallet first.';
    massList.appendChild(empty);
  } else {
    wallets.forEach(wallet => {
      const label = document.createElement('label');
      label.setAttribute('role', 'option');
      label.setAttribute('aria-selected', 'true');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = wallet.index - 1;
      checkbox.checked = true;
      checkbox.setAttribute('aria-label', `Wallet ${wallet.index}, ${wallet.address}`);
      const text = document.createElement('span');
      text.textContent = `#${wallet.index} ${wallet.address.slice(0, 10)}…${wallet.address.slice(-6)}`;
      label.append(checkbox, text);
      massList.appendChild(label);
    });
  }
  updateMassSelected();

  const tbody = document.querySelector('#wallets-table tbody');
  tbody.replaceChildren();
  finishTableLoading(tbody);
  if (!wallets.length) {
    const row = document.createElement('tr');
    row.className = 'table-empty-row';
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.innerHTML = loadError
      ? '<strong>Wallets could not be loaded.</strong><span>Check the server connection and try Refresh.</span>'
      : '<strong>No wallets generated.</strong><span>Generate a wallet to begin minting.</span>';
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  wallets.forEach(wallet => {
    const row = document.createElement('tr');
    const indexCell = document.createElement('td');
    indexCell.textContent = wallet.index;

    const addressCell = document.createElement('td');
    addressCell.className = 'addr-cell mono';
    addressCell.title = `${wallet.address} — copy address`;
    addressCell.dataset.copy = wallet.address;
    addressCell.tabIndex = 0;
    addressCell.setAttribute('role', 'button');
    addressCell.setAttribute('aria-label', `Copy wallet ${wallet.index} address`);
    addressCell.textContent = wallet.address.length > 16
      ? `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)}`
      : wallet.address;

    const balanceCell = document.createElement('td');
    balanceCell.id = `bal-${wallet.address}`;
    balanceCell.textContent = 'Not checked';

    const actionsCell = document.createElement('td');
    actionsCell.className = 'table-actions';
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-sm btn-outline-danger';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => deleteWallet(wallet.index, wallet.address));
    actionsCell.appendChild(deleteButton);

    row.append(indexCell, addressCell, balanceCell, actionsCell);
    tbody.appendChild(row);
  });
}

document.getElementById('wallet-refresh').addEventListener('click', async (event) => {
  setButtonBusy(event.currentTarget, true, 'Refreshing…');
  await loadWallets();
  setButtonBusy(event.currentTarget, false);
});

window.deleteWallet = async function(index, address) {
  if (!window.confirm(`Delete wallet #${index}? Make sure its private key is backed up before continuing.`)) return;
  const data = await api('DELETE', `/wallets/${encodeURIComponent(address)}`);
  if (data.error) {
    toast(data.error, 'error');
    return;
  }
  appendLog(`[WALLET] Deleted #${index} (${address.slice(0, 10)}…). Total: ${data.total}`);
  await loadWallets();
  toast(`Wallet #${index} deleted`, 'success');
};

document.getElementById('wallet-generate').addEventListener('click', async () => {
  const countInput = document.getElementById('wallet-gen-count');
  const count = Number.parseInt(countInput.value, 10);
  const panel = document.getElementById('wallet-gen-result');
  setFieldValidity(countInput);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    setFieldValidity(countInput, 'Wallet count must be between 1 and 100');
    setPanelState(panel, 'Enter a wallet count between 1 and 100.', 'error');
    return;
  }

  const button = document.getElementById('wallet-generate');
  setButtonBusy(button, true, 'Generating…');
  const result = await api('POST', '/wallets/generate', { count });

  if (result.error) {
    setPanelState(panel, result.error, 'error');
    setButtonBusy(button, false);
    return;
  }

  panel.replaceChildren();
  panel.classList.remove('hidden', 'is-error', 'is-loading');
  panel.classList.add('is-success');
  panel.setAttribute('role', 'status');
  const summary = document.createElement('strong');
  summary.textContent = `Generated ${result.generated} wallet${result.generated === 1 ? '' : 's'}. Total: ${result.total}.`;
  panel.appendChild(summary);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-wrap generated-wallets-table';
  const table = document.createElement('table');
  table.innerHTML = '<caption class="sr-only">Newly generated wallets</caption><thead><tr><th scope="col">#</th><th scope="col">Address</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const wallet of Array.isArray(result.newWallets) ? result.newWallets : []) {
    const row = document.createElement('tr');
    const indexCell = document.createElement('td');
    indexCell.textContent = wallet.index;
    const addressCell = document.createElement('td');
    addressCell.className = 'mono';
    addressCell.textContent = wallet.address;
    row.append(indexCell, addressCell);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  panel.appendChild(tableWrap);

  appendLog(`[WALLET] Generated ${result.generated} wallets. Total: ${result.total}`);
  await loadWallets();
  setButtonBusy(button, false);
  panel.tabIndex = -1;
  panel.focus();
  toast(`${result.generated} wallet${result.generated === 1 ? '' : 's'} generated`, 'success');
});

document.getElementById('wallet-check-all').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  setButtonBusy(button, true, 'Checking…');
  const raw = await api('GET', '/wallets');
  const wallets = Array.isArray(raw) ? raw : [];
  for (const wallet of wallets) {
    const data = await api('GET', `/wallet/${encodeURIComponent(wallet.address)}`);
    const cell = document.getElementById(`bal-${wallet.address}`);
    if (!cell) continue;
    cell.replaceChildren();
    if (data.error || !data.balances || typeof data.balances !== 'object') {
      cell.textContent = data.error || 'Balance unavailable';
      cell.classList.add('cell-error');
      continue;
    }
    cell.classList.remove('cell-error');
    const balanceRow = document.createElement('div');
    balanceRow.className = 'balance-row';
    for (const [chain, value] of Object.entries(data.balances)) {
      const chip = document.createElement('span');
      const amount = Number.parseFloat(value.balance || '0');
      chip.className = `balance-chip ${amount > 0 ? 'has' : 'zero'}`;
      chip.textContent = `${chain}: ${amount > 0 ? amount.toFixed(4) : '0'}`;
      balanceRow.appendChild(chip);
    }
    cell.appendChild(balanceRow);
  }
  setButtonBusy(button, false);
  toast('Wallet balances updated', 'success');
});

// ─── Resolve ───

document.getElementById('mint-resolve').addEventListener('click', async (event) => {
  const inputElement = document.getElementById('mint-input');
  const input = inputElement.value.trim();
  const info = document.getElementById('mint-resolve-info');
  setFieldValidity(inputElement);
  if (!input) {
    setFieldValidity(inputElement, 'Collection URL or contract address is required');
    setPanelState(info, 'Enter an OpenSea URL or contract address to resolve.', 'error');
    return;
  }

  const button = event.currentTarget;
  setButtonBusy(button, true, 'Resolving…');
  const data = await api('POST', '/resolve', { input });
  setButtonBusy(button, false);
  if (data.error) {
    setPanelState(info, data.error, 'error');
    return;
  }

  document.getElementById('mint-chain').value = data.chain;
  info.classList.remove('hidden', 'is-error', 'is-loading');
  info.classList.add('is-success');
  info.setAttribute('role', 'status');
  info.innerHTML = `
    <h3>Collection resolved</h3>
    <div class="stat">Contract: <strong>${escapeHtml(data.contract)}</strong></div>
    <div class="stat">Chain: <strong>${escapeHtml(data.chain)}</strong></div>
    ${data.name ? `<div class="stat">Collection: <strong>${escapeHtml(data.name)}</strong></div>` : ''}
    ${data.totalSupply !== undefined ? `<div class="stat">Total supply: <strong>${escapeHtml(data.totalSupply)}</strong></div>` : ''}
  `;
});

// ─── Mint ───

async function doMint(dryRun) {
  const inputElement = document.getElementById('mint-input');
  const input = inputElement.value.trim();
  const chain = document.getElementById('mint-chain').value;
  const amountInput = document.getElementById('mint-amount');
  const amount = Number.parseInt(amountInput.value, 10);
  const walletIndex = Number.parseInt(document.getElementById('mint-wallet').value, 10);
  const info = document.getElementById('mint-resolve-info');

  setFieldValidity(inputElement);
  setFieldValidity(amountInput);
  if (!input) {
    setFieldValidity(inputElement, 'Collection URL or contract address is required');
    setPanelState(info, 'Enter an OpenSea URL or contract address before starting.', 'error');
    return;
  }
  if (!chain || !Number.isInteger(walletIndex)) {
    setPanelState(info, 'Select a configured chain and wallet before starting.', 'error');
    return;
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
    setFieldValidity(amountInput, 'Quantity must be between 1 and 100');
    setPanelState(info, 'Enter a mint quantity between 1 and 100.', 'error');
    return;
  }

  const button = dryRun ? document.getElementById('mint-dryrun') : document.getElementById('mint-execute');
  setButtonBusy(button, true, dryRun ? 'Simulating…' : 'Starting…');
  showConsole();

  const data = await api('POST', '/mint', { input, chain, amount, walletIndex, dryRun });
  if (data.error) {
    appendLog(`[ERROR] ${data.error}`);
    setButtonBusy(button, false);
    toast(data.error, 'error');
    return;
  }

  currentJobId = data.jobId;
  button.dataset.activeJob = String(data.jobId);
  appendLog(`[JOB] ${data.jobId} — ${dryRun ? 'dry-run' : 'execute'} mint on ${chain}`);
  toast(dryRun ? 'Dry run started' : 'Mint job started', 'success');
}

document.getElementById('mint-dryrun').addEventListener('click', () => doMint(true));
document.getElementById('mint-execute').addEventListener('click', () => doMint(false));

// ─── Dashboard quick mint ───

function setDashboardMintBusy(busy, label = '') {
  const button = document.getElementById('dashboard-mint-execute');
  if (!button) return;
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = 'Start Minting';
  if (busy) button.dataset.busy = 'true';
  else delete button.dataset.busy;
  button.disabled = busy || dashboardState.wallets.length === 0 || dashboardState.chains.length === 0;
  button.setAttribute('aria-busy', String(busy));
  button.classList.toggle('is-loading', busy);
  button.textContent = label || (busy ? 'Starting mint…' : button.dataset.defaultLabel);
}

async function doDashboardMint() {
  const inputEl = document.getElementById('dashboard-mint-input');
  const chainEl = document.getElementById('dashboard-mint-chain');
  const walletEl = document.getElementById('dashboard-mint-wallet');
  const helper = document.getElementById('dashboard-mint-helper');
  const input = inputEl?.value.trim() || '';
  const chain = chainEl?.value || '';
  const walletValue = walletEl?.value || '';
  const walletIndex = Number.parseInt(walletValue, 10);

  setFieldValidity(inputEl);
  if (!input) {
    setFieldValidity(inputEl, 'Collection URL or contract address is required');
    if (helper) helper.textContent = 'Enter an OpenSea URL or 0x contract address';
    toast('Enter an OpenSea URL or contract address', 'error');
    return;
  }
  if (!chain) {
    document.getElementById('dashboard-chain-trigger')?.focus();
    toast('Select a chain', 'error');
    return;
  }
  if (!Number.isInteger(walletIndex)) {
    document.getElementById('dashboard-wallet-trigger')?.focus();
    toast('Configure and select a wallet first', 'error');
    return;
  }

  // Keep the full Mint tab in sync with dashboard values.
  const fullInput = document.getElementById('mint-input');
  const fullChain = document.getElementById('mint-chain');
  const fullWallet = document.getElementById('mint-wallet');
  const fullAmount = document.getElementById('mint-amount');
  if (fullInput) fullInput.value = input;
  if (fullChain) fullChain.value = chain;
  if (fullWallet) fullWallet.value = String(walletIndex);
  if (fullAmount) fullAmount.value = '1';

  setDashboardMintBusy(true);
  if (helper) helper.textContent = `Starting on ${chain}...`;
  const data = await api('POST', '/mint', { input, chain, amount: 1, walletIndex, dryRun: false });

  if (data.error) {
    appendLog(`[ERROR] ${data.error}`);
    if (helper) helper.textContent = data.error;
    toast(data.error, 'error');
    setDashboardMintBusy(false);
    return;
  }

  currentJobId = data.jobId;
  appendLog(`[JOB] ${data.jobId} — dashboard mint on ${chain}`);
  if (helper) helper.textContent = `Job ${String(data.jobId).slice(0, 10)} started`;
  toast('Mint job started', 'success');
  setDashboardMintBusy(false, 'Mint Started');
  window.setTimeout(() => setDashboardMintBusy(false), 1400);
  refreshJobs();
}

document.getElementById('dashboard-mint-execute')?.addEventListener('click', doDashboardMint);
document.getElementById('dashboard-mint-input')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') doDashboardMint();
});
document.getElementById('dashboard-mint-input')?.addEventListener('input', event => {
  const helper = document.getElementById('dashboard-mint-helper');
  if (event.target.value.trim()) {
    setFieldValidity(event.target);
    if (helper) helper.textContent = 'Resolve collection details';
  }
});
document.getElementById('dashboard-mint-chain')?.addEventListener('change', event => {
  updateDashboardChainBadge();
  const fullChain = document.getElementById('mint-chain');
  if (fullChain) fullChain.value = event.target.value;
});
document.getElementById('dashboard-mint-wallet')?.addEventListener('change', event => {
  updateDashboardWalletBadge();
  const fullWallet = document.getElementById('mint-wallet');
  if (fullWallet) fullWallet.value = event.target.value;
});

// ─── Mass mint ───

document.getElementById('mass-select-all').addEventListener('click', () => {
  document.querySelectorAll('#mass-wallets input[type="checkbox"]').forEach(cb => cb.checked = true);
});

document.getElementById('mass-select-none').addEventListener('click', () => {
  document.querySelectorAll('#mass-wallets input[type="checkbox"]').forEach(cb => cb.checked = false);
});

document.getElementById('mass-execute').addEventListener('click', async (event) => {
  const inputElement = document.getElementById('mass-input');
  const input = inputElement.value.trim();
  const chain = document.getElementById('mass-chain').value;
  const amountInput = document.getElementById('mass-amount');
  const concurrentInput = document.getElementById('mass-concurrent');
  const amount = Number.parseInt(amountInput.value, 10);
  const concurrent = Number.parseInt(concurrentInput.value, 10);
  const walletIndices = Array.from(document.querySelectorAll('#mass-wallets input[type="checkbox"]:checked'))
    .map(checkbox => Number.parseInt(checkbox.value, 10));

  setFieldValidity(inputElement);
  setFieldValidity(amountInput);
  setFieldValidity(concurrentInput);
  if (!input) {
    setFieldValidity(inputElement, 'Collection URL or contract address is required');
    toast('Enter an OpenSea URL or contract address', 'error');
    return;
  }
  if (!chain) {
    toast('Select a configured chain', 'error');
    return;
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
    setFieldValidity(amountInput, 'Quantity must be between 1 and 100');
    toast('Enter a quantity between 1 and 100 per wallet', 'error');
    return;
  }
  if (!Number.isInteger(concurrent) || concurrent < 1 || concurrent > 10) {
    setFieldValidity(concurrentInput, 'Concurrency must be between 1 and 10');
    toast('Enter a concurrency value between 1 and 10', 'error');
    return;
  }
  if (walletIndices.length === 0) {
    document.getElementById('mass-combo-trigger')?.focus();
    toast('Select at least one wallet', 'error');
    return;
  }

  const button = event.currentTarget;
  setButtonBusy(button, true, 'Starting…');
  showConsole();
  const data = await api('POST', '/mass-mint', { input, chain, amount, walletIndices, maxConcurrent: concurrent });
  if (data.error) {
    appendLog(`[ERROR] ${data.error}`);
    setButtonBusy(button, false);
    toast(data.error, 'error');
    return;
  }

  currentJobId = data.jobId;
  button.dataset.activeJob = String(data.jobId);
  appendLog(`[JOB] ${data.jobId} — mass mint ${walletIndices.length} wallets × ${amount} on ${chain}`);
  toast('Mass mint job started', 'success');
});

// ─── Config ───

async function loadConfig() {
  const form = document.getElementById('config-form');
  if (!form) return;
  form.setAttribute('aria-busy', 'true');
  const config = await api('GET', '/config');
  form.replaceChildren();
  if (!config || typeof config !== 'object' || config.error) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact';
    empty.innerHTML = '<strong>Configuration unavailable</strong><span>Reload the page or check the server connection.</span>';
    form.appendChild(empty);
    form.setAttribute('aria-busy', 'false');
    return;
  }

  for (const [key, value] of Object.entries(config)) {
    const row = document.createElement('div');
    row.className = 'config-item';
    const inputId = `cfg-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const label = document.createElement('label');
    label.htmlFor = inputId;
    label.textContent = key;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = inputId;
    input.dataset.configKey = key;
    input.value = value ?? '';
    input.autocomplete = 'off';
    row.append(label, input);
    form.appendChild(row);
  }
  form.setAttribute('aria-busy', 'false');
}

document.getElementById('config-save').addEventListener('click', async (event) => {
  const inputs = document.querySelectorAll('[data-config-key]');
  const config = {};
  inputs.forEach(input => {
    config[input.dataset.configKey] = input.value;
  });
  const button = event.currentTarget;
  setButtonBusy(button, true, 'Saving…');
  const data = await api('POST', '/config', { config });
  setButtonBusy(button, false);
  if (data.status === 'ok') toast('Configuration saved', 'success');
  else toast(data.error || 'Configuration could not be saved', 'error');
});

// ─── Jobs ───

async function refreshJobs() {
  const list = document.getElementById('jobs-list');
  if (list) list.setAttribute('aria-busy', 'true');
  const raw = await api('GET', '/jobs');
  const loadError = Array.isArray(raw) ? '' : (raw?.error || 'Unable to load jobs.');
  const jobs = Array.isArray(raw) ? raw : [];
  dashboardState.jobs = jobs;
  renderDashboardJobs(jobs);
  if (!list) return;
  list.replaceChildren();

  const query = (document.getElementById('jobs-filter')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('jobs-status-filter')?.value || 'all';
  const filtered = jobs.filter(job => {
    if (statusFilter !== 'all' && job.status !== statusFilter) return false;
    return !query || `${job.id} ${job.type}`.toLowerCase().includes(query);
  });

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = `empty-state${loadError ? ' is-error' : ''}`;
    const title = document.createElement('strong');
    title.textContent = loadError ? 'Jobs could not be loaded.' : (jobs.length ? 'No jobs match these filters.' : 'No minting jobs yet.');
    const description = document.createElement('span');
    description.textContent = loadError ? 'Check the server connection and use Refresh to try again.' : (jobs.length ? 'Clear the search or choose another status.' : 'Started jobs will appear here with status and logs.');
    empty.append(title, description);
    list.appendChild(empty);
    list.setAttribute('aria-busy', 'false');
    return;
  }

  for (const job of filtered) {
    const logs = Array.isArray(job.logs) ? job.logs : [];
    const card = document.createElement('article');
    card.className = 'job-card';
    const status = ['pending', 'running', 'completed', 'failed'].includes(job.status) ? job.status : 'pending';
    const createdAt = new Date(job.createdAt);
    const time = Number.isNaN(createdAt.getTime()) ? 'Unknown time' : createdAt.toLocaleTimeString();

    const header = document.createElement('div');
    header.className = 'job-header';
    const title = document.createElement('span');
    title.textContent = `${job.type === 'mass-mint' ? 'mass' : 'single'} ${job.type || 'mint'} - ${time}`;
    const badge = document.createElement('span');
    badge.className = `job-status ${status}`;
    badge.textContent = status.toUpperCase();
    header.append(title, badge);

    const idLine = document.createElement('div');
    idLine.className = 'stat';
    idLine.textContent = `Job ID: ${job.id}`;
    card.append(header, idLine);

    if (job.result) {
      const resultLine = document.createElement('div');
      resultLine.className = 'stat';
      resultLine.append('Result: ');
      const code = document.createElement('code');
      code.textContent = JSON.stringify(job.result).slice(0, 500);
      resultLine.appendChild(code);
      card.appendChild(resultLine);
    }
    if (job.error) {
      const errorLine = document.createElement('div');
      errorLine.className = 'stat job-error';
      errorLine.textContent = `Error: ${job.error}`;
      card.appendChild(errorLine);
    }

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `Logs (${logs.length})`;
    const pre = document.createElement('pre');
    pre.textContent = logs.join('\n');
    details.append(summary, pre);
    card.appendChild(details);
    list.appendChild(card);
  }
  list.setAttribute('aria-busy', 'false');
}

document.getElementById('jobs-refresh').addEventListener('click', async (event) => {
  setButtonBusy(event.currentTarget, true, 'Refreshing…');
  await refreshJobs();
  setButtonBusy(event.currentTarget, false);
});

// ─── Logs Tab ───

const allLogs = []; // { time, source, message, level }
let logsAutoScroll = true;

function addLogEntry(source, message, level = '') {
  const safeMessage = String(message ?? '');
  const entry = {
    time: new Date().toISOString().slice(11, 19),
    source: String(source || 'system'),
    message: safeMessage,
    level: level || (safeMessage.includes('[FAIL]') || safeMessage.includes('[ERROR]') ? 'error' :
           safeMessage.includes('[OK]') || safeMessage.includes('[DONE]') ? 'success' :
           safeMessage.includes('[WARN]') || safeMessage.includes('[SIM]') ? 'warn' : ''),
  };
  allLogs.push(entry);
  if (allLogs.length > 1000) allLogs.splice(0, 100);
  renderLogEntry(entry);
}

function createLogLine(entry) {
  const row = document.createElement('div');
  row.className = `log-line ${entry.level}`.trim();
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = entry.time;
  const source = document.createElement('span');
  source.className = 'log-source';
  source.textContent = `[${entry.source}]`;
  const message = document.createElement('span');
  message.className = 'log-message';
  message.textContent = entry.message;
  row.append(time, source, message);
  return row;
}

function logEntryMatches(entry) {
  const filter = document.getElementById('logs-filter')?.value?.trim().toLowerCase() || '';
  const sourceFilter = document.getElementById('logs-source')?.value || 'all';
  if (filter && !entry.message.toLowerCase().includes(filter)) return false;
  if (sourceFilter !== 'all' && entry.source !== sourceFilter) return false;
  return true;
}

function renderLogEntry(entry) {
  const output = document.getElementById('logs-output');
  if (!output || !logEntryMatches(entry)) return;
  output.appendChild(createLogLine(entry));
  if (logsAutoScroll) output.scrollTop = output.scrollHeight;
}

function renderAllLogs() {
  const output = document.getElementById('logs-output');
  if (!output) return;
  output.replaceChildren();
  const matched = allLogs.filter(logEntryMatches);
  if (!matched.length) {
    const empty = document.createElement('div');
    empty.className = 'logs-empty';
    empty.textContent = allLogs.length ? 'No logs match the current filters.' : 'No log entries yet.';
    output.appendChild(empty);
  } else {
    matched.forEach(entry => output.appendChild(createLogLine(entry)));
  }
  if (logsAutoScroll) output.scrollTop = output.scrollHeight;
}

document.getElementById('logs-filter').addEventListener('input', renderAllLogs);
document.getElementById('logs-source').addEventListener('change', renderAllLogs);
renderAllLogs();

document.getElementById('logs-clear').addEventListener('click', () => {
  if (allLogs.length && !window.confirm('Clear all log entries from this view?')) return;
  allLogs.length = 0;
  renderAllLogs();
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
  const raw = await api('GET', '/jobs');
  const jobs = Array.isArray(raw) ? raw : [];
  for (const job of jobs) {
    const logs = Array.isArray(job.logs) ? job.logs : [];
    for (const line of logs) {
      const cleanLine = String(line).replace(/^\[[\d:]+\]\s*/, '');
      if (!allLogs.some(entry => entry.message === cleanLine && entry.source === `job:${job.id}`)) {
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
  const panel = document.getElementById('console-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
  panel.setAttribute('aria-hidden', 'false');
}

function appendLog(line, jobId = null) {
  const output = document.getElementById('console-output');
  if (!output) return;
  const div = document.createElement('div');
  div.className = 'log-line';
  if (line.includes('[OK]') || line.includes('[DONE]')) div.classList.add('success');
  if (line.includes('[FAIL]') || line.includes('[ERROR]')) div.classList.add('error');
  if (line.includes('[WARN]') || line.includes('[SIM]')) div.classList.add('warn');
  div.textContent = line;
  output.appendChild(div);
  output.scrollTop = output.scrollHeight;
}

document.getElementById('console-clear').addEventListener('click', () => {
  document.getElementById('console-output').replaceChildren();
});

document.getElementById('console-toggle').addEventListener('click', (event) => {
  const output = document.getElementById('console-output');
  const button = event.currentTarget;
  const expanded = button.getAttribute('aria-expanded') !== 'false';
  output.hidden = expanded;
  button.textContent = expanded ? '+' : '−';
  button.setAttribute('aria-expanded', String(!expanded));
  button.setAttribute('aria-label', expanded ? 'Expand live log' : 'Collapse live log');
});

function updateJobStatus(data) {
  if (data.status === 'completed') {
    appendLog('[DONE] Job completed');
  } else if (data.status === 'failed') {
    appendLog(`[FAIL] ${data.error || 'Job failed'}`);
  }
  // Re-enable only the controls associated with completed execution jobs.
  ['mint-dryrun', 'mint-execute', 'mass-execute'].forEach(id => {
    const button = document.getElementById(id);
    if (button?.dataset.activeJob === String(data.id || currentJobId)) {
      delete button.dataset.activeJob;
      setButtonBusy(button, false);
    }
  });
}

// ─── Start ───

// Auth: check status and show appropriate UI
function renderAuthStatus(enabled, message = '') {
  const section = document.getElementById('auth-section');
  section.replaceChildren();
  const note = document.createElement('div');
  note.className = `auth-note ${enabled ? 'ok' : 'warn'}`;
  const dot = document.createElement('span');
  dot.className = 'auth-dot';
  dot.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('span');
  copy.textContent = message || (enabled ? 'Password protection enabled' : 'No password set. Panel is open access.');
  note.append(dot, copy);
  section.appendChild(note);
}

async function checkAuth() {
  try {
    const response = await fetch('/api/auth/status', { headers: { Accept: 'application/json' } });
    const data = await response.json();
    const enabled = Boolean(data.enabled);
    document.getElementById('logout-btn').classList.toggle('is-hidden-inline', !enabled);
    document.getElementById('change-password-form').classList.toggle('hidden', !enabled);
    document.getElementById('set-password-form').classList.toggle('hidden', enabled);
    renderAuthStatus(enabled);
  } catch (_) {
    renderAuthStatus(false, 'Security status is unavailable. Check the server connection.');
  }
}

document.getElementById('logout-btn').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  setButtonBusy(button, true, 'Signing out…');
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  } catch (_) {
    setButtonBusy(button, false);
    toast('Unable to sign out. Try again.', 'error');
  }
});

document.getElementById('set-pw-btn').addEventListener('click', async (event) => {
  const passwordInput = document.getElementById('set-pw');
  const confirmInput = document.getElementById('set-pw-confirm');
  const password = passwordInput.value;
  const confirmation = confirmInput.value;
  setFieldValidity(passwordInput);
  setFieldValidity(confirmInput);

  if (password.length < 8) {
    setFieldValidity(passwordInput, 'Password must contain at least 8 characters');
    toast('Use at least 8 characters for the password', 'error');
    return;
  }
  if (password !== confirmation) {
    setFieldValidity(confirmInput, 'Passwords do not match');
    toast('The passwords do not match', 'error');
    return;
  }

  const button = event.currentTarget;
  setButtonBusy(button, true, 'Setting password…');
  try {
    const response = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await response.json();
    if (response.ok && data.status === 'ok') {
      passwordInput.value = '';
      confirmInput.value = '';
      toast('Password protection enabled', 'success');
      await checkAuth();
    } else {
      toast(data.error || 'Password could not be set', 'error');
    }
  } catch (_) {
    toast('The server could not be reached', 'error');
  } finally {
    setButtonBusy(button, false);
  }
});

document.getElementById('change-password-btn').addEventListener('click', async (event) => {
  const oldInput = document.getElementById('old-password');
  const newInput = document.getElementById('new-password');
  const confirmInput = document.getElementById('confirm-password');
  const oldPassword = oldInput.value;
  const newPassword = newInput.value;
  const confirmation = confirmInput.value;
  [oldInput, newInput, confirmInput].forEach(input => setFieldValidity(input));

  if (!oldPassword) {
    setFieldValidity(oldInput, 'Current password is required');
    toast('Enter the current password', 'error');
    return;
  }
  if (newPassword.length < 8) {
    setFieldValidity(newInput, 'Password must contain at least 8 characters');
    toast('Use at least 8 characters for the new password', 'error');
    return;
  }
  if (newPassword !== confirmation) {
    setFieldValidity(confirmInput, 'Passwords do not match');
    toast('The new passwords do not match', 'error');
    return;
  }

  const button = event.currentTarget;
  setButtonBusy(button, true, 'Changing…');
  try {
    const response = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    const data = await response.json();
    if (response.ok && data.status === 'ok') {
      [oldInput, newInput, confirmInput].forEach(input => { input.value = ''; });
      toast('Password changed successfully', 'success');
    } else {
      toast(data.error || 'Password could not be changed', 'error');
    }
  } catch (_) {
    toast('The server could not be reached', 'error');
  } finally {
    setButtonBusy(button, false);
  }
});

checkAuth();
init();

// ─── UI enhancements (visual only — no logic changes) ───

// Toast notifications
function toast(message, type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const notification = document.createElement('div');
  notification.className = `toast ${type}`.trim();
  notification.setAttribute('role', type === 'error' ? 'alert' : 'status');
  notification.textContent = String(message || '');
  container.appendChild(notification);
  window.setTimeout(() => notification.remove(), type === 'error' ? 5200 : 3600);
}

async function copyAddress(target) {
  const text = target?.getAttribute('data-copy');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Address copied', 'success');
  } catch (_) {
    toast('Address could not be copied', 'error');
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-copy]');
  if (target) copyAddress(target);
});
document.addEventListener('keydown', (event) => {
  const target = event.target.closest?.('[data-copy]');
  if (!target || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  copyAddress(target);
});

// Page title/description sync with active tab
document.querySelectorAll('.tab[data-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    const titleEl = document.getElementById('page-title');
    const descEl = document.getElementById('page-desc');
    if (titleEl && tab.dataset.title) titleEl.textContent = tab.dataset.title;
    if (descEl && tab.dataset.desc) descEl.textContent = tab.dataset.desc;
    // Close mobile drawer after navigation
    setSidebarOpen(false);
  });
});

// Mobile sidebar drawer
function setSidebarOpen(open) {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const toggle = document.getElementById('sidebar-toggle');
  sidebar?.classList.toggle('open', open);
  overlay?.classList.toggle('show', open);
  overlay?.setAttribute('aria-hidden', String(!open));
  toggle?.setAttribute('aria-expanded', String(open));
  syncBodyScrollLock();
  if (open) requestAnimationFrame(() => sidebar?.querySelector('.tab')?.focus());
}

document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
  const isOpen = document.getElementById('sidebar')?.classList.contains('open') || false;
  setSidebarOpen(!isOpen);
});
document.getElementById('sidebar-overlay')?.addEventListener('click', () => setSidebarOpen(false));

// Connection status badge styling (text updates remain handled above)
function syncStatusBadge() {
  const el = document.getElementById('server-status');
  if (!el) return;
  const txt = el.textContent.toLowerCase();
  el.classList.toggle('ok', txt.includes('connected') && !txt.includes('disconnected'));
  el.classList.toggle('err', txt.includes('disconnected'));
}
const _statusEl = document.getElementById('server-status');
if (_statusEl) new MutationObserver(syncStatusBadge).observe(_statusEl, { childList: true, characterData: true, subtree: true });
syncStatusBadge();

// Generate wallet modal
const genModal = document.getElementById('wallet-gen-modal');
let modalReturnFocus = null;

function setGenModalOpen(open) {
  if (!genModal) return;
  genModal.classList.toggle('hidden', !open);
  genModal.setAttribute('aria-hidden', String(!open));
  syncBodyScrollLock();

  if (open) {
    modalReturnFocus = document.activeElement;
    requestAnimationFrame(() => document.getElementById('wallet-gen-count')?.focus());
  } else if (modalReturnFocus instanceof HTMLElement) {
    modalReturnFocus.focus();
  }
}

document.getElementById('wallet-gen-open')?.addEventListener('click', () => setGenModalOpen(true));
document.getElementById('wallet-gen-cancel')?.addEventListener('click', () => setGenModalOpen(false));
genModal?.querySelectorAll('[data-close-modal]').forEach(control => {
  control.addEventListener('click', () => setGenModalOpen(false));
});

document.addEventListener('keydown', (event) => {
  const genModalOpen = Boolean(genModal && !genModal.classList.contains('hidden'));
  const selectorOpen = isMintSelectorOpen();
  const activeModal = selectorOpen ? mintSelectorModal : (genModalOpen ? genModal : null);

  if (event.key === 'Escape') {
    if (selectorOpen) {
      event.preventDefault();
      setMintSelectorOpen(false);
      return;
    }
    closeMassCombo(true);
    if (genModalOpen) setGenModalOpen(false);
    const sidebarWasOpen = document.getElementById('sidebar')?.classList.contains('open');
    setSidebarOpen(false);
    if (sidebarWasOpen) document.getElementById('sidebar-toggle')?.focus();
    return;
  }
  if (event.key !== 'Tab' || !activeModal) return;

  const focusable = [...activeModal.querySelectorAll(INTERACTIVE_SELECTOR)]
    .filter(element => !element.closest('.hidden') && element.offsetParent !== null);
  if (!focusable.length) {
    event.preventDefault();
    activeModal.querySelector('.modal-card')?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

// Mass mint: wallet search + selected counter
function updateMassSelected() {
  const boxes = [...document.querySelectorAll('#mass-wallets input[type="checkbox"]')];
  const checked = boxes.filter(checkbox => checkbox.checked);
  const counter = document.getElementById('mass-selected-count');
  if (counter) counter.textContent = `${checked.length} of ${boxes.length} selected`;
  const label = document.getElementById('mass-combo-label');
  if (label) {
    label.textContent = boxes.length === 0
      ? 'No wallets — generate one first'
      : `${checked.length} of ${boxes.length} wallets selected`;
    label.classList.toggle('has', checked.length > 0);
  }
  boxes.forEach(checkbox => {
    checkbox.closest('[role="option"]')?.setAttribute('aria-selected', String(checkbox.checked));
  });
}

document.getElementById('mass-wallets')?.addEventListener('change', updateMassSelected);
document.getElementById('mass-select-all')?.addEventListener('click', updateMassSelected);
document.getElementById('mass-select-none')?.addEventListener('click', updateMassSelected);
const _massList = document.getElementById('mass-wallets');
if (_massList) new MutationObserver(updateMassSelected).observe(_massList, { childList: true });
updateMassSelected();

// Searchable multi-select popover
const combo = document.getElementById('mass-wallet-combo');
const comboPanel = document.getElementById('mass-combo-panel');
const comboTrigger = document.getElementById('mass-combo-trigger');
if (comboTrigger) comboTrigger.setAttribute('aria-haspopup', 'dialog');
if (comboPanel) comboPanel.setAttribute('role', 'dialog');
if (_massList) _massList.setAttribute('role', 'group');

function openMassCombo() {
  if (!combo || !comboPanel || !comboTrigger) return;
  combo.classList.add('open');
  comboPanel.classList.remove('hidden');
  comboPanel.setAttribute('aria-hidden', 'false');
  comboTrigger.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => document.getElementById('mass-wallet-search')?.focus());
}

function closeMassCombo(returnFocus = false) {
  if (!combo || !comboPanel || !comboTrigger) return;
  const wasOpen = combo.classList.contains('open');
  combo.classList.remove('open');
  comboPanel.classList.add('hidden');
  comboPanel.setAttribute('aria-hidden', 'true');
  comboTrigger.setAttribute('aria-expanded', 'false');
  if (returnFocus && wasOpen) comboTrigger.focus();
}

comboTrigger?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (combo?.classList.contains('open')) closeMassCombo();
  else openMassCombo();
});
comboTrigger?.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    openMassCombo();
  }
});
comboPanel?.addEventListener('click', event => event.stopPropagation());
comboPanel?.addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const options = [...comboPanel.querySelectorAll('#mass-wallets input[type="checkbox"]')]
    .filter(option => !option.closest('label')?.hidden && !option.disabled);
  if (!options.length) return;
  event.preventDefault();
  const currentIndex = options.indexOf(document.activeElement);
  const delta = event.key === 'ArrowDown' ? 1 : -1;
  const nextIndex = currentIndex < 0
    ? (delta > 0 ? 0 : options.length - 1)
    : (currentIndex + delta + options.length) % options.length;
  options[nextIndex].focus();
});
document.addEventListener('click', event => {
  if (!combo?.contains(event.target)) closeMassCombo();
});

document.getElementById('mass-wallet-search')?.addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll('#mass-wallets label').forEach(label => {
    const matches = label.textContent.toLowerCase().includes(query);
    label.hidden = !matches;
    if (matches) visible += 1;
  });
  let empty = document.getElementById('mass-wallet-no-results');
  if (!empty) {
    empty = document.createElement('p');
    empty.id = 'mass-wallet-no-results';
    empty.className = 'combo-empty';
    empty.textContent = 'No wallets match this search.';
    _massList?.insertAdjacentElement('afterend', empty);
  }
  empty.hidden = visible > 0 || !query;
});

// Jobs toolbar filters
document.getElementById('jobs-filter')?.addEventListener('input', refreshJobs);
document.getElementById('jobs-status-filter')?.addEventListener('change', refreshJobs);

// Password show/hide toggles
document.querySelectorAll('[data-pw-toggle]').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.getAttribute('data-pw-toggle'));
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    btn.setAttribute('aria-pressed', String(show));
  });
});

// Password strength indicator
document.querySelectorAll('[data-pw-strength]').forEach(bar => {
  const input = document.getElementById(bar.getAttribute('data-pw-strength'));
  if (!input) return;
  input.addEventListener('input', () => {
    const length = input.value.length;
    bar.style.width = `${Math.min(100, length * 10)}%`;
    bar.dataset.level = length < 8 ? 'weak' : length < 12 ? 'medium' : 'strong';
  });
});

// ─── Activity calendar + chart (read-only, derived from job DOM data) ───

// Count minted NFTs per day from job data attributes injected by render patch
function collectDailyMints() {
  const daily = {}; // 'YYYY-MM-DD' -> count
  document.querySelectorAll('#jobs-list .job-card').forEach(card => {
    const date = card.dataset.jobDate; // set via MutationObserver patch below
    const minted = parseInt(card.dataset.minted || '0');
    if (date && minted > 0) daily[date] = (daily[date] || 0) + minted;
  });
  return daily;
}

// Extract mint counts when job cards render
function tagJobCards() {
  document.querySelectorAll('#jobs-list .job-card').forEach(card => {
    if (card.dataset.tagged) return;
    card.dataset.tagged = '1';
    // Parse date from header text "... - HH:MM:SS" (today's time) or keep unknown
    const header = card.querySelector('.job-header span')?.textContent || '';
    const resultText = card.querySelector('.stat code')?.textContent || '';
    let minted = 0;
    try {
      const r = JSON.parse(resultText);
      if (typeof r === 'object' && r !== null) {
        if (typeof r.success === 'number') {
          // mass-mint result
          const total = parseInt(card.dataset.amount || '0');
          minted = r.success * (total || 1);
        } else if (r.status === 'success' && Array.isArray(r.tokenIds)) {
          minted = r.tokenIds.length;
        } else if (r.status === 'success') {
          minted = parseInt(card.dataset.amount || '1');
        }
      }
    } catch (e) { /* not JSON */ }
    card.dataset.minted = String(minted);
    // Approximate date: use today's date (job list only shows recent, time-only)
    card.dataset.jobDate = new Date().toISOString().slice(0, 10);
  });
}

let calOffset = 0;

function renderCalendar() {
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;
  const daily = collectDailyMints();

  const now = new Date();
  const view = new Date(now.getFullYear(), now.getMonth() + calOffset, 1);
  const year = view.getFullYear();
  const month = view.getMonth();

  const title = document.getElementById('cal-title');
  if (title) title.textContent = view.toLocaleString('en', { month: 'long', year: 'numeric' });

  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();
  const todayStr = now.toISOString().slice(0, 10);

  let html = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => `<div class="cal-dow">${d}</div>`).join('');

  // Leading days from previous month
  for (let i = firstDow - 1; i >= 0; i--) {
    html += `<div class="cal-day adjacent"><span class="cal-num">${daysInPrev - i}</span></div>`;
  }

  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const count = daily[key] || 0;
    const isToday = key === todayStr;
    html += `<div class="cal-day${isToday ? ' today' : ''}">
      <span class="cal-num">${d}</span>
      ${count > 0 ? `<span class="cal-mint">+${count} NFT</span>` : ''}
    </div>`;
  }

  // Trailing days from next month — always fill to 42 cells (6 rows)
  const used = firstDow + daysInMonth;
  const trailing = 42 - used;
  for (let d = 1; d <= trailing; d++) {
    html += `<div class="cal-day adjacent"><span class="cal-num">${d}</span></div>`;
  }

  grid.innerHTML = html;
}

function renderChart() {
  const el = document.getElementById('mint-chart');
  if (!el) return;
  const daily = collectDailyMints();

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    days.push(dt);
  }
  const max = Math.max(1, ...days.map(d => daily[d.toISOString().slice(0, 10)] || 0));

  el.innerHTML = days.map(d => {
    const key = d.toISOString().slice(0, 10);
    const v = daily[key] || 0;
    const pct = Math.round((v / max) * 100);
    const label = `${d.getDate()}/${d.getMonth() + 1}`;
    return `<div class="chart-col${v === 0 ? ' empty' : ''}" title="${key}: ${v} minted">
      <span class="chart-val">${v || ''}</span>
      <div class="chart-bar-wrap"><div class="chart-bar" style="height:${v === 0 ? 2 : Math.max(4, pct)}%"></div></div>
      <span class="chart-date">${label}</span>
    </div>`;
  }).join('');
}

function renderActivity() {
  tagJobCards();
  renderCalendar();
  renderChart();
}

document.getElementById('cal-prev')?.addEventListener('click', () => { calOffset--; renderCalendar(); });
document.getElementById('cal-next')?.addEventListener('click', () => { calOffset++; renderCalendar(); });

const _jobsListEl = document.getElementById('jobs-list');
if (_jobsListEl) new MutationObserver(renderActivity).observe(_jobsListEl, { childList: true, subtree: true });
renderActivity();


// ─── Overview dashboard ───
function dashboardEscape(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function dashboardJobMinted(job) {
  const result = job && job.result;
  if (!result || typeof result !== 'object') return 0;
  if (typeof result.success === 'number') return Math.max(0, result.success);
  if (Array.isArray(result.tokenIds)) return result.tokenIds.length;
  if (result.status === 'success' || job.status === 'completed') return 1;
  return 0;
}



function dashboardDateLabel(date, range) {
  const options = range <= 7 ? { weekday: 'short' } : { day: 'numeric', month: 'short' };
  return date.toLocaleDateString('en-US', options);
}

function renderDashboardWallets(wallets) {
  const count = document.getElementById('overview-wallets');
  if (count) count.textContent = wallets.length;
  const mintCount = document.getElementById('momentum-wallet-total');
  if (mintCount) mintCount.textContent = wallets.length.toLocaleString();
  const health = document.getElementById('overview-wallet-status');
  if (health) health.textContent = wallets.length ? `${wallets.length} ready` : 'No wallets';
  const dashboardMintButton = document.getElementById('dashboard-mint-execute');
  if (dashboardMintButton && !dashboardMintButton.dataset.busy) dashboardMintButton.disabled = wallets.length === 0 || dashboardState.chains.length === 0;

  const list = document.getElementById('dashboard-wallets');
  if (!list) return;
  if (!wallets.length) {
    list.innerHTML = '<div class="overview-empty">No wallets configured.</div>';
    return;
  }
  list.innerHTML = wallets.slice(0, 4).map((wallet, index) => {
    const address = String(wallet.address || '');
    const short = address.length > 16 ? `${address.slice(0, 8)}...${address.slice(-6)}` : address;
    return `<div class="dashboard-resource-row">
      <span class="resource-avatar">${dashboardEscape(wallet.index || index + 1)}</span>
      <span class="resource-copy"><strong>${dashboardEscape(short)}</strong><small>Wallet #${dashboardEscape(wallet.index || index + 1)}</small></span>
      <span class="resource-state">READY</span>
    </div>`;
  }).join('');
}

function renderDashboardNetworks(chains) {
  const count = document.getElementById('overview-chains');
  if (count) count.textContent = chains.length;
  const mintCount = document.getElementById('momentum-network-total');
  if (mintCount) mintCount.textContent = chains.length.toLocaleString();
  const rpc = document.getElementById('overview-rpc-status');
  if (rpc) rpc.textContent = `${chains.length} network${chains.length === 1 ? '' : 's'}`;
  const list = document.getElementById('dashboard-networks');
  if (!list) return;
  if (!chains.length) {
    list.innerHTML = '<div class="overview-empty">No networks configured.</div>';
    return;
  }
  list.innerHTML = chains.slice(0, 3).map(chain => {
    const name = String(chain.name || 'Network');
    const initial = name.slice(0, 2).toUpperCase();
    const privateRpc = /alchemy|infura|quicknode|QN_/i.test(String(chain.rpc || ''));
    return `<div class="dashboard-resource-row">
      <span class="resource-avatar network">${dashboardEscape(initial)}</span>
      <span class="resource-copy"><strong>${dashboardEscape(name)}</strong><small>Chain ID ${dashboardEscape(chain.id || '—')}</small></span>
      <span class="resource-state${privateRpc ? ' private' : ''}">${privateRpc ? 'PRIVATE RPC' : (chain.native ? 'NATIVE' : 'CUSTOM')}</span>
    </div>`;
  }).join('');
}

function renderDashboardJobs(jobs) {
  const totalEl = document.getElementById('overview-jobs');
  const mintedEl = document.getElementById('overview-minted');
  const rateEl = document.getElementById('overview-rate');
  const rateSubEl = document.getElementById('overview-rate-sub');
  const runningEl = document.getElementById('overview-running');
  const queueEl = document.getElementById('overview-queue-status');

  const running = jobs.filter(job => job.status === 'running' || job.status === 'pending').length;
  const completed = jobs.filter(job => job.status === 'completed').length;
  const failed = jobs.filter(job => job.status === 'failed').length;
  const decided = completed + failed;
  const minted = jobs.reduce((sum, job) => sum + dashboardJobMinted(job), 0);
  const rate = decided ? Math.round(completed / decided * 100) : 0;

  if (totalEl) totalEl.textContent = jobs.length;
  if (mintedEl) mintedEl.textContent = minted.toLocaleString();
  if (rateEl) rateEl.textContent = `${rate}%`;
  if (rateSubEl) rateSubEl.textContent = decided ? `${completed} successful of ${decided}` : 'No completed jobs';
  if (runningEl) runningEl.textContent = `${running} currently running`;
  if (queueEl) queueEl.textContent = running ? `${running} active` : 'Idle';
  const totalVolume = document.getElementById('momentum-total-volume');
  if (totalVolume) totalVolume.textContent = jobs.length.toLocaleString();

  const score = decided ? Math.max(0, Math.min(100, rate)) : 100;
  const healthScore = document.getElementById('overview-health-score');
  const healthCopy = document.getElementById('overview-health-copy');
  if (healthScore) healthScore.textContent = score;
  if (healthCopy) healthCopy.textContent = score >= 95 ? 'All systems ready' : score >= 75 ? 'Minor execution errors' : 'Review failed jobs';

  const tbody = document.getElementById('dashboard-jobs');
  if (tbody) {
    const recent = [...jobs].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 6);
    tbody.innerHTML = recent.length ? recent.map(job => {
      const status = String(job.status || 'pending').toLowerCase();
      const created = job.createdAt ? new Date(job.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
      const mintedCount = dashboardJobMinted(job);
      const result = status === 'completed' ? `${mintedCount} minted` : status === 'failed' ? 'Failed' : 'In progress';
      const type = String(job.type || 'mint');
      return `<tr>
        <td><span class="overview-job-id">${dashboardEscape(String(job.id || '—').slice(0, 12))}</span></td>
        <td><span class="overview-type"><i class="overview-type-icon">${type.includes('mass') ? '⊞' : '✦'}</i>${dashboardEscape(type)}</span></td>
        <td><span class="overview-status ${dashboardEscape(status)}">${dashboardEscape(status)}</span></td>
        <td>${dashboardEscape(created)}</td>
        <td>${dashboardEscape(result)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="overview-empty">No jobs yet.</td></tr>';
  }

  const recentList = document.getElementById('dashboard-recent-jobs');
  if (recentList) {
    const recentJobs = [...jobs]
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 3);
    recentList.innerHTML = recentJobs.length ? recentJobs.map(job => {
      const type = String(job.type || 'mint');
      const status = String(job.status || 'pending').toLowerCase();
      const created = job.createdAt
        ? new Date(job.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—';
      const mintedCount = dashboardJobMinted(job);
      const result = status === 'completed' ? `${mintedCount} minted` : status === 'failed' ? 'Failed' : 'In progress';
      const label = String(job.id || 'job').slice(0, 12);
      return `<div class="momentum-recent-row">
        <span class="momentum-asset-icon mini">${type.includes('mass') ? 'M' : 'J'}</span>
        <span class="momentum-recent-copy">
          <strong>${dashboardEscape(label)}</strong>
          <small>${dashboardEscape(type)} · ${dashboardEscape(created)}</small>
        </span>
        <span class="momentum-recent-meta">
          <b class="overview-status ${dashboardEscape(status)}">${dashboardEscape(status)}</b>
          <small>${dashboardEscape(result)}</small>
        </span>
      </div>`;
    }).join('') : '<div class="momentum-recent-empty">No jobs yet.</div>';
  }

  renderDashboardChart(jobs, dashboardState.range);
  renderDashboardVolume(jobs, dashboardState.range);
  renderDashboardCalendar(jobs);
}

function renderDashboardVolume(jobs, range = 14) {
  const host = document.getElementById('dashboard-volume-chart');
  if (!host) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const values = [];
  for (let offset = range - 1; offset >= 0; offset--) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const key = date.toISOString().slice(0, 10);
    const count = jobs.filter(job => {
      if (!job.createdAt) return false;
      const value = new Date(job.createdAt);
      return !Number.isNaN(value.getTime()) && value.toISOString().slice(0, 10) === key;
    }).length;
    values.push({ date, count });
  }

  const max = Math.max(1, ...values.map(item => item.count));
  host.innerHTML = values.map(item => {
    const height = item.count ? Math.max(8, item.count / max * 92) : 3;
    const title = `${dashboardDateLabel(item.date, range)}: ${item.count} job${item.count === 1 ? '' : 's'}`;
    return `<i class="momentum-volume-bar" style="--bar-height:${height}%" title="${dashboardEscape(title)}"><span>${item.count}</span></i>`;
  }).join('');
}

function renderDashboardCalendar(jobs) {
  const host = document.getElementById('dashboard-calendar');
  const title = document.getElementById('dashboard-calendar-title');
  if (!host) return;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const mintCounts = {};

  jobs.forEach(job => {
    if (!job.createdAt) return;
    const date = new Date(job.createdAt);
    if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month) return;
    const day = date.getDate();
    mintCounts[day] = (mintCounts[day] || 0) + Math.max(1, dashboardJobMinted(job));
  });

  if (title) title.textContent = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const weekdays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const blanks = Array.from({ length: first.getDay() }, () => '<span class="momentum-calendar-day empty"></span>').join('');
  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const count = mintCounts[day] || 0;
    const classes = ['momentum-calendar-day'];
    if (day === now.getDate()) classes.push('today');
    if (count > 0) classes.push('has-mint');
    if (count >= 4) classes.push('has-many');
    return `<span class="${classes.join(' ')}" title="${count ? `${count} mint activity` : 'No mint activity'}">${day}</span>`;
  }).join('');

  host.innerHTML = `<div class="momentum-calendar-weekdays">${weekdays.map(day => `<span>${day}</span>`).join('')}</div><div class="momentum-calendar-days">${blanks}${days}</div>`;
}

function renderDashboardChart(jobs, range = 14) {
  const host = document.getElementById('dashboard-activity-chart');
  if (!host) return;
  dashboardState.range = range;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const points = [];
  for (let offset = range - 1; offset >= 0; offset--) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const key = date.toISOString().slice(0, 10);
    const dayJobs = jobs.filter(job => {
      if (!job.createdAt) return false;
      const dateValue = new Date(job.createdAt);
      return !Number.isNaN(dateValue.getTime()) && dateValue.toISOString().slice(0, 10) === key;
    });
    points.push({ date, jobs: dayJobs.length, mints: dayJobs.reduce((sum, job) => sum + dashboardJobMinted(job), 0) });
  }

  const periodMints = points.reduce((sum, point) => sum + point.mints, 0);
  const periodJobs = points.reduce((sum, point) => sum + point.jobs, 0);
  const periodMintsEl = document.getElementById('overview-period-mints');
  const periodJobsEl = document.getElementById('overview-period-jobs');
  if (periodMintsEl) periodMintsEl.textContent = periodMints.toLocaleString();
  if (periodJobsEl) periodJobsEl.textContent = periodJobs.toLocaleString();

  const width = 900;
  const height = 168;
  const padX = 12;
  const padY = 14;
  const max = Math.max(1, ...points.map(point => Math.max(point.mints, point.jobs)));
  const x = index => padX + (points.length === 1 ? 0 : index * (width - padX * 2) / (points.length - 1));
  const y = value => height - padY - value / max * (height - padY * 2);
  const coords = points.map((point, index) => [x(index), y(point.mints)]);
  const jobCoords = points.map((point, index) => [x(index), y(point.jobs)]);
  const linePath = coords.map((coord, index) => `${index ? 'L' : 'M'}${coord[0].toFixed(1)},${coord[1].toFixed(1)}`).join(' ');
  const jobPath = jobCoords.map((coord, index) => `${index ? 'L' : 'M'}${coord[0].toFixed(1)},${coord[1].toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${x(points.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
  const every = range <= 7 ? 1 : range <= 14 ? 2 : 5;
  const labels = points.map((point, index) => index % every === 0 || index === points.length - 1 ? `<span>${dashboardEscape(dashboardDateLabel(point.date, range))}</span>` : '<span></span>').join('');
  const dots = coords.map((coord, index) => points[index].mints ? `<circle class="chart-point" cx="${coord[0].toFixed(1)}" cy="${coord[1].toFixed(1)}" r="3.2"><title>${dashboardEscape(dashboardDateLabel(points[index].date, range))}: ${points[index].mints} minted</title></circle>` : '').join('');

  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${range} day mint activity">
    <defs>
      <linearGradient id="dashboardArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#315cff" stop-opacity=".34"/>
        <stop offset="100%" stop-color="#315cff" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#dashboardArea)"/>
    <path d="${jobPath}" fill="none" stroke="#2446a8" stroke-opacity=".46" stroke-width="2" stroke-dasharray="5 7" vector-effect="non-scaling-stroke"/>
    <path d="${linePath}" fill="none" stroke="#315cff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    ${dots}
  </svg><div class="dashboard-chart-labels" style="grid-template-columns:repeat(${points.length},1fr)">${labels}</div>`;
}

function updateDashboardConnection(connected) {
  const status = document.getElementById('overview-api-status');
  if (status) status.textContent = connected ? 'Connected' : 'Disconnected';
  const icon = status?.closest('div')?.querySelector('.health-icon');
  if (icon) {
    icon.classList.toggle('ok', connected);
    icon.classList.toggle('bad', !connected);
  }
}

document.querySelectorAll('[data-open-tab]').forEach(button => {
  button.addEventListener('click', () => {
    const tab = document.querySelector(`.tab[data-tab="${button.dataset.openTab}"]`);
    tab?.click();
  });
});

document.querySelectorAll('[data-dashboard-range]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-dashboard-range]').forEach(item => {
      item.classList.remove('active');
      item.setAttribute('aria-pressed', 'false');
    });
    button.classList.add('active');
    button.setAttribute('aria-pressed', 'true');
    const range = Number(button.dataset.dashboardRange) || 14;
    const pill = document.getElementById('volume-range-pill');
    if (pill) pill.textContent = button.textContent.trim();
    renderDashboardChart(dashboardState.jobs, range);
    renderDashboardVolume(dashboardState.jobs, range);
  });
});

// ─── Dashboard stats + recent mints ───
function renderDashStats() {
  const mintedEl = document.getElementById('dash-minted');
  if (!mintedEl) return;

  tagJobCards();
  let totalMinted = 0;
  const cards = Array.from(document.querySelectorAll('#jobs-list .job-card'));
  cards.forEach(c => { totalMinted += parseInt(c.dataset.minted || '0'); });
  mintedEl.textContent = totalMinted;

  // success rate from job-status badges
  const done = document.querySelectorAll('#jobs-list .job-status.completed').length;
  const failed = document.querySelectorAll('#jobs-list .job-status.failed').length;
  const total = done + failed;
  const rate = total > 0 ? Math.round((done / total) * 100) : 0;
  const rateEl = document.getElementById('dash-rate');
  if (rateEl) rateEl.textContent = rate + '%';
  const subEl = document.getElementById('dash-rate-sub');
  if (subEl) subEl.textContent = `${done} of ${total} jobs`;

  // recent list
  const list = document.getElementById('recent-mints');
  if (!list) return;
  if (cards.length === 0) {
    list.innerHTML = '<div class="recent-empty">No mints yet.</div>';
    return;
  }
  list.innerHTML = cards.slice(0, 3).map(card => {
    const status = card.querySelector('.job-status')?.textContent?.toLowerCase() || '';
    const title = card.querySelector('.job-header span')?.textContent || 'mint job';
    const minted = parseInt(card.dataset.minted || '0');
    const cls = status.includes('fail') ? 'fail' : status.includes('run') || status.includes('pend') ? 'run' : 'ok';
    const icon = cls === 'fail' ? '✕' : cls === 'run' ? '…' : '✓';
    const amt = cls === 'fail' ? 'failed' : `+${minted}`;
    return `<div class="recent-item">
      <span class="recent-icon ${cls}">${icon}</span>
      <div class="recent-meta">
        <div class="recent-title">${dashboardEscape(title)}</div>
        <div class="recent-sub">${dashboardEscape(status)}</div>
      </div>
      <span class="recent-amount ${cls === 'run' ? '' : cls}">${dashboardEscape(amt)}</span>
    </div>`;
  }).join('');
}

if (_jobsListEl) new MutationObserver(renderDashStats).observe(_jobsListEl, { childList: true, subtree: true });
renderDashStats();

