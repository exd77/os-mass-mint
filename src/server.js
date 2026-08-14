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
import { listProxies, addProxy, addProxiesBulk, removeProxy, clearProxies, testAllProxies, testProxy, proxyForWallet, proxiedProvider, resetAssignments, listAssignments, proxyCount, isRotationEnabled } from './proxy.js';
import { notify, notifyMint, testWebhooks, webhookStatus } from './webhook.js';
import { collectionStats, collectionMeta, tokenRarity, batchRarity, rarityCacheStats } from './rarity.js';
import { sweepNfts } from './sweep.js';
import { chainRpcPool, rankEndpoints, sendRawToAll, waitForReceiptAny } from './broadcast.js';
import { prepareMintPlan, fireMintPlan } from './presign.js';
import { sendViaProtect, simulateBundle, submitBundle, waitForReceiptProtect } from './flashbots.js';
import { siweLogin, fetchVoucher, getStoredJwt, jwtStatus } from './opensea-auth.js';
import { recordMint, recordSale, recordTransfer, scanWalletActivity, computePositions } from './pnl.js';
import { priceCeilingCheck, scheduleHotWindow, hotWindowStatus, checkEligibility } from './guard.js';
import { generateSolWallets, importSolWallet, solBalances, solTransfer, solWalletList, deleteSolWallet, solNftInfo } from './solana.js';
import { solveCaptcha, captchaStatus } from './captcha.js';
import { announce, socialStatus, mintAnnounce } from './social.js';
import { checkDropPage, watchDropPage } from './dropcheck.js';

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
  const publicPaths = ['/login.html', '/style.css', '/style-v2.css', '/login.js', '/api/auth/login', '/api/auth/status', '/api/auth/setup'];
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
    fromBlock: Math.max(1, currentBlock - 100000), toBlock: currentBlock,
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
    fromBlock: Math.max(1, currentBlock - 100000), toBlock: currentBlock,
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

