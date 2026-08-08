// rusminter — frontend logic
// adapted from original app.js for monochrome minimal design

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

function setButtonBusy(button, busy, busyLabel = 'working…') {
  if (!button) return;
  if (!button.dataset.defaultHtml) button.dataset.defaultHtml = button.innerHTML;
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent.trim();
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.classList.toggle('is-loading', busy);
  if (busy) {
    button.textContent = busyLabel;
  } else {
    button.innerHTML = button.dataset.defaultHtml;
  }
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
  const modalOpen = Boolean(document.querySelector('.modal:not(.hidden)'));
  document.body.classList.toggle('scroll-locked', modalOpen);
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

// ─── Tab navigation (tab nav) ───

document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn[data-tab]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add('active');

    if (btn.dataset.tab === 'jobs' || btn.dataset.tab === 'activity') {
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
  setTableLoading('#chains-table', 6, 'loading chains…');
  const raw = await api('GET', '/chains');
  const loadError = Array.isArray(raw) ? '' : (raw?.error || 'unable to load chains.');
  const chains = Array.isArray(raw) ? raw : [];
  dashboardState.chains = chains;
  renderDashboardNetworks(chains);

  for (const selectId of ['mint-chain', 'mass-chain']) {
    const select = document.getElementById(selectId);
    if (!select) continue;
    const current = select.value;
    select.replaceChildren();
    if (!chains.length) {
      select.appendChild(new Option(loadError ? 'chains unavailable' : 'no chains configured', ''));
      select.disabled = true;
      continue;
    }
    select.disabled = false;
    for (const chain of chains) {
      const label = isRobinhoodChain(chain) ? `robinhood (${chain.id})` : `${chain.name} (${chain.id})`;
      select.appendChild(new Option(label, chain.name));
    }
    select.value = preferredChainName(chains, current);
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
      ? '<strong>chains could not be loaded.</strong><span>check the server connection and try refresh.</span>'
      : '<strong>no chains configured.</strong><span>add a network above to enable minting.</span>';
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
      deleteButton.className = 'action-btn small';
      deleteButton.textContent = 'delete';
      deleteButton.addEventListener('click', () => deleteChain(chain.name));
      actionsCell.appendChild(deleteButton);
    }
    const testButton = document.createElement('button');
    testButton.type = 'button';
    testButton.className = 'action-btn small';
    testButton.textContent = 'test';
    testButton.addEventListener('click', () => testChainRpc(rpc));
    actionsCell.appendChild(testButton);

    row.append(nameCell, idCell, rpcCell, explorerCell, seadropCell, actionsCell);
    tbody.appendChild(row);
  }
}

// ─── Chain Management ───

window.deleteChain = async function(name) {
  if (!window.confirm(`delete "${name}" chain configuration?`)) return;
  const data = await api('DELETE', `/chains/${encodeURIComponent(name)}`);
  if (data.error) {
    toast(data.error, 'error');
    return;
  }
  await loadChains();
  appendLog(`[CHAIN] deleted ${name}`);
  toast(`chain ${name} deleted`, 'success');
};

window.testChainRpc = async function(rpc) {
  await testRpc(rpc);
};

async function testRpc(rpc) {
  const result = document.getElementById('chain-test-result');
  setPanelState(result, 'testing rpc connection…', 'loading');

  const data = await api('POST', '/chains/test', { rpc });
  if (data.status === 'ok') {
    result.classList.remove('is-loading', 'is-error');
    result.classList.add('is-success');
    result.setAttribute('role', 'status');
    result.innerHTML = `
      <strong>rpc connected</strong>
      <div class="stat">chain id: <strong>${escapeHtml(data.chainId)}</strong></div>
      <div class="stat">block: <strong>${escapeHtml(Number(data.blockNumber || 0).toLocaleString())}</strong></div>
      <div class="stat">ens: <strong>${escapeHtml(data.ens || 'n/a')}</strong></div>
    `;
    return data;
  }

  setPanelState(result, data.error || 'rpc connection failed.', 'error');
  return null;
}

document.getElementById('chain-test')?.addEventListener('click', async () => {
  const rpcInput = document.getElementById('chain-rpc');
  const rpc = rpcInput.value.trim();
  setFieldValidity(rpcInput);
  if (!rpc) {
    setFieldValidity(rpcInput, 'rpc url is required');
    setPanelState(document.getElementById('chain-test-result'), 'enter an rpc url before testing.', 'error');
    return;
  }
  if (!isValidHttpUrl(rpc)) {
    setFieldValidity(rpcInput, 'rpc url must begin with http:// or https://');
    setPanelState(document.getElementById('chain-test-result'), 'enter a valid http or https rpc url.', 'error');
    return;
  }
  const button = document.getElementById('chain-test');
  setButtonBusy(button, true, 'testing…');
  await testRpc(rpc);
  setButtonBusy(button, false);
});

