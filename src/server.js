/**
 * NFT Minter Web Panel — Express + Socket.IO Server
 *
 * API endpoints:
 *   GET  /api/config          — load .env config
 *   POST /api/config          — save .env config
 *   POST /api/resolve         — resolve OpenSea URL → contract + chain + price
 *   POST /api/mint            — execute single mint
 *   POST /api/mass-mint       — execute multi-wallet mint
 *   GET  /api/wallets         — list wallets from wallets file
 *   GET  /api/wallet/:addr    — wallet balance across chains
 *   GET  /api/chains          — supported chains list
 *   GET  /api/jobs           — list mint jobs
 *   GET  /api/jobs/:id       — job status
 *
 * Socket.IO events:
 *   log    — real-time log line from minting process
 *   status — job status update
 *   done   — job completed
 */

import express from 'express';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import 'dotenv/config';
import { isAuthEnabled, verifyPassword, createSession, isValidSession, destroySession, setPassword, changePassword, disableAuth, loadAuth } from './auth.js';

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*', credentials: true } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

const PORT = process.env.PORT || 3137;

// ─── Auth Middleware ───

function authMiddleware(req, res, next) {
  // Skip auth for login page, login API, and static assets for login
  const publicPaths = ['/login.html', '/style.css', '/login.js', '/api/auth/login', '/api/auth/status', '/api/auth/setup'];
  if (publicPaths.includes(req.path) || req.path === '/') {
    return next();
  }

  if (!isAuthEnabled()) {
    return next(); // No auth set up — open access
  }

  // Check session token from cookie or header
  const token = req.cookies?.session || req.headers['x-session'];
  if (isValidSession(token)) {
    return next();
  }

  // API requests get JSON error, pages get redirected
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized', redirect: '/login.html' });
  }
  // For non-login HTML pages, redirect to login
  if (req.path.endsWith('.html') || req.path === '/index.html') {
    return res.redirect('/login.html');
  }
  // For other static files (JS/CSS), serve only if logged in
  next();
}

// Apply auth BEFORE static serving
app.use(authMiddleware);
app.use(express.static(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public')));

// ─── Config ───

const ENV_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.env');
const WALLETS_FILE = process.env.WALLETS_FILE || '/root/wallets/evm-wallets.json';
const CHAINS_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'chains.json');

// Load chains from chains.json (persisted, editable via web)
function loadChains() {
  try {
    const data = JSON.parse(fs.readFileSync(CHAINS_FILE, 'utf-8'));
    return data.chains || {};
  } catch {
    return {};
  }
}

function saveChains(chains) {
  fs.writeFileSync(CHAINS_FILE, JSON.stringify({ chains }, null, 2));
}

// Dynamic chain registry — loaded from chains.json, can be modified at runtime
let CHAINS = loadChains();

function getRpcUrl(chainName) {
  const chain = CHAINS[chainName];
  if (!chain) return null;
  return chain.rpc;
}

function getChainId(chainName) {
  const chain = CHAINS[chainName];
  if (!chain) return null;
  return chain.id;
}

function getExplorer(chainName) {
  const chain = CHAINS[chainName];
  if (!chain) return '';
  return chain.explorer || '';
}

function getSeadropAddr(chainName) {
  const chain = CHAINS[chainName];
  if (!chain) return null;
  return chain.seadrop || null;
}

// Build CHAIN_IDS and EXPLORERS maps dynamically for backward compat
function getChainIdsMap() {
  const map = {};
  for (const [name, cfg] of Object.entries(CHAINS)) map[name] = cfg.id;
  return map;
}

function getExplorersMap() {
  const map = {};
  for (const [name, cfg] of Object.entries(CHAINS)) map[name] = cfg.explorer || '';
  return map;
}

function getSeadropKnownMap() {
  const map = {};
  for (const [name, cfg] of Object.entries(CHAINS)) {
    if (cfg.seadrop) map[name] = cfg.seadrop;
  }
  return map;
}

// ─── Jobs tracking ───

const jobs = new Map();
let jobCounter = 0;

function createJob(type, data) {
  const id = `job_${++jobCounter}`;
  const job = { id, type, status: 'pending', data, logs: [], result: null, createdAt: Date.now() };
  jobs.set(id, job);
  return job;
}

function updateJob(id, updates) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, updates);
  io.emit('status', { id, ...updates });
}

