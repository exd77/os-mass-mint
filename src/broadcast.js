/**
 * Multi-RPC Broadcast — ranked endpoint pool + fan-out send + receipt race
 *
 * Same signed TX broadcast to N RPCs simultaneously
 * (idempotent — identical tx hash everywhere), first accept wins.
 * Receipt polled from fastest responding endpoint.
 */

import { ethers } from 'ethers';

// ─── Fallback public RPC pools (chain name → extra endpoints) ───

export const FALLBACK_RPCS = {
  ethereum: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
  ],
  base: [
    'https://base-rpc.publicnode.com',
    'https://base.llamarpc.com',
    'https://mainnet.base.org',
  ],
  polygon: [
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon-rpc.com',
    'https://polygon.llamarpc.com',
  ],
  arbitrum: [
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum.llamarpc.com',
  ],
  optimism: [
    'https://optimism-rpc.publicnode.com',
    'https://mainnet.optimism.io',
    'https://optimism.llamarpc.com',
  ],
  bsc: [
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed.binance.org',
    'https://bsc-dataseed1.defibit.io',
  ],
  'zora-network': [
    'https://rpc.zora.energy',
    'https://zora-rpc.publicnode.com',
  ],
  robinhood: [
    'https://rpc.mainnet.chain.robinhood.com/',
  ],
};

// ─── Pool construction ───

/**
 * Build RPC pool for a chain: primary (chains.json, supports comma-separated)
 * + built-in fallbacks. Deduped, primary first.
 */
export function chainRpcPool(chainName, primaryRpc, extra = []) {
  const urls = [];
  if (primaryRpc) {
    urls.push(...String(primaryRpc).split(/[,\s]+/).filter(u => /^https?:\/\//i.test(u)));
  }
  urls.push(...(FALLBACK_RPCS[chainName] || []));
  urls.push(...extra.filter(Boolean));
  return [...new Set(urls)];
}

// ─── Latency ranking ───

export async function rankEndpoints(urls, { timeoutMs = 4000, concurrency = 8 } = {}) {
  const results = [];
  const queue = [...urls];
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      try {
        const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
        const start = Date.now();
        const block = await Promise.race([
          provider.getBlockNumber(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
        ]);
        results.push({ url, latencyMs: Date.now() - start, block });
      } catch (e) {
        results.push({ url, latencyMs: null, error: e.message?.slice(0, 100) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results.sort((a, b) => {
    if (a.latencyMs == null) return 1;
    if (b.latencyMs == null) return -1;
    return a.latencyMs - b.latencyMs;
  });
}

// ─── Connection warmer ───
// Pre-establish TCP/TLS to every endpoint so the first real request at T-0
// doesn't pay the handshake (50-300ms per endpoint). Warm with
// eth_sendRawTransaction (send-only endpoints accept it) and ignore errors —
// the handshake is the point, not the response.
export async function warmConnections(urls, { timeoutMs = 5000 } = {}) {
  const warmBody = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x00'],
  });
  await Promise.allSettled(urls.map(url =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: warmBody })
      .then(() => {}).catch(() => {})
  ));
}

// ─── Pre-computed blast body ───
// Build the JSON-RPC body ONCE at prep time, so at fire time the only work
// left is fetch(url, { body }) — no stringify, no keccak in the hot path.
export function prepareBlast(signedTx) {
  return {
    txHash: ethers.keccak256(signedTx),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [signedTx] }),
  };
}

// ─── Fan-out raw send ───

const KNOWN_ACCEPT = ['already known', 'already imported', 'nonce too low', 'already in mempool', 'replacement transaction underpriced'];

async function rawSendPrepared(url, blastBody, txHash) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: blastBody,
  });
  const j = await r.json().catch(() => { throw new Error(`${url}: HTTP ${r.status}`); });
  if (j.result) return { url, hash: j.result, known: false };
  const err = String(j.error?.message || '').toLowerCase();
  if (KNOWN_ACCEPT.some(k => err.includes(k))) {
    return { url, hash: txHash, known: true };
  }
  throw new Error(`${new URL(url).host}: ${j.error?.message || 'rejected'}`);
}

/**
 * Fire-and-forget broadcast: initiate ALL fetch calls immediately (sub-ms
 * dispatch of every wallet to every endpoint), return txHashes instantly.
 * Responses collected via the returned promise — caller awaits it AFTER
 * the dispatch is logged. No per-endpoint or per-wallet await in the loop.
 */
export function blastAll(blasts, urls, { maxUrls = 6 } = {}) {
  // blasts: array of prepareBlast() results — { txHash, body }
  const targets = urls.slice(0, maxUrls);
  const dispatchedAt = Date.now();
  const pairs = [];
  for (const blast of blasts) {
    for (const url of targets) {
      pairs.push(fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: blast.body,
      }).then(async r => {
        const j = await r.json().catch(() => null);
        return { url, txHash: blast.txHash, json: j };
      }).catch(e => ({ url, txHash: blast.txHash, error: e.message })));
    }
  }
  const results = Promise.allSettled(pairs).then(settled => settled.map(s => s.value));
  return { txHashes: blasts.map(b => b.txHash), dispatchedAt, results };
}