document.getElementById('chain-add')?.addEventListener('click', async () => {
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
    if (!name) setFieldValidity(nameInput, 'chain name is required');
    else if (!id) setFieldValidity(idInput, 'chain id is required');
    else setFieldValidity(rpcInput, 'rpc url is required');
    setPanelState(resultPanel, 'chain name, chain id, and rpc url are required.', 'error');
    return;
  }
  if (!Number.isInteger(numericChainId) || numericChainId < 1) {
    setFieldValidity(idInput, 'chain id must be a positive integer');
    setPanelState(resultPanel, 'enter a valid positive numeric chain id.', 'error');
    return;
  }
  if (!isValidHttpUrl(rpc)) {
    setFieldValidity(rpcInput, 'rpc url must begin with http:// or https://');
    setPanelState(resultPanel, 'enter a valid http or https rpc url.', 'error');
    return;
  }
  if (explorer && !isValidHttpUrl(explorer)) {
    setFieldValidity(explorerInput, 'explorer url must begin with http:// or https://');
    setPanelState(resultPanel, 'enter a valid explorer url or leave it blank.', 'error');
    return;
  }
  if (seadrop && !isValidEvmAddress(seadrop)) {
    setFieldValidity(seadropInput, 'seadrop must be a valid 0x contract address');
    setPanelState(resultPanel, 'enter a valid seadrop contract address or leave it blank.', 'error');
    return;
  }

  const button = document.getElementById('chain-add');
  setButtonBusy(button, true, 'adding…');
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
  appendLog(`[CHAIN] added ${name} (id: ${id})`);
  setPanelState(resultPanel, `chain "${name}" was added successfully.`, 'success');
  toast(`chain ${name} added`, 'success');
});

// ─── Themed mint wallet selector ───

const mintWalletSelectorModal = document.getElementById('mint-selector-modal');
const mintWalletTrigger = document.getElementById('mint-wallet-trigger');
const mintWalletSearch = document.getElementById('mint-selector-search-input');
const mintWalletOptions = document.getElementById('mint-selector-options');
const mintWalletEmpty = document.getElementById('mint-selector-empty');
let mintWalletSelectorReturnFocus = null;

function getSelectedMintWallet() {
  const select = document.getElementById('mint-wallet');
  if (!select) return null;
  return dashboardState.wallets.find(wallet => String(wallet.index - 1) === String(select.value)) || null;
}

function formatMintWalletLabel(wallet) {
  if (!wallet) return 'select wallet';
  return `#${wallet.index} · ${wallet.address.slice(0, 8)}…${wallet.address.slice(-4)}`;
}

function syncMintWalletTrigger() {
  if (!mintWalletTrigger) return;
  const label = document.getElementById('mint-wallet-trigger-label');
  const selected = getSelectedMintWallet();
  const hasWallets = dashboardState.wallets.length > 0;
  if (label) {
    label.textContent = selected
      ? formatMintWalletLabel(selected)
      : (hasWallets ? 'select wallet' : 'no wallets configured');
  }
  mintWalletTrigger.disabled = !hasWallets;
}

function renderMintWalletSelectorOptions(query = '') {
  if (!mintWalletOptions || !mintWalletEmpty) return;
  const needle = String(query || '').trim().toLowerCase();
  const selectedValue = document.getElementById('mint-wallet')?.value ?? '';
  const wallets = dashboardState.wallets.filter(wallet => {
    if (!needle) return true;
    return String(wallet.index).includes(needle) || String(wallet.address || '').toLowerCase().includes(needle);
  });

  mintWalletOptions.replaceChildren();
  mintWalletEmpty.hidden = wallets.length > 0;

  wallets.forEach(wallet => {
    const value = String(wallet.index - 1);
    const option = document.createElement('button');
    option.type = 'button';
    option.className = `mint-wallet-option${value === String(selectedValue) ? ' is-selected' : ''}`;
    option.dataset.walletValue = value;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(value === String(selectedValue)));
    option.innerHTML = `
      <span class="mint-wallet-option-badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M20 7H5a2 2 0 0 1-2-2 2 2 0 0 1 2-2h13v4"/>
          <path d="M3 5v13a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1"/>
          <circle cx="16.5" cy="14" r="1.2"/>
        </svg>
      </span>
      <span class="mint-wallet-option-copy">
        <span class="mint-wallet-option-name">wallet #${escapeHtml(wallet.index)}</span>
        <span class="mint-wallet-option-address">${escapeHtml(wallet.address)}</span>
      </span>
      <span class="mint-wallet-option-check" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><path d="m6 12 4 4 8-8"/></svg>
      </span>`;
    mintWalletOptions.appendChild(option);
  });
}

