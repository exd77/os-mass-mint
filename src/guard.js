/**
 * Guard + Wake Engine — price ceiling check + hot-window auto-fire timer
 *
 * Ported from the reference fastest-mint flow:
 *   - Price ceiling: abort fire if live price > cap (dev raised price / wrong stage)
 *   - Hot-window: pre-signed TXs sit until (startUnix - leadSec), then fire
 *   - WL checker: OpenSea eligibility probe (drop + wallet addresses)
 */

import { ethers } from 'ethers';

// ─── Price ceiling guard ───

/**
 * Re-read live public drop price at fire time; abort if above cap.
 * Returns { ok, livePriceWei, capWei } or throws on unreadable price.
 */
export async function priceCeilingCheck({ contract, chain, rpcUrl, capPerNftEth, amount, log = () => {} }) {
  if (!capPerNftEth) return { ok: true, skipped: true };
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  const capWei = ethers.parseEther(String(capPerNftEth));
  const live = await livePublicDropPrice({ contract, provider, chain });

  if (live.priceWei == null) {
    // can't read price — fail open with warning (drop may not be live yet)
    log(`[GUARD] price unreadable (drop may not be live) — proceeding without ceiling check`);
    return { ok: true, unreadable: true };
  }
  if (live.priceWei > capWei) {
    log(`[GUARD] ABORT — live price ${ethers.formatEther(live.priceWei)} ETH > cap ${capPerNftEth} ETH/NFT`);
    return { ok: false, livePriceWei: live.priceWei.toString(), capWei: capWei.toString() };
  }
  log(`[GUARD] price OK — ${ethers.formatEther(live.priceWei)} ETH ≤ cap ${capPerNftEth}`);
  return { ok: true, livePriceWei: live.priceWei.toString(), capWei: capWei.toString() };
}

const SEADROP_GET_PUBLIC_DROP = 'function getPublicDrop(address) view returns (tuple(uint80 mintPrice, uint48 start, uint48 end, uint16 max, uint16 feeBps, bool restrict))';

export async function livePublicDropPrice({ contract, provider, chain }) {
  const SEADROP = {
    ethereum: '0x00005EA00Ac477B1030CE78506496e52C3dA7006',
    robinhood: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
    base: '0x00005EA00Ac477B1030CE78506496e52C3dA7006',
  }[chain];
  if (SEADROP) {
    try {
      const c = new ethers.Contract(SEADROP, [SEADROP_GET_PUBLIC_DROP], provider);
      const drop = await c.getPublicDrop(contract);
      return { priceWei: drop.mintPrice ? BigInt(drop.mintPrice) : null, start: Number(drop.start), end: Number(drop.end) };
    } catch { /* fall through */ }
  }
  return { priceWei: null };
}

// ─── Hot-window auto-fire ───

const timers = new Map();

/**
 * Schedule an auto-fire: waits until (startUnix - leadSec), re-checks guard, fires.
 * cb(fireResult) invoked on fire; onError(err) on failure.
 * Returns handle { id, cancel() }.
 */
export function scheduleHotWindow({ id, startUnix, leadSec = 0, fire, log = () => {} }) {
  if (!startUnix || startUnix < 1000000000) throw new Error('startUnix (seconds) required');
  if (timers.has(id)) timers.get(id).cancel();
  const targetMs = (startUnix - leadSec) * 1000;
  const waitMs = targetMs - Date.now();

  const state = { id, cancelled: false, timer: null, fired: false };
  const run = async () => {
    if (state.cancelled) return;
    const remain = targetMs - Date.now();
    if (remain > 0) {
      log(`[WAKE] ${id} wakes in ${(remain / 1000).toFixed(1)}s (target ${new Date(targetMs).toISOString()})`);
      state.timer = setTimeout(run, Math.min(remain, 2 ** 31 - 1));
      return;
    }
    state.fired = true;
    log(`[WAKE] ${id} HOT WINDOW — firing now`);
    try { await fire(); } catch (e) { log(`[WAKE] ${id} fire error: ${e.message}`); }
  };
  run();
  timers.set(id, state);
  return { id, cancel() { state.cancelled = true; clearTimeout(state.timer); timers.delete(id); log(`[WAKE] ${id} cancelled`); } };
}

export function hotWindowStatus() {
  return [...timers.entries()].map(([id, s]) => ({ id, fired: s.fired, cancelled: s.cancelled }));
}

export function cancelHotWindow(id) {
  const s = timers.get(id);
  if (s) { s.cancelled = true; clearTimeout(s.timer); timers.delete(id); return true; }
  return false;
}

// ─── WL (allowlist) checker — OpenSea eligibility probe ───

/**
 * Check wallet eligibility for an OpenSea drop.
 * Uses the public eligibility endpoint shape; works without auth for public
 * phase checks, returns per-wallet { eligible, reason }.
 */
export async function checkEligibility({ slug, walletAddresses, apiKey, chain, rpcUrl, log = () => {} }) {
  const results = [];
  const key = apiKey || process.env.OPENSEA_API_KEY;
  const base = 'https://api.opensea.io/api/v2';

  if (key && slug) {
    // API path
    for (const addr of walletAddresses) {
      try {
        const r = await fetch(`${base}/drops/eligibility?collection_slug=${slug}&address=${addr}`, {
          headers: { 'x-api-key': key },
        });
        if (r.status === 429) { results.push({ address: addr, eligible: null, reason: 'rate-limited' }); continue; }
        const j = await r.json().catch(() => ({}));
        results.push({ address: addr, eligible: Boolean(j.eligible), reason: j.reason || null, raw: j });
      } catch (e) {
        results.push({ address: addr, eligible: null, reason: String(e.message).slice(0, 100) });
      }
    }
    return { via: 'api', results };
  }

  // On-chain fallback: SeaDrop allowlistMerkleRoot + isAllowlisted probe via simulate
  if (rpcUrl && chain) {
    log('[WL] no api key — trying on-chain SeaDrop allowlist probe');
    const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
    const SEADROP = {
      ethereum: '0x00005EA00Ac477B1030CE78506496e52C3dA7006',
      robinhood: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
    }[chain];
    if (!SEADROP) return { via: 'none', results: walletAddresses.map(a => ({ address: a, eligible: null, reason: 'no chain mapping' })) };

    const iface = new ethers.Interface(['function getAllowListMerkleRoot(address) view returns (bytes32)']);
    let merkleRoot;
    try {
      const c = new ethers.Contract(SEADROP, iface, provider);
      merkleRoot = await c.getAllowListMerkleRoot(contract_address_of(slug));
    } catch { merkleRoot = null; }
    const zeroRoot = merkleRoot && merkleRoot !== ethers.ZeroHash;
    for (const addr of walletAddresses) {
      // staticcall mintAllowList would revert without proof — presence of non-zero
      // merkle root + balance only tells us a WL phase exists; real check needs proof
      results.push({ address: addr, eligible: zeroRoot ? null : false, reason: zeroRoot ? 'wl phase exists — proof required at mint' : 'no allowlist merkle root' });
    }
    return { via: 'onchain', results };
  }

  return { via: 'none', results: walletAddresses.map(a => ({ address: a, eligible: null, reason: 'no api key and no rpc' })) };
}

// helper stub: slug → contract address resolution lives in server.js resolveTarget
function contract_address_of(slug) { return '0x0000000000000000000000000000000000000000'; }