/**
 * Broadcast identical signed TX to all endpoints simultaneously.
 * Returns on FIRST acceptance. Collects errors if all fail.
 */
export async function sendRawToAll(signedTx, urls, { maxUrls = 6 } = {}) {
  if (!urls.length) throw new Error('no rpc endpoints');
  const targets = urls.slice(0, maxUrls);
  const blast = prepareBlast(signedTx);
  const attempts = targets.map(u => rawSendPrepared(u, blast.body, blast.txHash));
  try {
    return await Promise.any(attempts);
  } catch (agg) {
    const errors = (agg?.errors || []).map(e => e.message).join(' | ');
    throw new Error(`broadcast failed on all ${targets.length} endpoints: ${errors.slice(0, 400)}`);
  }
}

// ─── Receipt race ───

/**
 * Poll receipt across endpoints — first confirmed wins.
 * Falls back to ethers wait if only 1 url.
 */
export async function waitForReceiptAny(txHash, urls, { timeoutMs = 180000, pollMs = 1500, maxUrls = 6 } = {}) {
  const targets = urls.slice(0, maxUrls);
  if (targets.length === 1) {
    const provider = new ethers.JsonRpcProvider(targets[0], undefined, { staticNetwork: true });
    return await provider.waitForTransaction(txHash, 1, timeoutMs);
  }

  const start = Date.now();
  const failures = new Map(); // url → consecutive failures
  while (Date.now() - start < timeoutMs) {
    const checks = targets.map(async (url) => {
      if ((failures.get(url) || 0) >= 3) return null; // skip dead endpoint
      try {
        const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
        const rcpt = await Promise.race([
          provider.getTransactionReceipt(txHash),
          new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3000)),
        ]);
        failures.set(url, 0);
        return rcpt || null;
      } catch {
        failures.set(url, (failures.get(url) || 0) + 1);
        return null;
      }
    });
    const receipts = (await Promise.all(checks)).filter(Boolean);
    if (receipts.length) return receipts[0];
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`receipt timeout after ${Math.round(timeoutMs / 1000)}s`);
}

// ─── Chain ID verification (port from reference: drop wrong-chain endpoints) ───

export async function verifyChainId(urls, expectedChainId, { timeoutMs = 4000 } = {}) {
  const ok = [];
  const dropped = [];
  await Promise.all(urls.map(async (url) => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = await r.json();
      const cid = parseInt(j.result, 16);
      if (cid === expectedChainId) ok.push(url);
      else dropped.push({ url, chainId: cid });
    } catch (e) {
      dropped.push({ url, chainId: null, error: e.message?.slice(0, 60) });
    }
  }));
  return { ok, dropped };
}

// ─── Max-per-wallet + balance-precise validation (on-chain) ───

export async function validateMintParams({ rpcUrl, seadropAddr, nftContract, quantity, walletAddress, valueWei, gasLimit, maxFeePerGas, log }) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  const seadrop = new ethers.Contract(seadropAddr, [
    'function getPublicDrop(address) view returns (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)',
  ], provider);

  const warnings = [];
  try {
    const drop = await seadrop.getPublicDrop(nftContract);
    const maxPerWallet = Number(drop.maxTotalMintableByWallet);
    if (maxPerWallet > 0 && quantity > maxPerWallet) {
      warnings.push(`qty ${quantity} > maxTotalMintableByWallet ${maxPerWallet} — will revert`);
    }
    if (Date.now() >= Number(drop.endTime) * 1000) {
      warnings.push('public stage already ended on-chain');
    }
  } catch { /* no public drop — allowlist-only or non-seadrop */ }

  // Nodes reserve gasLimit × maxFee + value upfront — check the full amount
  if (maxFeePerGas && gasLimit) {
    try {
      const bal = await provider.getBalance(walletAddress);
      const required = BigInt(gasLimit) * BigInt(maxFeePerGas) + BigInt(valueWei || 0n);
      if (bal < required) {
        warnings.push(`balance ${ethers.formatEther(bal)} < required ${ethers.formatEther(required)} (gasLimit×maxFee + value)`);
      }
    } catch { /* balance check optional */ }
  }
  return warnings;
}

export async function fastFeeData(urls, { priorityBoostPct = 15 } = {}) {
  for (const url of urls.slice(0, 4)) {
    try {
      const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
      const fee = await Promise.race([
        provider.getFeeData(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      if (fee?.maxFeePerGas) {
        const priority = fee.maxPriorityFeePerGas
          ? (fee.maxPriorityFeePerGas * BigInt(100 + priorityBoostPct)) / 100n
          : ethers.parseUnits('1.5', 'gwei');
        const base = fee.gasPrice ?? fee.maxFeePerGas;
        return { maxFeePerGas: (base * 2n) + priority, maxPriorityFeePerGas: priority };
      }
    } catch { /* next */ }
  }
  return { maxFeePerGas: null, maxPriorityFeePerGas: null };
}