function setMintWalletSelectorOpen(open, restoreFocus = true) {
  if (!mintWalletSelectorModal || !mintWalletTrigger) return;
  const shouldOpen = Boolean(open);
  if (shouldOpen) {
    mintWalletSelectorReturnFocus = document.activeElement;
    mintWalletSelectorModal.classList.remove('hidden');
    mintWalletTrigger.setAttribute('aria-expanded', 'true');
    if (mintWalletSearch) mintWalletSearch.value = '';
    renderMintWalletSelectorOptions();
    syncBodyScrollLock();
    requestAnimationFrame(() => mintWalletSearch?.focus());
    return;
  }

  mintWalletSelectorModal.classList.add('hidden');
  mintWalletTrigger.setAttribute('aria-expanded', 'false');
  syncBodyScrollLock();
  if (restoreFocus) (mintWalletSelectorReturnFocus || mintWalletTrigger)?.focus?.();
  mintWalletSelectorReturnFocus = null;
}

mintWalletTrigger?.addEventListener('click', () => setMintWalletSelectorOpen(true));
document.getElementById('mint-selector-close')?.addEventListener('click', () => setMintWalletSelectorOpen(false));
mintWalletSelectorModal?.querySelectorAll('[data-close-mint-selector]').forEach(control => {
  control.addEventListener('click', () => setMintWalletSelectorOpen(false));
});
mintWalletSearch?.addEventListener('input', event => renderMintWalletSelectorOptions(event.currentTarget.value));
mintWalletOptions?.addEventListener('click', event => {
  const option = event.target.closest('[data-wallet-value]');
  if (!option) return;
  const select = document.getElementById('mint-wallet');
  if (!select) return;
  select.value = option.dataset.walletValue;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  syncMintWalletTrigger();
  setMintWalletSelectorOpen(false);
});
document.getElementById('mint-wallet')?.addEventListener('change', syncMintWalletTrigger);

// ─── Wallets ───

async function loadWallets() {
  setTableLoading('#wallets-table', 4, 'loading wallets…');
  const massListLoading = document.getElementById('mass-wallets');
  if (massListLoading) {
    massListLoading.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'combo-empty';
    loading.textContent = 'loading wallets…';
    massListLoading.appendChild(loading);
  }
  const raw = await api('GET', '/wallets');
  const loadError = Array.isArray(raw) ? '' : (raw?.error || 'unable to load wallets.');
  const wallets = Array.isArray(raw) ? raw : [];
  dashboardState.wallets = wallets;
  renderDashboardWallets(wallets);
  document.getElementById('wallet-count').textContent = `${wallets.length} wallet${wallets.length === 1 ? '' : 's'}`;

  for (const selectId of ['mint-wallet']) {
    const select = document.getElementById(selectId);
    if (!select) continue;
    const current = select.value;
    select.replaceChildren();
    if (!wallets.length) {
      select.appendChild(new Option(loadError ? 'wallets unavailable' : 'no wallets configured', ''));
      select.disabled = true;
      continue;
    }
    select.disabled = false;
    wallets.forEach(wallet => {
      const label = `#${wallet.index} · ${wallet.address.slice(0, 8)}…${wallet.address.slice(-4)}`;
      select.appendChild(new Option(label, wallet.index - 1));
    });
    if ([...select.options].some(option => option.value === current)) {
      select.value = current;
    }
  }
  syncMintWalletTrigger();
  if (mintWalletSelectorModal && !mintWalletSelectorModal.classList.contains('hidden')) {
    renderMintWalletSelectorOptions(mintWalletSearch?.value || '');
  }

  const massList = document.getElementById('mass-wallets');
  massList.replaceChildren();
  if (!wallets.length) {
    const empty = document.createElement('p');
    empty.className = 'combo-empty';
    empty.textContent = loadError
      ? 'wallets could not be loaded. check the server connection.'
      : 'no wallets available. generate a wallet first.';
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
      checkbox.setAttribute('aria-label', `wallet ${wallet.index}, ${wallet.address}`);
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
      ? '<strong>wallets could not be loaded.</strong><span>check the server connection and try refresh.</span>'
      : '<strong>no wallets generated.</strong><span>generate a wallet to begin minting.</span>';
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
    addressCell.setAttribute('aria-label', `copy wallet ${wallet.index} address`);
    addressCell.textContent = wallet.address.length > 16
      ? `${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)}`
      : wallet.address;

    const balanceCell = document.createElement('td');
    balanceCell.id = `bal-${wallet.address}`;
    balanceCell.textContent = 'not checked';

    const actionsCell = document.createElement('td');
    actionsCell.className = 'table-actions';
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'action-btn small';
    deleteButton.textContent = 'delete';
    deleteButton.addEventListener('click', () => deleteWallet(wallet.index, wallet.address));
    actionsCell.appendChild(deleteButton);

    row.append(indexCell, addressCell, balanceCell, actionsCell);
    tbody.appendChild(row);
  });
}