function logJob(id, message) {
  const job = jobs.get(id);
  if (!job) return;
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
  job.logs.push(line);
  io.emit('log', { id, line });
}

// ─── SeaDrop helpers ───

async function discoverSeadropAddress(nftContract, provider, logFn) {
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const chainIds = getChainIdsMap();
  const chainName = Object.entries(chainIds).find(([_, id]) => id === chainId)?.[0];
  const seadropKnown = getSeadropKnownMap();
  if (chainName && seadropKnown[chainName]) {
    logFn(`[SEADROP] Using known address: ${seadropKnown[chainName]}`);
    return seadropKnown[chainName];
  }

  logFn('[SEADROP] Discovering from on-chain tx history...');
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const zeroAddr = ethers.zeroPadValue(ethers.ZeroAddress, 32);
  const currentBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: nftContract, topics: [transferTopic, zeroAddr],
    fromBlock: Math.max(0, currentBlock - 100000), toBlock: currentBlock,
  });
  if (logs.length === 0) throw new Error('no mint events to trace SeaDrop');
  const tx = await provider.getTransaction(logs[0].transactionHash);
  logFn(`[SEADROP] Discovered: ${tx.to}`);
  return tx.to;
}

async function getSeadropPriceAndFeeRecipient(seadropAddr, nftContract, provider, logFn) {
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const zeroAddr = ethers.zeroPadValue(ethers.ZeroAddress, 32);
  const currentBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: nftContract, topics: [transferTopic, zeroAddr],
    fromBlock: Math.max(0, currentBlock - 100000), toBlock: currentBlock,
  });

  if (logs.length > 0) {
    const tx = await provider.getTransaction(logs[0].transactionHash);
    if (tx && tx.value > 0n) {
      const txLogs = logs.filter(l => l.transactionHash === tx.hash);
      const quantity = txLogs.length;
      const pricePerNFT = tx.value / BigInt(quantity);
      const feeRecipient = '0x' + tx.data.slice(10 + 64, 10 + 128).slice(24);
      logFn(`[SEADROP] Price: ${ethers.formatEther(pricePerNFT)} ETH (qty=${quantity})`);
      logFn(`[SEADROP] Fee recipient: ${feeRecipient}`);
      return { pricePerNFT, feeRecipient };
    }
  }
  logFn('[SEADROP] No price found from tx — assuming free mint');
  return { pricePerNFT: 0n, feeRecipient: ethers.ZeroAddress };
}

// ─── Parse input ───

const CHAIN_SLUG_MAP = {
  ethereum: 'ethereum', eth: 'ethereum', mainnet: 'ethereum',
  base: 'base', matic: 'polygon', polygon: 'polygon',
  arbitrum: 'arbitrum', arb: 'arbitrum',
  optimism: 'optimism', op: 'optimism',
  zora: 'zora-network', 'zora-network': 'zora-network',
  robinhood: 'robinhood', rh: 'robinhood', bsc: 'bsc', binance: 'bsc',
};

function parseTarget(input) {
  const s = input.trim();
  let m = s.match(/opensea\.io\/assets\/([\w-]+)\/(0x[a-fA-F0-9]{40})(?:\/(\d+))?/);
  if (m) return { source: 'opensea', chain: CHAIN_SLUG_MAP[m[1]] || m[1], contract: m[2], tokenId: m[3] };

  m = s.match(/opensea\.io\/collection\/([\w-]+)/);
  if (m) return { source: 'opensea_slug', slug: m[1] };

  m = s.match(/(0x[a-fA-F0-9]{40})(?:\s+on\s+(\w+))?(?:\s+x?(\d+))?/i);
  if (m) return { source: 'direct', contract: m[1], chain: CHAIN_SLUG_MAP[m[2]] || m[2] || 'ethereum', amount: Number(m[3] || 1) };

  throw new Error('cannot parse mint target');
}

async function resolveOpenSeaSlug(slug, logFn) {
  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) throw new Error('OPENSEA_API_KEY not set');
  const r = await fetch(
    `${process.env.OPENSEA_API_BASE || 'https://api.opensea.io/api/v2'}/collections/${slug}`,
    { headers: { 'X-API-KEY': apiKey } }
  );
  const j = await r.json();
  if (!j.contracts || j.contracts.length === 0) throw new Error(`no contract found for "${slug}"`);
  const c = j.contracts[0];
  const chain = CHAIN_SLUG_MAP[c.chain] || c.chain;
  logFn(`[SLUG] ${slug} → ${c.address} on ${chain}`);
  logFn(`[COLLECTION] ${j.name || slug} | Supply: ${j.total_supply || '?'}/${j.unique_item_count || '?'} | Fees: ${(j.fees || []).map(f => f.fee + '%').join(', ')}`);
  return { contract: c.address, chain, slug, name: j.name, totalSupply: j.total_supply };
}

