/**
 * Pre-sign Engine — build & sign TXs offline before drop opens
 *
 * Everything that can be done without the drop being live
 * (ABI encode, nonce fetch, gas fetch, signing) happens in PREP phase.
 * At T-0 only the broadcast remains.
 *
 * Usage:
 *   const plan = await prepareMintPlan({ chain, contract, amount, wallets, rpcUrl, ... });
 *   plan.built[]  → { wallet, signedTx, hash, nonce } ready to fire
 *   plan.summary()
 */

import { ethers } from 'ethers';
import { chainRpcPool, rankEndpoints, sendRawToAll, waitForReceiptAny, fastFeeData } from './broadcast.js';

const SEADROP_MINT_ABI = ['function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable'];

/**
 * Prepare a pre-signed SeaDrop mint plan for many wallets.
 *
 * Steps (all offline-safe except the 2 marked network reads):
 *  1. Resolve SeaDrop address + price + feeRecipient (network read, cached)
 *  2. Fetch nonce + balance per wallet (network read, parallel)
 *  3. Fetch gas fee (fastest of pool)
 *  4. Build + sign TX for every wallet — stored raw, ready to broadcast
 */
export async function prepareMintPlan({ chain, contract, amount = 1, wallets, rpcUrl, chainId, gasLimit = 300000, skipBalanceCheck = false, log = () => {} }) {
  const t0 = Date.now();
  const pool = chainRpcPool(chain, rpcUrl);
  log(`[POOL] ${pool.length} rpc endpoints for ${chain}`);

  // 1. Rank endpoints once — fastest becomes our read RPC
  const ranked = await rankEndpoints(pool);
  const healthy = ranked.filter(r => r.latencyMs != null);
  if (!healthy.length) throw new Error('all rpc endpoints unreachable');
  const fastUrls = healthy.map(h => h.url);
  log(`[POOL] fastest: ${healthy[0].url.replace(/^https?:\/\//, '')} (${healthy[0].latencyMs}ms), ${healthy.length}/${pool.length} healthy`);

  const readProvider = new ethers.JsonRpcProvider(fastUrls[0], undefined, { staticNetwork: true });

  // 2. SeaDrop resolve (reuse known address from chains config if provided)
  const seadropAddr = await resolveSeadrop(contract, readProvider, chain, log);
  const { pricePerNFT, feeRecipient } = await seadropPriceAndFee(seadropAddr, contract, readProvider, log);
  const totalValue = pricePerNFT * BigInt(amount);
  log(`[PREP] price ${ethers.formatEther(pricePerNFT)} ETH × ${amount} = ${ethers.formatEther(totalValue)} ETH`);

  // 3. Fee data from fastest endpoint
  const fee = await fastFeeData(fastUrls);
  if (!fee.maxFeePerGas) throw new Error('could not fetch fee data from any endpoint');
  log(`[PREP] gas maxFee=${ethers.formatUnits(fee.maxFeePerGas, 'gwei')} gwei tip=${ethers.formatUnits(fee.maxPriorityFeePerGas, 'gwei')} gwei`);

  // 4. Parallel per-wallet: nonce, balance check, sign
  const built = [];
  const seadropIface = new ethers.Interface(SEADROP_MINT_ABI);
  const data = seadropIface.encodeFunctionData('mintPublic', [contract, feeRecipient, '0x0000000000000000000000000000000000000000', BigInt(amount)]);

  const results = await Promise.allSettled(wallets.map(async ({ index, address, wallet }) => {
    // minterIfNotPayer = wallet itself (standard)
    const dataW = seadropIface.encodeFunctionData('mintPublic', [contract, feeRecipient, address, BigInt(amount)]);
    const nonce = await readProvider.getTransactionCount(address, 'pending');
    const balance = await readProvider.getBalance(address);

    const insufficient = !skipBalanceCheck && totalValue > 0n && balance < totalValue + ethers.parseUnits('0.001', 'ether');
    if (insufficient) {
      return { index, address, error: `insufficient balance: ${ethers.formatEther(balance)} ETH` };
    }

    const tx = await wallet.signTransaction({
      to: seadropAddr,
      data: dataW,
      value: totalValue,
      gasLimit,
      nonce,
      chainId,
      type: 2,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    });
    return {
      index, address, signedTx: tx, hash: ethers.keccak256(tx), nonce,
      value: totalValue.toString(),
    };
  }));

  let okCount = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value.error) {
        built.push(r.value);
        log(`[PREP] wallet ${r.value.address.slice(0, 10)}… SKIP — ${r.value.error}`);
      } else {
        built.push(r.value);
        okCount++;
      }
    } else {
      log(`[PREP] wallet build failed — ${String(r.reason?.message).slice(0, 120)}`);
    }
  }

  const prepMs = Date.now() - t0;
  log(`[PREP] ${okCount}/${wallets.length} TXs pre-signed in ${prepMs}ms — READY TO FIRE`);

  return {
    chain, contract, seadropAddr, amount,
    pricePerNFT: pricePerNFT.toString(),
    feeRecipient,
    fastUrls,
    built,
    prepMs,
    ready: built.filter(b => b.signedTx),
    summary() {
      return { chain, contract, signed: this.ready.length, total: wallets.length, prepMs, endpoints: this.fastUrls.length };
    },
  };
}

// ─── Fire: broadcast all pre-signed TXs simultaneously ───

