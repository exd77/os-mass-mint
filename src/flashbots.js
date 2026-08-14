/**
 * Flashbots Integration — bundle submission + Protect RPC + simulation
 *
 * Works WITHOUT API key using public endpoints:
 *   - Protect RPC: https://rpc.flashbots.net (fast, no auth)
 *   - relay: https://relay.flashbots.net (bundle API, no auth for simulate)
 *
 * Signed txs are forwarded to Flashbots → never in public mempool →
 * no sandwich/frontrun. Bundle = atomic all-or-nothing.
 */

import { ethers } from 'ethers';

export const FLASHBOTS_PROTECT_RPC = 'https://rpc.flashbots.net';
export const FLASHBOTS_RELAY = 'https://relay.flashbots.net';

// ─── Bundle simulation (no auth required for eth_callBundle via relay) ───

// ─── Auth signing (canonical Flashbots scheme) ───
// X-Flashbots-Signature: address:sig where sig = EIP-191 personal_sign over keccak256(request body)

async function fbAuthHeader(bodyString, authKey) {
  const signer = authKey ? new ethers.Wallet(authKey) : ethers.Wallet.createRandom();
  const hash = ethers.keccak256(ethers.toUtf8Bytes(bodyString));
  const sig = await signer.signMessage(ethers.hexlify(ethers.getBytes(hash)));
  return { 'X-Flashbots-Signature': `${signer.address}:${sig}` };
}

export async function simulateBundle(signedTxs, authKey) {
  const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com', undefined, { staticNetwork: true });
  const head = await provider.getBlockNumber().catch(() => null);
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_callBundle',
    params: [{
      txs: signedTxs,
      stateBlockNumber: head ? '0x' + head.toString(16) : 'latest',
      blockNumber: '0x' + ((head || 0) + 3).toString(16),
      timestamp: Math.floor(Date.now() / 1000),
      mintingPool: 'flashbots',
    }],
  });
  const r = await fetch(FLASHBOTS_RELAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await fbAuthHeader(body, authKey)) },
    body,
  });
  const j = await r.json();
  if (j.error) throw new Error(`flashbots: ${j.error.message}${j.error.data ? ` (${JSON.stringify(j.error.data).slice(0, 200)})` : ''}`);
  return j.result;
}

// ─── Send raw tx via Flashbots Protect (private, no auth) ───

export async function sendViaProtect(signedTx) {
  const body = {
    jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction',
    params: [signedTx],
  };
  const r = await fetch(FLASHBOTS_PROTECT_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.result) return { via: 'protect', hash: j.result };
  const err = String(j.error?.message || '').toLowerCase();
  if (err.includes('already known')) return { via: 'protect', hash: ethers.keccak256(signedTx), known: true };
  throw new Error(`flashbots protect: ${j.error?.message || r.status}`);
}

// ─── Full bundle submission (relay v2, needs auth signature — optional) ───

/**
 * Submit bundle to relay with auth header (HMAC via any wallet).
 * flashbotsAuthKey: private key string (optional — creates ephemeral if absent)
 */
export async function submitBundle(signedTxs, { blockNumber, authKey, minTimestamp, maxTimestamp } = {}) {
  const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com', undefined, { staticNetwork: true });
  const target = blockNumber || (await provider.getBlockNumber()) + 1;

  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_sendBundle',
    params: [{
      txs: signedTxs,
      blockNumber: '0x' + target.toString(16),
      ...(minTimestamp ? { minTimestamp } : {}),
      ...(maxTimestamp ? { maxTimestamp } : {}),
    }],
  });
  const r = await fetch(FLASHBOTS_RELAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await fbAuthHeader(body, authKey)) },
    body,
  });
  const j = await r.json();
  if (j.error) throw new Error(`flashbots bundle: ${j.error.message}`);
  return { bundleHash: j.result?.bundleHash, blockNumber: target };
}

// ─── Bundle stats / status (requires auth) ───

export async function bundleStats(bundleHash, authKey) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'flashbots_getBundleStats', params: [{ bundleHash, blockNumber: 'latest' }] });
  const r = await fetch(FLASHBOTS_RELAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await fbAuthHeader(body, authKey)) },
    body,
  });
  return (await r.json()).result;
}

// ─── Wait for tx via Protect RPC (receipts land normally) ───

export async function waitForReceiptProtect(txHash, { timeoutMs = 180000 } = {}) {
  const provider = new ethers.JsonRpcProvider(FLASHBOTS_PROTECT_RPC, undefined, { staticNetwork: true });
  return await provider.waitForTransaction(txHash, 1, timeoutMs);
}