// ─── Mint execution ───

async function executeMint(target, wallet, amount, jobId, { dryRun = false } = {}) {
  const log = (msg) => logJob(jobId, msg);
  const rpcUrl = getRpcUrl(target.chain);
  if (!rpcUrl) throw new Error(`no RPC for chain "${target.chain}". Add it in Chains config tab.`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = wallet.connect(provider);
  const chainId = getChainId(target.chain);
  if (!chainId) throw new Error(`unknown chain ID for "${target.chain}". Add it in Chains config tab.`);

  log(`[TARGET] ${target.contract} on ${target.chain} × ${amount}`);
  log(`[WALLET] ${wallet.address}`);

  // Balance check
  const balance = await provider.getBalance(wallet.address);
  log(`[BALANCE] ${ethers.formatEther(balance)} ETH`);

  // SeaDrop detection via Blockscout
  const blockscoutMap = {
    ethereum: 'https://eth.blockscout.com',
    robinhood: 'https://robinhoodchain.blockscout.com',
    base: 'https://base.blockscout.com',
    arbitrum: 'https://arbitrum.blockscout.com',
    optimism: 'https://optimism.blockscout.com',
    polygon: 'https://polygon.blockscout.com',
    'zora-network': 'https://explorer.zora.energy',
    bsc: 'https://bsc.blockscout.com',
  };

  const blockscoutUrl = blockscoutMap[target.chain];
  let isSeadrop = false;
  if (blockscoutUrl) {
    try {
      const r = await fetch(`${blockscoutUrl}/api?module=contract&action=getabi&address=${target.contract}`);
      const j = await r.json();
      if (j.result && j.result !== 'Contract source code not verified') {
        const abi = JSON.parse(j.result);
        isSeadrop = abi.some(e => e.name === 'mintSeaDrop');
        if (isSeadrop) log('[FN] mintSeaDrop detected — SeaDrop flow');
      }
    } catch (e) {
      log('[FN] Blockscout ABI fetch failed, trying direct detection...');
    }
  }

  if (isSeadrop || !isSeadrop) {
    // SeaDrop flow
    const seadropAddr = await discoverSeadropAddress(target.contract, provider, log);
    const { pricePerNFT, feeRecipient } = await getSeadropPriceAndFeeRecipient(seadropAddr, target.contract, provider, log);
    const totalValue = pricePerNFT * BigInt(amount);

    log(`[PRICE] ${ethers.formatEther(pricePerNFT)} ETH × ${amount} = ${ethers.formatEther(totalValue)} ETH ($${(Number(ethers.formatEther(totalValue)) * 1884).toFixed(2)})`);

    if (totalValue > 0n && balance < totalValue + ethers.parseUnits('0.001', 'ether')) {
      throw new Error(`insufficient balance: ${ethers.formatEther(balance)} ETH < ${ethers.formatEther(totalValue)} ETH needed`);
    }

    const abi = ['function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable'];
    const seadrop = new ethers.Contract(seadropAddr, abi, signer);

    // Simulate
    try {
      await seadrop.mintPublic.staticCall(target.contract, feeRecipient, signer.address, amount, { value: totalValue });
      log('[SIM] OK — simulation passed');
    } catch (e) {
      const reason = e.reason || e.shortMessage || e.message;
      if (!dryRun) {
        log(`[SIM] revert: ${reason}`);
        // Continue anyway — staticCall may fail on some chains but actual tx succeeds
        log('[WARN] Simulation failed but proceeding (staticCall may not handle msg.value on this chain)');
      } else {
        log(`[SIM] revert: ${reason} (dry-run, continuing)`);
      }
    }

    if (dryRun) {
      log('[DRY-RUN] Would call mintPublic');
      log(`  nftContract: ${target.contract}`);
      log(`  seadrop: ${seadropAddr}`);
      log(`  feeRecipient: ${feeRecipient}`);
      log(`  minter: ${wallet.address}`);
      log(`  quantity: ${amount}`);
      log(`  value: ${ethers.formatEther(totalValue)} ETH`);
      return { status: 'dry-run', seadrop: seadropAddr, price: totalValue.toString(), pricePerNFT: pricePerNFT.toString() };
    }

    // Execute
    log('[SEND] Broadcasting tx...');
    const tx = await seadrop.mintPublic(target.contract, feeRecipient, signer.address, amount, {
      value: totalValue, gasLimit: 300000,
    });
    log(`[SENT] ${tx.hash}`);
    log(`[VIEW] ${getExplorer(target.chain) + tx.hash}`);

    const receipt = await tx.wait();
    log(`[OK] block ${receipt.blockNumber} gasUsed ${receipt.gasUsed.toString()}`);

    // Find minted token IDs
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const mintLogs = receipt.logs.filter(
      l => l.topics[0] === transferTopic && l.topics[1] === ethers.zeroPadValue(ethers.ZeroAddress, 32)
    );
    const tokenIds = mintLogs.map(l => BigInt(l.topics[3]).toString());
    log(`[MINTED] ${tokenIds.length} NFTs: ${tokenIds.map(id => '#' + id).join(', ')}`);

    return {
      status: receipt.status === 1 ? 'success' : 'reverted',
      hash: tx.hash, block: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(), tokenIds,
      explorer: getExplorer(target.chain) + tx.hash,
    };
  }
}

// ─── API Routes ───

app.get('/api/config', (req, res) => {
  const config = {};
  const envContent = fs.readFileSync(ENV_FILE, 'utf-8');
  for (const line of envContent.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) config[m[1].trim()] = m[2].trim();
  }
  // Mask private key
  if (config.PRIVATE_KEY) config.PRIVATE_KEY = config.PRIVATE_KEY.slice(0, 8) + '...' + config.PRIVATE_KEY.slice(-4);
  res.json(config);
});