document.getElementById('wallet-refresh')?.addEventListener('click', async (event) => {
  setButtonBusy(event.currentTarget, true, 'refreshing…');
  await loadWallets();
  setButtonBusy(event.currentTarget, false);
});

window.deleteWallet = async function(index, address) {
  if (!window.confirm(`delete wallet #${index}? make sure its private key is backed up.`)) return;
  const data = await api('DELETE', `/wallets/${encodeURIComponent(address)}`);
  if (data.error) {
    toast(data.error, 'error');
    return;
  }
  appendLog(`[WALLET] deleted #${index} (${address.slice(0, 10)}…). total: ${data.total}`);
  await loadWallets();
  toast(`wallet #${index} deleted`, 'success');
};

document.getElementById('wallet-generate')?.addEventListener('click', async () => {
  const countInput = document.getElementById('wallet-gen-count');
  const count = Number.parseInt(countInput.value, 10);
  const panel = document.getElementById('wallet-gen-result');
  setFieldValidity(countInput);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    setFieldValidity(countInput, 'wallet count must be between 1 and 100');
    setPanelState(panel, 'enter a wallet count between 1 and 100.', 'error');
    return;
  }

  const button = document.getElementById('wallet-generate');
  setButtonBusy(button, true, 'generating…');
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
  summary.textContent = `generated ${result.generated} wallet${result.generated === 1 ? '' : 's'}. total: ${result.total}.`;
  panel.appendChild(summary);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-wrap generated-wallets-table';
  const table = document.createElement('table');
  table.innerHTML = '<caption class="sr-only">newly generated wallets</caption><thead><tr><th scope="col">#</th><th scope="col">address</th></tr></thead>';
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

  appendLog(`[WALLET] generated ${result.generated} wallets. total: ${result.total}`);
  await loadWallets();
  setButtonBusy(button, false);
  panel.tabIndex = -1;
  panel.focus();
  toast(`${result.generated} wallet${result.generated === 1 ? '' : 's'} generated`, 'success');
});

document.getElementById('wallet-check-all')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  setButtonBusy(button, true, 'checking…');
  const raw = await api('GET', '/wallets');
  const wallets = Array.isArray(raw) ? raw : [];
  for (const wallet of wallets) {
    const data = await api('GET', `/wallet/${encodeURIComponent(wallet.address)}`);
    const cell = document.getElementById(`bal-${wallet.address}`);
    if (!cell) continue;
    cell.replaceChildren();
    if (data.error || !data.balances || typeof data.balances !== 'object') {
      cell.textContent = data.error || 'balance unavailable';
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
  toast('wallet balances updated', 'success');
});

// ─── Resolve ───

document.getElementById('mint-resolve')?.addEventListener('click', async (event) => {
  const inputElement = document.getElementById('mint-input');
  const input = inputElement.value.trim();
  const info = document.getElementById('mint-resolve-info');
  setFieldValidity(inputElement);
  if (!input) {
    setFieldValidity(inputElement, 'collection url or contract address is required');
    setPanelState(info, 'enter an opensea url or contract address to resolve.', 'error');
    return;
  }

  const button = event.currentTarget;
  setButtonBusy(button, true, 'resolving…');
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
    <h3>collection resolved</h3>
    <div class="stat">contract: <strong>${escapeHtml(data.contract)}</strong></div>
    <div class="stat">chain: <strong>${escapeHtml(data.chain)}</strong></div>
    ${data.name ? `<div class="stat">collection: <strong>${escapeHtml(data.name)}</strong></div>` : ''}
    ${data.totalSupply !== undefined ? `<div class="stat">total supply: <strong>${escapeHtml(data.totalSupply)}</strong></div>` : ''}
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
    setFieldValidity(inputElement, 'collection url or contract address is required');
    setPanelState(info, 'enter an opensea url or contract address before starting.', 'error');
    return;
  }
  if (!chain || !Number.isInteger(walletIndex)) {
    setPanelState(info, 'select a configured chain and wallet before starting.', 'error');
    return;
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
    setFieldValidity(amountInput, 'quantity must be between 1 and 100');
    setPanelState(info, 'enter a mint quantity between 1 and 100.', 'error');
    return;
  }

  const button = dryRun ? document.getElementById('mint-dryrun') : document.getElementById('mint-execute');
  setButtonBusy(button, true, dryRun ? 'simulating…' : 'starting…');
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
  toast(dryRun ? 'dry run started' : 'mint job started', 'success');
}

document.getElementById('mint-dryrun')?.addEventListener('click', () => doMint(true));
document.getElementById('mint-execute')?.addEventListener('click', () => doMint(false));

// ─── Mass mint ───