export async function fireMintPlan(plan, { maxUrls = 6, log = () => {} } = {}) {
  const t0 = Date.now();
  const results = [];
  log(`[FIRE] broadcasting ${plan.ready.length} signed TXs to ${Math.min(plan.fastUrls.length, maxUrls)} endpoints…`);

  const fired = plan.ready.map(async (b) => {
    try {
      const sent = await sendRawToAll(b.signedTx, plan.fastUrls, { maxUrls });
      log(`[FIRE] ${b.address.slice(0, 10)}… accepted via ${new URL(sent.url).host}${sent.known ? ' (already known)' : ''}`);
      return { ...b, sentVia: sent.url, status: 'sent' };
    } catch (e) {
      log(`[FIRE] ${b.address.slice(0, 10)}… FAIL — ${String(e.message).slice(0, 150)}`);
      return { ...b, status: 'error', error: String(e.message).slice(0, 300) };
    }
  });
  const sentResults = await Promise.all(fired);

  // Receipt race across endpoints
  log('[WAIT] racing receipts across endpoints…');
  const confirmed = sentResults.map(async (b) => {
    if (b.status !== 'sent') return b;
    try {
      const rcpt = await waitForReceiptAny(b.hash, plan.fastUrls);
      const ok = rcpt?.status === 1;
      log(`[${ok ? 'OK' : 'REVERT'}] ${b.address.slice(0, 10)}… block ${rcpt.blockNumber}`);
      return { ...b, status: ok ? 'success' : 'reverted', block: rcpt.blockNumber, gasUsed: rcpt.gasUsed?.toString() };
    } catch (e) {
      return { ...b, status: 'pending', error: String(e.message).slice(0, 200) };
    }
  });

  const final = await Promise.all(confirmed);
  const fireMs = Date.now() - t0;
  const ok = final.filter(f => f.status === 'success').length;
  log(`[DONE] ${ok}/${final.length} confirmed in ${fireMs}ms`);

  return { results: final, ok, total: final.length, fireMs };
}

// ─── SeaDrop helpers (network reads, same logic as server.js) ───

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';

export const SEADROP_KNOWN = {
  ethereum: '0x00005EA00Ac477B1030CE78506496e52C3dA7006',
  robinhood: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
};

async function resolveSeadrop(nftContract, provider, chainName, log) {
  if (SEADROP_KNOWN[chainName]) {
    log(`[SEADROP] known address ${SEADROP_KNOWN[chainName]}`);
    return SEADROP_KNOWN[chainName];
  }
  const currentBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: nftContract,
    topics: [TRANSFER_TOPIC, ethers.zeroPadValue(ZERO, 32)],
    fromBlock: Math.max(1, currentBlock - 100000), toBlock: currentBlock,
  });
  if (!logs.length) throw new Error('no mint events to trace SeaDrop');
  const tx = await provider.getTransaction(logs[0].transactionHash);
  log(`[SEADROP] discovered ${tx.to} from tx history`);
  return tx.to;
}

async function seadropPriceAndFee(seadropAddr, nftContract, provider, log) {
  // Try getPublicDrop first (canonical)
  try {
    const c = new ethers.Contract(seadropAddr, [
      'function getPublicDrop(address) view returns (tuple(uint80 mintPrice, uint48 start, uint48 end, uint16 max, uint16 feeBps, bool restrict))',
    ], provider);
    const drop = await c.getPublicDrop(nftContract);
    if (drop.mintPrice !== undefined) {
      // feeRecipient still needs discovery — fall through to tx scan
      const { feeRecipient } = await seadropFeeFromTx(seadropAddr, nftContract, provider);
      log(`[SEADROP] getPublicDrop price=${ethers.formatEther(drop.mintPrice)} ETH window=${drop.start}-${drop.end}`);
      return { pricePerNFT: drop.mintPrice, feeRecipient };
    }
  } catch { /* fallback */ }
  const fromTx = await seadropFeeFromTx(seadropAddr, nftContract, provider);
  const price = await seadropPriceFromTx(seadropAddr, nftContract, provider);
  return { pricePerNFT: price, feeRecipient: fromTx.feeRecipient };
}

async function seadropFeeFromTx(seadropAddr, nftContract, provider) {
  const currentBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: nftContract,
    topics: [TRANSFER_TOPIC, ethers.zeroPadValue(ZERO, 32)],
    fromBlock: Math.max(1, currentBlock - 100000), toBlock: currentBlock,
  });
  if (logs.length) {
    const tx = await provider.getTransaction(logs[0].transactionHash);
    if (tx?.data && tx.data.length >= 170) {
      return { feeRecipient: '0x' + tx.data.slice(10 + 64, 10 + 128).slice(24) };
    }
  }
  return { feeRecipient: ZERO };
}

async function seadropPriceFromTx(seadropAddr, nftContract, provider) {
  const currentBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: nftContract,
    topics: [TRANSFER_TOPIC, ethers.zeroPadValue(ZERO, 32)],
    fromBlock: Math.max(1, currentBlock - 100000), toBlock: currentBlock,
  });
  if (logs.length) {
    const tx = await provider.getTransaction(logs[0].transactionHash);
    if (tx && tx.value > 0n) {
      const qty = logs.filter(l => l.transactionHash === tx.hash).length || 1;
      return tx.value / BigInt(qty);
    }
  }
  return 0n;
}