app.post('/api/config', (req, res) => {
  const { config } = req.body;
  const lines = Object.entries(config).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
  res.json({ status: 'ok' });
});

app.get('/api/chains', (req, res) => {
  const result = Object.entries(CHAINS).map(([name, cfg]) => ({
    name, id: cfg.id, rpc: cfg.rpc, explorer: cfg.explorer || '',
    seadrop: cfg.seadrop || null, native: cfg.native || false,
  }));
  res.json(result);
});

// ─── Custom Chain Management ───

app.post('/api/chains', (req, res) => {
  const { name, id, rpc, explorer, seadrop } = req.body;
  if (!name || !id || !rpc) return res.status(400).json({ error: 'name, id, rpc required' });

  const key = name.toLowerCase().replace(/\s+/g, '-');
  CHAINS[key] = {
    id: parseInt(id),
    rpc: rpc.trim(),
    explorer: (explorer || '').trim(),
    seadrop: seadrop ? seadrop.trim() : undefined,
    native: false,
  };
  saveChains(CHAINS);
  res.json({ status: 'ok', chain: key, config: CHAINS[key] });
});

app.put('/api/chains/:name', (req, res) => {
  const key = req.params.name;
  if (!CHAINS[key]) return res.status(404).json({ error: 'chain not found' });

  const { id, rpc, explorer, seadrop } = req.body;
  if (id) CHAINS[key].id = parseInt(id);
  if (rpc) CHAINS[key].rpc = rpc.trim();
  if (explorer !== undefined) CHAINS[key].explorer = explorer.trim();
  if (seadrop !== undefined) CHAINS[key].seadrop = seadrop ? seadrop.trim() : undefined;
  saveChains(CHAINS);
  res.json({ status: 'ok', chain: key, config: CHAINS[key] });
});

app.delete('/api/chains/:name', (req, res) => {
  const key = req.params.name;
  if (!CHAINS[key]) return res.status(404).json({ error: 'chain not found' });
  if (CHAINS[key].native) return res.status(400).json({ error: 'cannot delete native chain' });

  delete CHAINS[key];
  saveChains(CHAINS);
  res.json({ status: 'ok', deleted: key });
});

// Test RPC connectivity
app.post('/api/chains/test', async (req, res) => {
  const { rpc } = req.body;
  if (!rpc) return res.status(400).json({ error: 'rpc url required' });

  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const network = await provider.getNetwork();
    const block = await provider.getBlockNumber();
    const balance = await provider.getBalance(ethers.ZeroAddress);

    res.json({
      status: 'ok',
      chainId: Number(network.chainId),
      blockNumber: block,
      ens: network.ensAddress || null,
    });
  } catch (e) {
    res.status(400).json({ status: 'error', error: e.message });
  }
});