async function executeMint(target, wallet, amount, jobId, { dryRun = false, useProxy = true } = {}) {
  const log = (msg) => logJob(jobId, msg);
  const rpcUrl = getRpcUrl(target.chain);
  if (!rpcUrl) throw new Error(`no RPC for chain "${target.chain}". Add it in Chains config tab.`);

  // Proxy rotation: sticky per-wallet assignment when pool is enabled
  let provider;
  const proxy = (useProxy && isRotationEnabled()) ? proxyForWallet(wallet.address) : null;
  if (proxy) {
    log(`[PROXY] ${wallet.address.slice(0, 10)}… → ${proxy.label || proxy.id} (${(proxy.url.match(/@([^/]+)/) || [, proxy.url])[1]})`);
    provider = proxiedProvider(rpcUrl, proxy.url);
  } else {
    provider = new ethers.JsonRpcProvider(rpcUrl);
  }

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

    // Auto rarity fetch for minted tokens (best effort, non-blocking failure)
    let rarity = null;
    try {
      const rarityFn = (await import('./rarity.js')).batchRarity;
      rarity = await rarityFn(target.chain, target.contract, tokenIds.slice(0, 10), { delayMs: 300 });
      if (rarity.ranked > 0) {
        log(`[RARITY] best rank #${rarity.best.rarityRank} (score ${rarity.best.rarityScore ?? '?'}) of ${rarity.ranked} tokens`);
      } else {
        log('[RARITY] no ranking data available for this collection/chain');
      }
    } catch (e) {
      log(`[RARITY] skip — ${String(e.message).slice(0, 100)}`);
    }

    // Webhook notification
    notifyMint({
      type: jobId.startsWith('job') ? 'mint' : 'mint',
      status: receipt.status === 1 ? 'success' : 'reverted',
      wallet: wallet.address,
      chain: target.chain,
      contract: target.contract,
      tokenIds: tokenIds.join(', #'),
      txHash: tx.hash,
      explorer: getExplorer(target.chain) + tx.hash,
      gasUsed: receipt.gasUsed.toString(),
      rarityBest: rarity?.best ? `#${rarity.best.rarityRank}` : null,
    }).catch(() => {});

    return {
      status: receipt.status === 1 ? 'success' : 'reverted',
      hash: tx.hash, block: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(), tokenIds,
      rarity: rarity ? { best: rarity.best, ranked: rarity.ranked } : null,
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

// ─── OpenSea stats proxy (price, supply) ───
app.get('/api/opensea/stats/:slug', async (req, res) => {
  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OPENSEA_API_KEY not set' });
  try {
    const base = process.env.OPENSEA_API_BASE || 'https://api.opensea.io/api/v2';
    const r = await fetch(`${base}/collections/${req.params.slug}/stats`, { headers: { 'X-API-KEY': apiKey } });
    if (!r.ok) return res.status(r.status).json({ error: `opensea ${r.status}` });
    const d = await r.json();
    res.json({
      floor: d?.total?.floor_price ?? null,
      symbol: d?.total?.floor_price_symbol || 'ETH',
      totalSupply: d?.total?.count ?? null,
      numMinted: d?.total?.num_owners ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  const { input, chain, amount, walletIndices, maxConcurrent, dryRun = false } = req.body;

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

    const job = createJob('mass-mint', { target, walletCount: wallets.length, amount: target.amount, dryRun: Boolean(dryRun) });
    res.json({ jobId: job.id, status: 'pending' });

    updateJob(job.id, { status: 'running' });
    logJob(job.id, `[MASS${dryRun ? ':DRY-RUN' : ''}] ${wallets.length} wallets × ${target.amount} NFTs on ${target.chain}`);

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
            const result = await executeMint(target, w.wallet, target.amount, job.id, { dryRun: Boolean(dryRun) });
            completed++;
            if (result.status === 'success' || result.status === 'dry-run') {
              success++;
              logJob(job.id, dryRun
                ? `[SIM] ${w.address} → dry run passed`
                : `✅ ${w.address} → tokens: ${result.tokenIds?.join(', ')}`);
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
    notifyMint({
      type: 'mass-mint',
      status: success === wallets.length ? 'success' : (success > 0 ? 'partial' : 'error'),
      wallets: `${success}/${wallets.length} ok, ${failed} failed`,
      chain: target.chain,
      contract: target.contract,
      amountPerWallet: target.amount,
      dryRun: Boolean(dryRun),
    }).catch(() => {});
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

// ─── Proxy Management ───

app.get('/api/proxies', (req, res) => {
  res.json({ proxies: listProxies(), rotationEnabled: isRotationEnabled(), assignments: listAssignments() });
});

app.post('/api/proxies', (req, res) => {
  const { text, url, label } = req.body;
  try {
    if (text) {
      const result = addProxiesBulk(text);
      res.json({ status: 'ok', ...result, total: proxyCount() });
    } else if (url) {
      const p = addProxy(url, label || '');
      res.json({ status: 'ok', proxy: { ...p, url: '***' }, total: proxyCount() });
    } else {
      res.status(400).json({ error: 'text (bulk) or url required' });
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/proxies/:id', (req, res) => {
  try { res.json(removeProxy(req.params.id)); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

app.post('/api/proxies/clear', (req, res) => {
  clearProxies();
  res.json({ status: 'ok', cleared: true });
});

app.post('/api/proxies/:id/test', async (req, res) => {
  try { res.json(await testProxy(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/proxies-test-all', async (req, res) => {
  try { res.json(await testAllProxies()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/proxies/reset-assignments', (req, res) => {
  res.json(resetAssignments());
});

// ─── Webhook Management ───

app.get('/api/webhooks/status', (req, res) => {
  res.json(webhookStatus());
});

app.post('/api/webhooks/test', async (req, res) => {
  try { res.json(await testWebhooks()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Rarity ───

app.get('/api/rarity/stats/:slug', async (req, res) => {
  if (!/^[\w-]+$/.test(req.params.slug)) return res.status(400).json({ error: 'invalid slug' });
  try { res.json(await collectionStats(req.params.slug)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/rarity/collection/:slug', async (req, res) => {
  if (!/^[\w-]+$/.test(req.params.slug)) return res.status(400).json({ error: 'invalid slug' });
  try { res.json(await collectionMeta(req.params.slug)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/rarity/token/:chain/:contract/:tokenId', async (req, res) => {
  const { chain, contract, tokenId } = req.params;
  if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) return res.status(400).json({ error: 'invalid contract' });
  if (!/^\d+$/.test(tokenId)) return res.status(400).json({ error: 'invalid tokenId' });
  try { res.json(await tokenRarity(chain, contract, tokenId)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/rarity/batch', async (req, res) => {
  const { chain, contract, tokenIds } = req.body;
  if (!/^0x[a-fA-F0-9]{40}$/.test(contract || '')) return res.status(400).json({ error: 'invalid contract' });
  if (!Array.isArray(tokenIds) || tokenIds.length === 0) return res.status(400).json({ error: 'tokenIds array required' });
  try { res.json(await batchRarity(chain, contract, tokenIds.map(String).slice(0, 50))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/rarity/cache', (req, res) => {
  res.json(rarityCacheStats());
});

// ─── NFT Sweep ───

app.post('/api/sweep', async (req, res) => {
  const { chain, contract, toAddress, walletIndices, dryRun = false } = req.body;
  if (!/^0x[a-fA-F0-9]{40}$/.test(contract || '')) return res.status(400).json({ error: 'invalid contract address' });
  if (!ethers.isAddress(toAddress || '')) return res.status(400).json({ error: 'invalid destination address' });
  if (!getRpcUrl(chain)) return res.status(400).json({ error: `no RPC for chain "${chain}"` });

  try {
    const walletsData = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    const indices = walletIndices || walletsData.map((_, i) => i);
    const wallets = indices
      .map(i => walletsData[i] && { index: i, address: walletsData[i].address, wallet: new ethers.Wallet(walletsData[i].privateKey || walletsData[i].private_key || walletsData[i].pk) })
      .filter(Boolean);
    if (wallets.length === 0) return res.status(400).json({ error: 'no valid wallets selected' });

    const job = createJob('sweep', { chain, contract, toAddress, walletCount: wallets.length, dryRun: Boolean(dryRun) });
    res.json({ jobId: job.id, status: 'pending' });

    updateJob(job.id, { status: 'running' });
    logJob(job.id, `[SWEEP${dryRun ? ':DRY-RUN' : ''}] ${wallets.length} wallets → ${toAddress} on ${chain}`);

    const result = await sweepNfts({
      chain, contract, toAddress, wallets,
      rpcUrl: getRpcUrl(chain), chainId: getChainId(chain), explorer: getExplorer(chain),
      jobId: job.id, log: (m) => logJob(job.id, m), dryRun: Boolean(dryRun),
    });

    logJob(job.id, `[DONE] ${result.transferred} tokens moved, ${result.errors.length} errors`);
    updateJob(job.id, { status: 'completed', result });
    notifyMint({
      type: 'sweep',
      status: 'success',
      chain, contract, destination: toAddress,
      tokensMoved: result.transferred,
      walletsOk: `${result.success}/${result.total}`,
      dryRun: Boolean(dryRun),
    }).catch(() => {});
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Flash Mint (pre-sign + multi-RPC fan-out) ───

// Phase 1: PREP — resolve + build + sign all TXs (no broadcast)
app.post('/api/flash-mint/prep', async (req, res) => {
  const { input, chain, amount = 1, walletIndices, gasLimit = 300000 } = req.body;
  try {
    let target = parseTarget(input || '');
    if (target.source === 'opensea_slug') {
      const resolved = await resolveOpenSeaSlug(target.slug, () => {});
      target.contract = resolved.contract;
      target.chain = resolved.chain;
    }
    const chainName = chain || target.chain;
    if (!getRpcUrl(chainName)) return res.status(400).json({ error: `no RPC for chain "${chainName}"` });

    const walletsData = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    const indices = walletIndices || walletsData.map((_, i) => i);
    const wallets = indices
      .map(i => walletsData[i] && { index: i, address: walletsData[i].address, wallet: new ethers.Wallet(walletsData[i].privateKey || walletsData[i].private_key || walletsData[i].pk) })
      .filter(Boolean);
    if (!wallets.length) return res.status(400).json({ error: 'no valid wallets selected' });

    const job = createJob('flash-prep', { chain: chainName, contract: target.contract, walletCount: wallets.length, amount });
    res.json({ jobId: job.id, status: 'pending' });
    updateJob(job.id, { status: 'running' });

    const plan = await prepareMintPlan({
      chain: chainName, contract: target.contract, amount, wallets,
      rpcUrl: getRpcUrl(chainName), chainId: getChainId(chainName), gasLimit,
      skipBalanceCheck: Boolean(req.body.skipBalanceCheck),
      log: (m) => logJob(job.id, m),
    });

    // Hold plan in memory for the fire phase (keyed by job id)
    flashPlans.set(job.id, plan);
    updateJob(job.id, { status: 'completed', result: plan.summary() });
    logJob(job.id, `[READY] fire with jobId — TXs stay valid ~5 min (gas estimate drifts)`);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Phase 2: FIRE — broadcast all pre-signed TXs to ranked endpoints
// body.via: 'fanout' (default) | 'flashbots' (private, no frontrun) | 'both'
// body.maxPerNftEth: price ceiling — abort if live price exceeds this
app.post('/api/flash-mint/fire', async (req, res) => {
  const { jobId, via = 'fanout', maxPerNftEth } = req.body;
  const plan = flashPlans.get(jobId);
  if (!plan) return res.status(404).json({ error: 'plan not found — run prep first (plans are held in memory)' });
  if (!plan.ready.length) return res.status(400).json({ error: 'plan has no signed TXs' });

  // price ceiling guard — re-read live price before broadcasting
  if (maxPerNftEth) {
    const guard = await priceCeilingCheck({
      contract: plan.contract, chain: plan.chain,
      rpcUrl: plan.fastUrls[0], capPerNftEth: maxPerNftEth,
      log: (m) => console.log(m),
    });
    if (guard.ok === false) {
      return res.status(400).json({
        error: `PRICE CEILING ABORT — live ${Number(guard.livePriceWei) / 1e18} ETH > cap ${maxPerNftEth} ETH/NFT`,
        guard,
      });
    }
  }

  const job = createJob('flash-fire', { planJobId: jobId, walletCount: plan.ready.length, via });
  res.json({ jobId: job.id, status: 'pending' });
  updateJob(job.id, { status: 'running' });

  let result;
  if (via === 'flashbots' || via === 'both') {
    // private submission via Flashbots Protect (works on mainnet; private mempool)
    logJob(job.id, `[FIRE:FLASHBOTS] submitting ${plan.ready.length} TXs via private relay`);
    const fbResults = await Promise.allSettled(plan.ready.map(async (b) => {
      try {
        const sent = await sendViaProtect(b.signedTx);
        logJob(job.id, `[FB] ${b.address.slice(0, 10)}… → protect ${sent.hash.slice(0, 14)}…`);
        const rcpt = await waitForReceiptProtect(sent.hash, { timeoutMs: 120000 }).catch(() => null);
        const ok = rcpt?.status === 1;
        return { ...b, status: rcpt ? (ok ? 'success' : 'reverted') : 'pending', block: rcpt?.blockNumber };
      } catch (e) {
        // fall back to fanout for this TX if via === 'both'
        if (via === 'both') {
          try {
            const sent = await sendRawToAll(b.signedTx, plan.fastUrls);
            const rcpt = await waitForReceiptAny(b.hash, plan.fastUrls);
            return { ...b, status: rcpt?.status === 1 ? 'success' : 'reverted', sentVia: sent.url, block: rcpt?.blockNumber };
          } catch (e2) {
            return { ...b, status: 'error', error: `fb:${String(e.message).slice(0,80)} fanout:${String(e2.message).slice(0,80)}` };
          }
        }
        return { ...b, status: 'error', error: String(e.message).slice(0, 200) };
      }
    }));
    result = { results: fbResults.filter(r => r.status === 'fulfilled').map(r => r.value), ok: 0, total: plan.ready.length, fireMs: 0 };
    result.ok = result.results.filter(r => r.status === 'success').length;
    logJob(job.id, `[DONE:FLASHBOTS] ${result.ok}/${result.total} confirmed`);
  } else {
    result = await fireMintPlan(plan, { log: (m) => logJob(job.id, m) });
  }

  updateJob(job.id, { status: 'completed', result: { ok: result.ok, total: result.total, via } });
  flashPlans.delete(jobId); // one-shot

  // PnL: record each successful mint
  for (const r of (result.results || [])) {
    if (r.status === 'success') {
      recordMint({
        chain: plan.chain, contract: plan.contract,
        tokenId: r.tokenId || 'pending', wallet: r.address,
        priceWei: plan.pricePerNFT, gasWei: r.gasUsed ? String(BigInt(r.gasUsed) * 1n) : '0',
        txHash: r.hash,
      });
    }
  }

  notifyMint({
    type: 'flash-mint',
    status: result.ok === result.total ? 'success' : (result.ok > 0 ? 'partial' : 'error'),
    chain: plan.chain, contract: plan.contract,
    wallets: `${result.ok}/${result.total} confirmed via ${via}`,
    fireMs: result.fireMs,
  }).catch(() => {});
});

const flashPlans = new Map();

// Phase 2b: HOT WINDOW — schedule auto-fire at (startUnix - leadSec)
// body: { jobId, startUnix, leadSec, via, maxPerNftEth }
app.post('/api/flash-mint/schedule', (req, res) => {
  const { jobId, startUnix, leadSec = 0, via = 'fanout', maxPerNftEth } = req.body;
  const plan = flashPlans.get(jobId);
  if (!plan) return res.status(404).json({ error: 'plan not found — run prep first' });
  if (!startUnix) return res.status(400).json({ error: 'startUnix (drop start, seconds) required' });

  const wakeId = `wake_${jobId}`;
  scheduleHotWindow({
    id: wakeId, startUnix: Number(startUnix), leadSec: Number(leadSec) || 0,
    log: (m) => { console.log(m); io.emit('log', { type: 'wake', message: m, ts: Date.now() }); },
    fire: async () => {
      // re-run guard at fire time
      if (maxPerNftEth) {
        const guard = await priceCeilingCheck({
          contract: plan.contract, chain: plan.chain,
          rpcUrl: plan.fastUrls[0], capPerNftEth: maxPerNftEth, log: (m) => console.log(m),
        });
        if (guard.ok === false) {
          console.log(`[WAKE] ${wakeId} ABORTED by price ceiling`);
          io.emit('log', { type: 'wake', message: `price ceiling abort — plan kept for manual fire`, ts: Date.now() });
          return; // keep plan for manual decision
        }
      }
      if (!flashPlans.has(jobId)) { console.log(`[WAKE] plan already fired/consumed`); return; }
      // reuse fire endpoint internals via internal call
      try {
        const r = await fetch(`http://localhost:${PORT}/api/flash-mint/fire`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, via, maxPerNftEth }),
        });
        const j = await r.json().catch(() => ({}));
        console.log(`[WAKE] fire dispatched: ${r.status}`, JSON.stringify(j).slice(0, 200));
      } catch (e) {
        console.log(`[WAKE] fire dispatch error: ${e.message}`);
      }
    },
  });

  const fireAt = new Date((Number(startUnix) - (Number(leadSec) || 0)) * 1000).toISOString();
  res.json({ wakeId, jobId, fireAt, leadSec: Number(leadSec) || 0 });
});

app.get('/api/flash-mint/schedule', (req, res) => res.json({ wakes: hotWindowStatus() }));

app.delete('/api/flash-mint/schedule/:wakeId', (req, res) => {
  // handled via id lookup in guard.js timers — expose cancel
  const w = hotWindowStatus().find(w => w.id === req.params.wakeId);
  if (!w) return res.status(404).json({ error: 'wake not found' });
  cancelHotWindow(req.params.wakeId);
  res.json({ ok: true });
});

// ─── WL eligibility checker ───

app.post('/api/wl/check', async (req, res) => {
  const { slug, walletAddresses, walletIndices, chain, rpcUrl } = req.body;
  let addresses = walletAddresses;
  if (!addresses && walletIndices) {
    const walletsData = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    addresses = walletIndices.map(i => walletsData[i]?.address).filter(Boolean);
  }
  if (!addresses || !addresses.length) return res.status(400).json({ error: 'walletAddresses or walletIndices required' });
  if (!slug) return res.status(400).json({ error: 'collection slug required' });
  try {
    const r = await checkEligibility({
      slug, walletAddresses: addresses, apiKey: process.env.OPENSEA_API_KEY,
      chain, rpcUrl: rpcUrl || getRpcUrl(chain), log: (m) => console.log(m),
    });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// RPC pool diagnostics — rank all endpoints for a chain
app.post('/api/rpc/rank', async (req, res) => {
  const { chain } = req.body;
  const rpcUrl = getRpcUrl(chain);
  if (!rpcUrl) return res.status(400).json({ error: `no RPC for chain "${chain}"` });
  try {
    const pool = chainRpcPool(chain, rpcUrl);
    const ranked = await rankEndpoints(pool);
    res.json({ chain, poolSize: pool.length, ranked });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── OpenSea SIWE Auth + Voucher ───

// List stored JWTs
app.get('/api/opensea/jwt', (req, res) => res.json({ jwts: jwtStatus() }));

// SIWE login for one wallet (requires OPENSEA_API_KEY)
app.post('/api/opensea/siwe', async (req, res) => {
  const { walletIndex = 0, chain = 'ethereum' } = req.body;
  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OPENSEA_API_KEY not set in .env' });
  try {
    const walletsData = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    const w = walletsData[walletIndex];
    if (!w) return res.status(400).json({ error: `wallet index ${walletIndex} not found` });
    const wallet = new ethers.Wallet(w.privateKey || w.private_key || w.pk);
    const jwt = await siweLogin(wallet, apiKey, chain, (m) => {});
    res.json({ ok: true, address: wallet.address, jwtPrefix: jwt.slice(0, 20) + '…' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Fetch voucher for a drop (requires prior SIWE or auto-login)
app.post('/api/opensea/voucher', async (req, res) => {
  const { dropId, walletIndex = 0, chain = 'ethereum' } = req.body;
  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OPENSEA_API_KEY not set in .env' });
  if (!dropId) return res.status(400).json({ error: 'dropId required' });
  try {
    const walletsData = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    const w = walletsData[walletIndex];
    const wallet = new ethers.Wallet(w.privateKey || w.private_key || w.pk);
    const voucher = await fetchVoucher(wallet, apiKey, { dropId, chain }, () => {});
    res.json({ ok: true, voucher });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── PnL ───

// Scan wallet activity on-chain and ingest into pnl.json
app.post('/api/pnl/scan', async (req, res) => {
  const { chain } = req.body;
  const rpcUrl = getRpcUrl(chain);
  if (!rpcUrl) return res.status(400).json({ error: `no RPC for chain "${chain}"` });
  try {
    const walletsData = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    const job = createJob('pnl-scan', { chain, wallets: walletsData.length });
    res.json({ jobId: job.id });
    updateJob(job.id, { status: 'running' });
    const r = await scanWalletActivity({
      wallets: walletsData.map(w => w.address), chain, rpcUrl,
      log: (m) => logJob(job.id, m),
    });
    updateJob(job.id, { status: 'completed', result: r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Positions + summary (optional floor prices via ?floor=contract:wei,...)
app.get('/api/pnl', async (req, res) => {
  try {
    let floors = {};
    if (req.query.floors) {
      for (const pair of String(req.query.floors).split(',')) {
        const [c, w] = pair.split(':');
        if (c && w) floors[c.toLowerCase()] = w;
      }
    }
    // auto floor via opensea if key present and no explicit floors
    if (!Object.keys(floors).length && process.env.OPENSEA_API_KEY) {
      const d = computePositions();
      const contracts = [...new Set(d.positions.filter(p => p.status === 'held').map(p => p.contract))];
      await Promise.allSettled(contracts.slice(0, 3).map(async (c) => {
        try {
          const stats = await collectionStats(c);
          if (stats?.floor_price) {
            const decimals = stats.floor_price_payment_token?.decimals || 18;
            floors[c.toLowerCase()] = String(BigInt(Math.round(stats.floor_price * 10 ** decimals)));
          }
        } catch {}
      }));
    }
    res.json(computePositions(floors));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Manual sale entry
app.post('/api/pnl/sale', (req, res) => {
  const { chain, contract, tokenId, wallet, saleWei, feeWei, txHash } = req.body;
  if (!contract || tokenId == null || !wallet || !saleWei) return res.status(400).json({ error: 'contract, tokenId, wallet, saleWei required' });
  recordSale({ chain: chain || 'ethereum', contract, tokenId, wallet, saleWei, feeWei: feeWei || 0, txHash });
  res.json({ ok: true });
});

// ─── Flashbots diagnostics ───

app.post('/api/flashbots/simulate', async (req, res) => {
  const { signedTxs } = req.body;
  if (!Array.isArray(signedTxs) || !signedTxs.length) return res.status(400).json({ error: 'signedTxs array required' });
  try {
    const result = await simulateBundle(signedTxs, process.env.FLASHBOTS_AUTH_KEY);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Solana ───

app.get('/api/solana/wallets', (req, res) => res.json({ wallets: solWalletList() }));

app.post('/api/solana/generate', (req, res) => {
  const count = Math.min(50, parseInt(req.body.count) || 1);
  res.json({ created: generateSolWallets(count) });
});

app.post('/api/solana/import', (req, res) => {
  try { res.json(importSolWallet(req.body.secretKey)); } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/solana/balances', async (req, res) => {
  try { res.json({ wallets: await solBalances() }); } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/solana/transfer', async (req, res) => {
  const { fromIndex, toAddress, sol } = req.body;
  if (fromIndex == null || !toAddress || !sol) return res.status(400).json({ error: 'fromIndex, toAddress, sol required' });
  try {
    const r = await solTransfer({ fromIndex, toAddress, sol });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/solana/wallets/:index', (req, res) => {
  try { res.json({ deleted: deleteSolWallet(parseInt(req.params.index)) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/solana/nft/:mint', async (req, res) => {
  try { res.json(await solNftInfo(req.params.mint)); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── CAPTCHA ───

app.get('/api/captcha/status', (req, res) => res.json(captchaStatus()));

app.post('/api/captcha/solve', async (req, res) => {
  const { type = 'recaptcha2', sitekey, pageurl, imageBase64, provider, timeoutMs } = req.body;
  if (type !== 'image' && (!sitekey || !pageurl)) return res.status(400).json({ error: 'sitekey and pageurl required' });
  if (type === 'image' && !imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
  try {
    const r = await solveCaptcha({ type, sitekey, pageurl, imageBase64, provider }, { timeoutMs });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Social ───

app.get('/api/social/status', (req, res) => res.json(socialStatus()));

app.post('/api/social/announce', async (req, res) => {
  const { text, targets } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const r = await announce({ text, targets }, () => {});
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Drop page checker ───

app.post('/api/dropcheck', async (req, res) => {
  const { url } = req.body;
  if (!/^https?:\/\//i.test(url || '')) return res.status(400).json({ error: 'valid url required' });
  res.json(await checkDropPage(url));
});

// in-memory watchers
const dropWatchers = new Map();

app.post('/api/dropcheck/watch', (req, res) => {
  const { url, intervalMs } = req.body;
  if (!/^https?:\/\//i.test(url || '')) return res.status(400).json({ error: 'valid url required' });
  const id = 'watch_' + Date.now().toString(36);
  const events = [];
  const handle = watchDropPage(url, {
    intervalMs: Math.max(10000, intervalMs || 30000),
    onUpdate: (s) => {
      events.push({ ts: Date.now(), status: s.status, soldOut: s.soldOut, live: s.live, phase: s.phase, price: s.price });
      io.emit('dropwatch', { id, update: events[events.length - 1] });
      if (handle.flipped) {
        notify(`drop watch flipped for ${url}: ${s.soldOut ? 'SOLD OUT' : 'LIVE'}`).catch(() => {});
      }
    },
  });
  dropWatchers.set(id, { url, events, handle });
  res.json({ watchId: id, url, intervalMs: Math.max(10000, intervalMs || 30000) });
});

app.get('/api/dropcheck/watch/:id', (req, res) => {
  const w = dropWatchers.get(req.params.id);
  if (!w) return res.status(404).json({ error: 'watch not found' });
  res.json({ url: w.url, events: w.events.slice(-20), flipped: Boolean(w.handle.flipped) });
});

app.delete('/api/dropcheck/watch/:id', (req, res) => {
  const w = dropWatchers.get(req.params.id);
  if (!w) return res.status(404).json({ error: 'watch not found' });
  w.handle.cancelled = true;
  dropWatchers.delete(req.params.id);
  res.json({ ok: true });
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
  console.log(`NFT Minter Panel: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/chains`);
});

export { app, io, server };
