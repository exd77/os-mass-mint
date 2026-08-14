/**
 * PnL Tracking — cost basis, realized/unrealized gains, per-wallet
 *
 * Data sources:
 *   - Mint events (Transfer from 0x0) → acquisition at mint price + gas
 *   - Sale events (Transfer out to non-zero + consideration) or manual sale entry
 *   - Current floor price (opensea stats) → unrealized
 *
 * Storage: pnl.json (gitignored) — append-only events + derived positions
 */

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PNL_FILE = path.join(__dirname, '..', 'pnl.json');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';

// ─── Storage ───

function load() {
  try { return JSON.parse(fs.readFileSync(PNL_FILE, 'utf-8')); } catch { return { events: [] }; }
}
function save(d) { fs.writeFileSync(PNL_FILE, JSON.stringify(d, null, 2)); }

// ─── Event ingestion ───

export function recordMint({ chain, contract, tokenId, wallet, priceWei, gasWei, txHash, ts }) {
  const d = load();
  d.events.push({ type: 'mint', chain, contract, tokenId: String(tokenId), wallet: wallet.toLowerCase(), priceWei: String(priceWei || 0), gasWei: String(gasWei || 0), txHash, ts: ts || Date.now() });
  save(d);
}

export function recordSale({ chain, contract, tokenId, wallet, saleWei, feeWei, txHash, ts }) {
  const d = load();
  d.events.push({ type: 'sale', chain, contract, tokenId: String(tokenId), wallet: wallet.toLowerCase(), saleWei: String(saleWei || 0), feeWei: String(feeWei || 0), txHash, ts: ts || Date.now() });
  save(d);
}

export function recordTransfer({ chain, contract, tokenId, from, to, ts }) {
  const d = load();
  d.events.push({ type: 'transfer', chain, contract, tokenId: String(tokenId), from: from.toLowerCase(), to: to.toLowerCase(), ts: ts || Date.now() });
  save(d);
}

// ─── On-chain scan: auto-ingest mints + sales for our wallets ───

export async function scanWalletActivity({ wallets, chain, rpcUrl, fromBlock, toBlock, log = () => {} }) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  const head = toBlock || await provider.getBlockNumber();
  // full scan by default — chain history can be far older than any window,
  // and topic-filtered getLogs on this scale is cheap
  const start = Math.max(1, fromBlock ?? 1);

  // Scan all Transfer events for our wallets (as `to` = acquisition, as `from` = disposal)
  const toTopics = wallets.map(w => ethers.zeroPadValue(w, 32));
  const fromTopics = wallets.map(w => ethers.zeroPadValue(w, 32));

  // two-pass: to=ours (mint/receive), from=ours (sale/send)
  const [inLogs, outLogs] = await Promise.all([
    provider.getLogs({ topics: [TRANSFER_TOPIC, null, toTopics], fromBlock: start, toBlock: head }).catch(() => []),
    provider.getLogs({ topics: [TRANSFER_TOPIC, fromTopics], fromBlock: start, toBlock: head }).catch(() => []),
  ]);
  log(`[PNL] scan ${chain}: ${inLogs.length} in / ${outLogs.length} out events`);

  const d = load();
  for (const l of inLogs) {
    if (ethers.getAddress('0x' + l.topics[1].slice(26)) === ethers.getAddress(ZERO)) {
      // mint — need tx value for price
      const tx = await provider.getTransaction(l.transactionHash).catch(() => null);
      const mintCount = inLogs.filter(x => x.transactionHash === l.transactionHash && x.topics[1] === ethers.zeroPadValue(ZERO, 32)).length;
      const price = tx?.value ? tx.value / BigInt(Math.max(1, mintCount)) : 0n;
      const to = '0x' + l.topics[2].slice(26);
      d.events.push({ type: 'mint', chain, contract: l.address, tokenId: BigInt(l.topics[3]).toString(), wallet: to.toLowerCase(), priceWei: price.toString(), gasWei: '0', txHash: l.transactionHash, ts: l.blockNumber, block: l.blockNumber });
    } else {
      // received transfer (acquisition at unknown cost — mark 0 basis, user can edit)
      const to = '0x' + l.topics[2].slice(26);
      d.events.push({ type: 'transfer_in', chain, contract: l.address, tokenId: BigInt(l.topics[3]).toString(), wallet: to.toLowerCase(), from: ('0x' + l.topics[1].slice(26)).toLowerCase(), txHash: l.transactionHash, ts: l.blockNumber, block: l.blockNumber });
    }
  }
  for (const l of outLogs) {
    const from = '0x' + l.topics[1].slice(26);
    d.events.push({ type: 'transfer_out', chain, contract: l.address, tokenId: BigInt(l.topics[3]).toString(), wallet: from.toLowerCase(), to: ('0x' + l.topics[2].slice(26)).toLowerCase(), txHash: l.transactionHash, ts: l.blockNumber, block: l.blockNumber });
  }
  save(d);
  return { ingested: inLogs.length + outLogs.length };
}

// ─── Positions & PnL computation ───

export function computePositions(floorWeiByContract = {}) {
  const d = load();
  // token → position
  const positions = new Map();

  for (const e of [...d.events].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
    const key = `${e.chain}:${e.contract}:${e.tokenId}`;
    const p = positions.get(key) || { chain: e.chain, contract: e.contract, tokenId: e.tokenId, wallet: null, costWei: 0n, status: 'unowned', saleWei: null };

    if (e.type === 'mint' || e.type === 'transfer_in') {
      p.wallet = e.wallet;
      p.status = 'held';
      p.costWei += BigInt(e.priceWei || 0) + (e.gasWei ? BigInt(e.gasWei) : 0n);
    } else if (e.type === 'sale') {
      p.status = 'sold';
      p.saleWei = BigInt(e.saleWei || 0) - BigInt(e.feeWei || 0);
    } else if (e.type === 'transfer_out') {
      p.status = 'transferred';
    }
    positions.set(key, p);
  }

  let totalCost = 0n, realized = 0n, unrealized = 0n;
  const rows = [];
  for (const p of positions.values()) {
    const floor = floorWeiByContract[p.contract] || null;
    if (p.status === 'held') {
      totalCost += p.costWei;
      if (floor != null) unrealized += floor - p.costWei;
    } else if (p.status === 'sold' && p.saleWei != null) {
      realized += p.saleWei - p.costWei;
    }
    rows.push({
      ...p, costWei: p.costWei.toString(), saleWei: p.saleWei?.toString() ?? null,
      floorWei: floor?.toString() ?? null,
    });
  }

  const byWallet = {};
  for (const r of rows) {
    if (!r.wallet) continue;
    byWallet[r.wallet] = byWallet[r.wallet] || { held: 0, costWei: 0n, realizedWei: 0n };
    if (r.status === 'held') { byWallet[r.wallet].held++; byWallet[r.wallet].costWei += BigInt(r.costWei); }
    if (r.status === 'sold') byWallet[r.wallet].realizedWei += BigInt(r.saleWei || 0) - BigInt(r.costWei);
  }

  return {
    summary: {
      tokens: rows.length, held: rows.filter(r => r.status === 'held').length,
      sold: rows.filter(r => r.status === 'sold').length,
      totalCostWei: totalCost.toString(), realizedWei: realized.toString(),
      unrealizedWei: floorWeiByContract && Object.keys(floorWeiByContract).length ? unrealized.toString() : null,
    },
    byWallet: Object.fromEntries(Object.entries(byWallet).map(([w, v]) => [w, { held: v.held, costWei: v.costWei.toString(), realizedWei: v.realizedWei.toString() }])),
    positions: rows,
  };
}