app.get('/api/wallets', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    const wallets = data.map((w, i) => ({
      index: i + 1, address: w.address || w.publicKey,
      hasKey: !!(w.privateKey || w.private_key || w.pk),
    }));
    res.json(wallets);
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/api/wallet/:addr', async (req, res) => {
  const addr = req.params.addr;
  const balances = {};

  for (const [chain, cfg] of Object.entries(CHAINS)) {
    try {
      const provider = new ethers.JsonRpcProvider(cfg.rpc);
      const bal = await provider.getBalance(addr);
      balances[chain] = { balance: ethers.formatEther(bal), wei: bal.toString() };
    } catch (e) {
      balances[chain] = { error: e.message };
    }
  }
  res.json({ address: addr, balances });
});

// ─── Delete EVM Wallet ───

app.delete('/api/wallets/:identifier', (req, res) => {
  const identifier = req.params.identifier;

  try {
    const existing = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    let filtered;

    // Try to delete by address first
    if (identifier.startsWith('0x') && identifier.length === 42) {
      filtered = existing.filter(w => (w.address || w.publicKey) !== identifier);
      if (filtered.length === existing.length) {
        return res.status(404).json({ error: `wallet ${identifier.slice(0, 10)}... not found` });
      }
    } else {
      // Try to delete by index
      const idx = parseInt(identifier);
      if (isNaN(idx)) return res.status(400).json({ error: 'invalid identifier — use index or 0x address' });
      filtered = existing.filter((w, i) => (i + 1) !== idx);
      if (filtered.length === existing.length) {
        return res.status(404).json({ error: `wallet #${idx} not found` });
      }
    }

    fs.writeFileSync(WALLETS_FILE, JSON.stringify(filtered, null, 2));
    res.json({ status: 'ok', deleted: identifier, total: filtered.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Generate EVM Wallets ───

app.post('/api/wallets/generate', (req, res) => {
  const { count } = req.body;
  const n = Math.min(Math.max(parseInt(count) || 1, 1), 100);

  try {
    // Load existing wallets
    const existing = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    const startIndex = existing.length > 0 ? Math.max(...existing.map(w => w.index || 0)) + 1 : 1;

    const newWallets = [];
    for (let i = 0; i < n; i++) {
      const wallet = ethers.Wallet.createRandom();
      newWallets.push({
        index: startIndex + i,
        address: wallet.address,
        privateKey: wallet.privateKey,
        mnemonic: wallet.mnemonic.phrase,
      });
    }

    // Append to existing
    const all = [...existing, ...newWallets];
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(all, null, 2));

    // Return new wallets (address + index only — no PK in response)
    res.json({
      status: 'ok',
      generated: n,
      total: all.length,
      newWallets: newWallets.map(w => ({ index: w.index, address: w.address })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/resolve', async (req, res) => {
  try {
    const { input } = req.body;
    let target = parseTarget(input);
    if (target.source === 'opensea_slug') {
      const resolved = await resolveOpenSeaSlug(target.slug, (m) => {});
      target.contract = resolved.contract;
      target.chain = resolved.chain;
      target.name = resolved.name;
      target.totalSupply = resolved.totalSupply;
    }
    res.json(target);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/mint', async (req, res) => {
  const { input, chain, amount, walletIndex, dryRun } = req.body;

  try {
    // Parse target
    let target = parseTarget(input);
    if (target.source === 'opensea_slug') {
      const resolved = await resolveOpenSeaSlug(target.slug, () => {});
      target.contract = resolved.contract;
      target.chain = resolved.chain;
    }
    if (chain) target.chain = CHAIN_SLUG_MAP[chain] || chain;
    target.amount = amount || 1;

    // Load wallet
    const walletsData = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    const w = walletsData[walletIndex || 0];
    const pk = w.privateKey || w.private_key || w.pk;
    const wallet = new ethers.Wallet(pk);

    // Create job
    const job = createJob('mint', { target, wallet: wallet.address, amount: target.amount, dryRun });
    res.json({ jobId: job.id, status: 'pending' });

    // Execute
    updateJob(job.id, { status: 'running' });
    try {
      const result = await executeMint(target, wallet, target.amount, job.id, { dryRun });
      updateJob(job.id, { status: 'completed', result });
      logJob(job.id, '[DONE] Job completed successfully');
    } catch (e) {
      logJob(job.id, `[FAIL] ${e.message}`);
      updateJob(job.id, { status: 'failed', error: e.message });
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/mass-mint', async (req, res) => {
  const { input, chain, amount, walletIndices, maxConcurrent } = req.body;

  try {
    let target = parseTarget(input);
    if (target.source === 'opensea_slug') {
      const resolved = await resolveOpenSeaSlug(target.slug, () => {});
      target.contract = resolved.contract;
      target.chain = resolved.chain;
    }
    if (chain) target.chain = CHAIN_SLUG_MAP[chain] || chain;
    target.amount = amount || 1;

    const walletsData = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    const indices = walletIndices || walletsData.map((_, i) => i);
    const wallets = indices.map(i => {
      const w = walletsData[i];
      const pk = w.privateKey || w.private_key || w.pk;
      return { wallet: new ethers.Wallet(pk), index: i, address: w.address };
    });

    const job = createJob('mass-mint', { target, walletCount: wallets.length, amount: target.amount });
    res.json({ jobId: job.id, status: 'pending' });

    updateJob(job.id, { status: 'running' });
    logJob(job.id, `[MASS] ${wallets.length} wallets × ${target.amount} NFTs on ${target.chain}`);

    const limit = Math.min(maxConcurrent || 5, 10);
    let completed = 0, success = 0, failed = 0, skipped = 0;
    const results = [];

    // Process in batches
    for (let i = 0; i < wallets.length; i += limit) {
      const batch = wallets.slice(i, i + limit);
      const batchResults = await Promise.allSettled(
        batch.map(async (w) => {
          logJob(job.id, `[${i + batch.indexOf(w) + 1}] ${w.address} minting...`);
          try {
            const result = await executeMint(target, w.wallet, target.amount, job.id, { dryRun: false });
            completed++;
            if (result.status === 'success') {
              success++;
              logJob(job.id, `✅ ${w.address} → tokens: ${result.tokenIds?.join(', ')}`);
            }
            return { wallet: w.address, ...result };
          } catch (e) {
            failed++;
            logJob(job.id, `❌ ${w.address} → ${e.message}`);
            return { wallet: w.address, status: 'error', error: e.message };
          }
        })
      );
      results.push(...batchResults.map(r => r.value || r.reason?.message));
    }

    logJob(job.id, `[DONE] ✅${success} ❌${failed} ⏭${skipped} / ${wallets.length} total`);
    updateJob(job.id, { status: 'completed', result: { success, failed, skipped, total: wallets.length, results } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/jobs', (req, res) => {
  res.json(Array.from(jobs.values()).slice(-20).reverse());
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

// ─── Auth Routes ───

app.get('/api/auth/status', (req, res) => {
  res.json({ enabled: isAuthEnabled() });
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const auth = loadAuth();
  if (!auth || !auth.enabled) {
    return res.json({ status: 'ok', message: 'auth not enabled' });
  }

  if (!password) return res.status(400).json({ error: 'password required' });

  if (verifyPassword(password, auth.hash, auth.salt)) {
    const token = createSession();
    res.cookie('session', token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24, // 24h
      sameSite: 'lax',
    });
    return res.json({ status: 'ok', token });
  }

  res.status(401).json({ error: 'invalid password' });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) destroySession(token);
  res.clearCookie('session');
  res.json({ status: 'ok' });
});

app.post('/api/auth/setup', (req, res) => {
  // Only works if auth not yet enabled (first-time setup)
  if (isAuthEnabled()) return res.status(400).json({ error: 'auth already enabled. Use /api/auth/change-password' });

  const { password } = req.body;
  if (!password || password.length < 1) return res.status(400).json({ error: 'password must be at least 1 character' });

  setPassword(password);
  const token = createSession();
  res.cookie('session', token, { httpOnly: true, maxAge: 1000 * 60 * 60 * 24, sameSite: 'lax' });
  res.json({ status: 'ok', message: 'password set' });
});

app.post('/api/auth/change-password', (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'oldPassword and newPassword required' });
  if (newPassword.length < 1) return res.status(400).json({ error: 'new password must be at least 1 character' });

  try {
    changePassword(oldPassword, newPassword);
    res.json({ status: 'ok', message: 'password changed' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Start ───

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎨 NFT Minter Panel: http://localhost:${PORT}`);
  console.log(`📊 API: http://localhost:${PORT}/api/chains`);
});

export { app, io, server };