function syncMassStepper(input) {
  if (!input) return;
  const stepper = input.closest('.mass-stepper');
  if (!stepper) return;
  const min = Number.parseInt(input.min, 10);
  const max = Number.parseInt(input.max, 10);
  const value = Number.parseInt(input.value, 10);
  const minus = stepper.querySelector('.mass-stepper-btn[data-step="-1"]');
  const plus = stepper.querySelector('.mass-stepper-btn[data-step="1"]');
  if (minus) minus.disabled = Number.isInteger(value) && Number.isInteger(min) && value <= min;
  if (plus) plus.disabled = Number.isInteger(value) && Number.isInteger(max) && value >= max;
}

function adjustMassStepper(button) {
  const input = document.getElementById(button.dataset.stepTarget || '');
  if (!input) return;
  const delta = Number.parseInt(button.dataset.step, 10) || 0;
  const min = Number.parseInt(input.min, 10);
  const max = Number.parseInt(input.max, 10);
  const fallback = Number.isInteger(min) ? min : 0;
  const current = Number.parseInt(input.value, 10);
  let next = (Number.isInteger(current) ? current : fallback) + delta;
  if (Number.isInteger(min)) next = Math.max(min, next);
  if (Number.isInteger(max)) next = Math.min(max, next);
  input.value = String(next);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  syncMassStepper(input);
}

document.querySelectorAll('.mass-stepper-btn').forEach(button => {
  button.addEventListener('click', () => adjustMassStepper(button));
});

document.querySelectorAll('.mass-stepper .mass-setting-input').forEach(input => {
  input.addEventListener('input', () => syncMassStepper(input));
  input.addEventListener('change', () => syncMassStepper(input));
  syncMassStepper(input);
});

document.getElementById('mass-select-all')?.addEventListener('click', () => {
  document.querySelectorAll('#mass-wallets input[type="checkbox"]').forEach(cb => cb.checked = true);
  updateMassSelected();
});

document.getElementById('mass-select-none')?.addEventListener('click', () => {
  document.querySelectorAll('#mass-wallets input[type="checkbox"]').forEach(cb => cb.checked = false);
  updateMassSelected();
});

async function doMassMint() {
  const inputElement = document.getElementById('mass-input');
  const input = inputElement?.value.trim() || '';
  const chain = document.getElementById('mass-chain')?.value || '';
  const amountInput = document.getElementById('mass-amount');
  const concurrentInput = document.getElementById('mass-concurrent');
  const amount = Number.parseInt(amountInput?.value, 10);
  const concurrent = Number.parseInt(concurrentInput?.value, 10);
  const info = document.getElementById('mass-status-info');
  const walletIndices = Array.from(document.querySelectorAll('#mass-wallets input[type="checkbox"]:checked'))
    .map(checkbox => Number.parseInt(checkbox.value, 10));

  setFieldValidity(inputElement);
  setFieldValidity(amountInput);
  setFieldValidity(concurrentInput);
  if (!input) {
    setFieldValidity(inputElement, 'collection url or contract address is required');
    setPanelState(info, 'enter an opensea url or contract address before starting.', 'error');
    return;
  }
  if (!chain) {
    setPanelState(info, 'select a configured chain before starting.', 'error');
    return;
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
    setFieldValidity(amountInput, 'quantity must be between 1 and 100');
    setPanelState(info, 'enter a quantity between 1 and 100 per wallet.', 'error');
    return;
  }
  if (!Number.isInteger(concurrent) || concurrent < 1 || concurrent > 10) {
    setFieldValidity(concurrentInput, 'concurrency must be between 1 and 10');
    setPanelState(info, 'enter a concurrency value between 1 and 10.', 'error');
    return;
  }
  if (walletIndices.length === 0) {
    document.getElementById('mass-combo-trigger')?.focus();
    setPanelState(info, 'select at least one wallet before starting.', 'error');
    return;
  }

  const button = document.getElementById('mass-execute');
  setButtonBusy(button, true, 'starting…');
  showConsole();
  const data = await api('POST', '/mass-mint', {
    input,
    chain,
    amount,
    walletIndices,
    maxConcurrent: concurrent,
    dryRun: false,
  });
  if (data.error) {
    appendLog(`[ERROR] ${data.error}`);
    setButtonBusy(button, false);
    toast(data.error, 'error');
    return;
  }

  currentJobId = data.jobId;
  button.dataset.activeJob = String(data.jobId);
  appendLog(`[JOB] ${data.jobId} — mass mint ${walletIndices.length} wallets × ${amount} on ${chain} · concurrency ${concurrent}`);
  setPanelState(
    info,
    `mass mint started for ${walletIndices.length} wallet${walletIndices.length === 1 ? '' : 's'} × ${amount} with concurrency ${concurrent}. follow the live log below.`,
    'success'
  );
  toast('mass mint job started', 'success');
}

document.getElementById('mass-execute')?.addEventListener('click', () => doMassMint());

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
    empty.innerHTML = '<strong>configuration unavailable</strong><span>reload the page or check the server connection.</span>';
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

document.getElementById('config-save')?.addEventListener('click', async (event) => {
  const inputs = document.querySelectorAll('[data-config-key]');
  const config = {};
  inputs.forEach(input => {
    config[input.dataset.configKey] = input.value;
  });
  const button = event.currentTarget;
  setButtonBusy(button, true, 'saving…');
  const data = await api('POST', '/config', { config });
  setButtonBusy(button, false);
  if (data.status === 'ok') toast('configuration saved', 'success');
  else toast(data.error || 'configuration could not be saved', 'error');
});

// ─── Jobs ───

async function refreshJobs() {
  const list = document.getElementById('jobs-list');
  if (list) list.setAttribute('aria-busy', 'true');
  const raw = await api('GET', '/jobs');
  const loadError = Array.isArray(raw) ? '' : (raw?.error || 'unable to load jobs.');
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
    title.textContent = loadError ? 'jobs could not be loaded.' : (jobs.length ? 'no jobs match these filters.' : 'no minting jobs yet.');
    const description = document.createElement('span');
    description.textContent = loadError ? 'check the server connection and use refresh to try again.' : (jobs.length ? 'clear the search or choose another status.' : 'started jobs will appear here with status and logs.');
    empty.append(title, description);
    list.appendChild(empty);
    list.setAttribute('aria-busy', 'false');
    return;
  }

  for (const job of filtered) {
    const logs = Array.isArray(job.logs) ? job.logs : [];
    const card = document.createElement('article');
    card.className = 'job-item';
    const status = ['pending', 'running', 'completed', 'failed'].includes(job.status) ? job.status : 'pending';
    const createdAt = new Date(job.createdAt);
    const time = Number.isNaN(createdAt.getTime()) ? 'unknown time' : createdAt.toLocaleTimeString();

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
    idLine.textContent = `job id: ${job.id}`;
    card.append(header, idLine);

    if (job.result) {
      const resultLine = document.createElement('div');
      resultLine.className = 'stat';
      resultLine.append('result: ');
      const code = document.createElement('code');
      code.textContent = JSON.stringify(job.result).slice(0, 500);
      resultLine.appendChild(code);
      card.appendChild(resultLine);
    }
    if (job.error) {
      const errorLine = document.createElement('div');
      errorLine.className = 'stat job-error';
      errorLine.textContent = `error: ${job.error}`;
      card.appendChild(errorLine);
    }

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `logs (${logs.length})`;
    const pre = document.createElement('pre');
    pre.textContent = logs.join('\n');
    details.append(summary, pre);
    card.appendChild(details);
    list.appendChild(card);
  }
  list.setAttribute('aria-busy', 'false');
}

document.getElementById('jobs-refresh')?.addEventListener('click', async (event) => {
  setButtonBusy(event.currentTarget, true, 'refreshing…');
  await refreshJobs();
  setButtonBusy(event.currentTarget, false);
});

// ─── Logs Tab ───

const allLogs = [];
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
    empty.textContent = allLogs.length ? 'no logs match the current filters.' : 'no log entries yet.';
    output.appendChild(empty);
  } else {
    matched.forEach(entry => output.appendChild(createLogLine(entry)));
  }
  if (logsAutoScroll) output.scrollTop = output.scrollHeight;
}

document.getElementById('logs-filter')?.addEventListener('input', renderAllLogs);
document.getElementById('logs-source')?.addEventListener('change', renderAllLogs);
renderAllLogs();

document.getElementById('logs-clear')?.addEventListener('click', () => {
  if (allLogs.length && !window.confirm('clear all log entries from this view?')) return;
  allLogs.length = 0;
  renderAllLogs();
});

document.getElementById('logs-download')?.addEventListener('click', () => {
  const text = allLogs.map(e => `${e.time} [${e.source}] ${e.message}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rusminter-logs-${new Date().toISOString().slice(0, 19)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

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

document.getElementById('console-clear')?.addEventListener('click', () => {
  document.getElementById('console-output').replaceChildren();
});

document.getElementById('console-toggle')?.addEventListener('click', (event) => {
  const output = document.getElementById('console-output');
  const button = event.currentTarget;
  const expanded = button.getAttribute('aria-expanded') !== 'false';
  output.hidden = expanded;
  button.textContent = expanded ? '+' : '−';
  button.setAttribute('aria-expanded', String(!expanded));
});

function updateJobStatus(data) {
  if (data.status === 'completed') {
    appendLog('[DONE] job completed');
  } else if (data.status === 'failed') {
    appendLog(`[FAIL] ${data.error || 'job failed'}`);
  }
  ['mint-dryrun', 'mint-execute', 'mass-execute'].forEach(id => {
    const button = document.getElementById(id);
    if (button?.dataset.activeJob === String(data.id || currentJobId)) {
      delete button.dataset.activeJob;
      setButtonBusy(button, false);
    }
  });
}

// ─── Auth ───

function renderAuthStatus(enabled, message = '') {
  const section = document.getElementById('auth-section');
  section.replaceChildren();
  const note = document.createElement('div');
  note.className = `auth-note ${enabled ? 'ok' : 'warn'}`;
  const dot = document.createElement('span');
  dot.className = 'auth-dot';
  dot.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('span');
  copy.textContent = message || (enabled ? 'password protection enabled' : 'no password set. panel is open access.');
  note.append(dot, copy);
  section.appendChild(note);
}

async function checkAuth() {
  try {
    const response = await fetch('/api/auth/status', { headers: { Accept: 'application/json' } });
    const data = await response.json();
    const enabled = Boolean(data.enabled);
    document.getElementById('logout-btn').style.display = enabled ? '' : 'none';
    document.getElementById('change-password-form').classList.toggle('hidden', !enabled);
    document.getElementById('set-password-form').classList.toggle('hidden', enabled);
    renderAuthStatus(enabled);
  } catch (_) {
    renderAuthStatus(false, 'security status is unavailable. check the server connection.');
  }
}

document.getElementById('logout-btn')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  setButtonBusy(button, true, 'signing out…');
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  } catch (_) {
    setButtonBusy(button, false);
    toast('unable to sign out. try again.', 'error');
  }
});

document.getElementById('set-pw-btn')?.addEventListener('click', async (event) => {
  const passwordInput = document.getElementById('set-pw');
  const confirmInput = document.getElementById('set-pw-confirm');
  const password = passwordInput.value;
  const confirmation = confirmInput.value;
  setFieldValidity(passwordInput);
  setFieldValidity(confirmInput);

  if (password.length < 8) {
    setFieldValidity(passwordInput, 'password must contain at least 8 characters');
    toast('use at least 8 characters for the password', 'error');
    return;
  }
  if (password !== confirmation) {
    setFieldValidity(confirmInput, 'passwords do not match');
    toast('the passwords do not match', 'error');
    return;
  }

  const button = event.currentTarget;
  setButtonBusy(button, true, 'setting password…');
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
      toast('password protection enabled', 'success');
      await checkAuth();
    } else {
      toast(data.error || 'password could not be set', 'error');
    }
  } catch (_) {
    toast('the server could not be reached', 'error');
  } finally {
    setButtonBusy(button, false);
  }
});

document.getElementById('change-password-btn')?.addEventListener('click', async (event) => {
  const oldInput = document.getElementById('old-password');
  const newInput = document.getElementById('new-password');
  const confirmInput = document.getElementById('confirm-password');
  const oldPassword = oldInput.value;
  const newPassword = newInput.value;
  const confirmation = confirmInput.value;
  [oldInput, newInput, confirmInput].forEach(input => setFieldValidity(input));

  if (!oldPassword) {
    setFieldValidity(oldInput, 'current password is required');
    toast('enter the current password', 'error');
    return;
  }
  if (newPassword.length < 8) {
    setFieldValidity(newInput, 'password must contain at least 8 characters');
    toast('use at least 8 characters for the new password', 'error');
    return;
  }
  if (newPassword !== confirmation) {
    setFieldValidity(confirmInput, 'passwords do not match');
    toast('the new passwords do not match', 'error');
    return;
  }

  const button = event.currentTarget;
  setButtonBusy(button, true, 'changing…');
  try {
    const response = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    const data = await response.json();
    if (response.ok && data.status === 'ok') {
      [oldInput, newInput, confirmInput].forEach(input => { input.value = ''; });
      toast('password changed successfully', 'success');
    } else {
      toast(data.error || 'password could not be changed', 'error');
    }
  } catch (_) {
    toast('the server could not be reached', 'error');
  } finally {
    setButtonBusy(button, false);
  }
});

checkAuth();
init();

// ─── Toast notifications ───

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

// ─── Copy address ───

async function copyAddress(target) {
  const text = target?.getAttribute('data-copy');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('address copied', 'success');
  } catch (_) {
    toast('address could not be copied', 'error');
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-copy]');
  if (target) copyAddress(target);
});

// ─── Generate wallet modal ───

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

// ─── Mass mint combo ───

function updateMassSelected() {
  const boxes = [...document.querySelectorAll('#mass-wallets input[type="checkbox"]')];
  const checked = boxes.filter(checkbox => checkbox.checked);
  const counter = document.getElementById('mass-selected-count');
  if (counter) counter.textContent = `${checked.length} of ${boxes.length} selected`;
  const label = document.getElementById('mass-combo-label');
  if (label) {
    label.textContent = boxes.length === 0
      ? 'no wallets — generate one first'
      : `${checked.length} of ${boxes.length} wallets selected`;
    label.classList.toggle('has', checked.length > 0);
  }
  boxes.forEach(checkbox => {
    checkbox.closest('[role="option"]')?.setAttribute('aria-selected', String(checkbox.checked));
  });
}

document.getElementById('mass-wallets')?.addEventListener('change', updateMassSelected);

const combo = document.getElementById('mass-wallet-combo');
const comboPanel = document.getElementById('mass-combo-panel');
const comboTrigger = document.getElementById('mass-combo-trigger');

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

comboPanel?.addEventListener('click', event => event.stopPropagation());
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
});

// ─── Jobs filters ───

document.getElementById('jobs-filter')?.addEventListener('input', refreshJobs);
document.getElementById('jobs-status-filter')?.addEventListener('change', refreshJobs);

// ─── Password toggles ───

document.querySelectorAll('[data-pw-toggle]').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.getAttribute('data-pw-toggle'));
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'hide password' : 'show password');
  });
});

// ─── Activity calendar + chart ───

function collectDailyMints() {
  const daily = {};
  document.querySelectorAll('#jobs-list .job-item').forEach(card => {
    const date = card.dataset.jobDate;
    const minted = parseInt(card.dataset.minted || '0');
    if (date && minted > 0) daily[date] = (daily[date] || 0) + minted;
  });
  return daily;
}

function tagJobCards() {
  document.querySelectorAll('#jobs-list .job-item').forEach(card => {
    if (card.dataset.tagged) return;
    card.dataset.tagged = '1';
    const resultText = card.querySelector('.stat code')?.textContent || '';
    let minted = 0;
    try {
      const r = JSON.parse(resultText);
      if (typeof r === 'object' && r !== null) {
        if (typeof r.success === 'number') {
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

  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();
  const todayStr = now.toISOString().slice(0, 10);

  let html = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'].map(d => `<div class="cal-day-name">${d}</div>`).join('');

  for (let i = firstDow - 1; i >= 0; i--) {
    html += `<div class="cal-day empty"><span class="cal-num">${daysInPrev - i}</span></div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const count = daily[key] || 0;
    const isToday = key === todayStr;
    html += `<div class="cal-day${isToday ? ' today' : ''}${count > 0 ? ' has-activity' : ''}">
      <span class="cal-num">${d}</span>
      ${count > 0 ? `<span class="cal-mint">+${count}</span>` : ''}
    </div>`;
  }

  const used = firstDow + daysInMonth;
  const trailing = 42 - used;
  for (let d = 1; d <= trailing; d++) {
    html += `<div class="cal-day empty"><span class="cal-num">${d}</span></div>`;
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

// ─── Dashboard stats ───

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

function renderDashboardWallets(wallets) {
  const count = document.getElementById('overview-wallets');
  if (count) count.textContent = wallets.length;
}

function renderDashboardNetworks(chains) {
  const count = document.getElementById('overview-chains');
  if (count) count.textContent = chains.length;
}

function renderDashboardJobs(jobs) {
  const totalEl = document.getElementById('overview-jobs');
  const mintedEl = document.getElementById('overview-minted');
  const rateEl = document.getElementById('overview-rate');
  const runningEl = document.getElementById('overview-running');

  const running = jobs.filter(job => job.status === 'running' || job.status === 'pending').length;
  const completed = jobs.filter(job => job.status === 'completed').length;
  const failed = jobs.filter(job => job.status === 'failed').length;
  const decided = completed + failed;
  const minted = jobs.reduce((sum, job) => sum + dashboardJobMinted(job), 0);
  const rate = decided ? Math.round(completed / decided * 100) : 0;

  if (totalEl) totalEl.textContent = jobs.length;
  if (mintedEl) mintedEl.textContent = minted.toLocaleString();
  if (rateEl) rateEl.textContent = `${rate}%`;
  if (runningEl) runningEl.textContent = running;
}

// ─── Socket.IO ───

socket.on('connect', () => {
  const serverStatus = document.getElementById('server-status');
  if (serverStatus) {
    serverStatus.textContent = 'connected';
    serverStatus.classList.add('ok');
  }
});

socket.on('disconnect', () => {
  const serverStatus = document.getElementById('server-status');
  if (serverStatus) {
    serverStatus.textContent = 'disconnected';
    serverStatus.classList.remove('ok');
  }
});

socket.on('log', ({ id, line }) => {
  appendLog(line, id);
  const cleanLine = line.replace(/^\[[\d:]+\]\s*/, '');
  addLogEntry(id ? `job:${id}` : 'system', cleanLine);
});

socket.on('status', (data) => {
  if (data.id === currentJobId) {
    updateJobStatus(data);
  }
  refreshJobs();
});

// ─── Escape key handler ───

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeMassCombo(true);
    if (mintWalletSelectorModal && !mintWalletSelectorModal.classList.contains('hidden')) setMintWalletSelectorOpen(false);
    if (genModal && !genModal.classList.contains('hidden')) setGenModalOpen(false);
  }
});
