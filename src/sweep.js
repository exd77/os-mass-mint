/**
 * NFT Sweep — transfer NFTs from many wallets to one destination
 *
 * Usage (programmatic):
 *   const result = await sweepNfts({ chain, contract, toAddress, walletIndices, jobId, log });
 *
 * Supports ERC-721 (safeTransferFrom / transferFrom) and ERC-1155 (safeBatchTransferFrom).
 */

import { ethers } from 'ethers';

const ERC721_ABI = [
  'function safeTransferFrom(address from, address to, uint256 tokenId) external',
  'function transferFrom(address from, address to, uint256 tokenId) external',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function supportsInterface(bytes4) view returns (bool)',
];

const ERC1155_ABI = [
  'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data) external',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])',
];

const ERC721_ENUMERABLE = '0x780e9d63'; // tokenOfOwnerByIndex(address,uint256)
const ERC165_721 = '0x80ac58cd';
const ERC165_1155 = '0xd9b67a26';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ─── Fetch NFTs owned by address (via Transfer logs) ───

async function ownedTokenIds(contract, ownerAddr, provider, log = () => {}) {
  const currentBlock = await provider.getBlockNumber();
  // Note: some RPCs (e.g. Robinhood) silently return [] when fromBlock is exactly 0 (0x0).
  // Use fromBlock 1 to be safe across providers.
  const logs = await provider.getLogs({
    address: contract,
    topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(ownerAddr, 32)],
    fromBlock: Math.max(1, currentBlock - 500000),
    toBlock: currentBlock,
  });
  const owned = new Map(); // tokenId -> { from, to }
  for (const l of logs) {
    const from = ethers.getAddress('0x' + l.topics[1].slice(26));
    const to = ethers.getAddress('0x' + l.topics[2].slice(26));
    if (topics3(l)) {
      // ERC-721 style (tokenId in topic3)
      const tokenId = BigInt(l.topics[3]).toString();
      if (to.toLowerCase() === ownerAddr.toLowerCase()) owned.set(tokenId, true);
      else owned.delete(tokenId);
    }
  }
  const ids = [...owned.keys()];
  log(`[SCAN] ${ownerAddr.slice(0, 10)}… holds ${ids.length} tokens of ${contract.slice(0, 10)}…`);
  return ids;
}

function topics3(l) {
  return l.topics.length >= 4;
}

// ─── Sweep ───

export async function sweepNfts({ chain, contract, toAddress, wallets, rpcUrl, chainId, explorer = '', jobId = 'sweep', log = () => {}, dryRun = false }) {
  if (!ethers.isAddress(toAddress)) throw new Error(`invalid destination address: ${toAddress}`);
  const dest = ethers.getAddress(toAddress);

  const summary = { total: wallets.length, success: 0, failed: 0, transferred: 0, txs: [], errors: [] };

  for (const { index, address, wallet } of wallets) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const signer = wallet.connect(provider);

      // Detect standard
      const c721 = new ethers.Contract(contract, ERC721_ABI, provider);
      let is721 = false;
      try { is721 = await c721.supportsInterface(ERC165_721); } catch { /* assume 721 */ }
      let is1155 = false;
      if (!is721) {
        const c1155 = new ethers.Contract(contract, ERC1155_ABI, provider);
        try { is1155 = await c1155.supportsInterface(ERC165_1155); } catch { is1155 = false; }
      }

      if (!is721 && !is1155) is721 = true; // fallback assume 721

      if (is721) {
        const ids = await ownedTokenIds(contract, address, provider, log);
        if (ids.length === 0) { summary.success++; continue; }
        if (dryRun) {
          log(`[DRY] ${address.slice(0, 10)}… would transfer ${ids.length} ERC-721 → ${dest.slice(0, 10)}…`);
          summary.success++;
          summary.transferred += ids.length;
          continue;
        }
        // Verify ownership of each (cheap) then transfer
        const c = c721.connect(signer);
        for (const id of ids) {
          try {
            const owner = await c.ownerOf(id);
            if (owner.toLowerCase() !== address.toLowerCase()) continue;
            log(`[SWEEP] ${address.slice(0, 10)}… token #${id} → ${dest.slice(0, 10)}…`);
            const tx = await c.safeTransferFrom(address, dest, id, { gasLimit: 120000 });
            log(`[SENT] ${tx.hash}`);
            const rcpt = await tx.wait();
            if (rcpt.status === 1) { summary.transferred++; summary.txs.push({ wallet: address, tokenId: id, hash: tx.hash, explorer: explorer + tx.hash }); }
          } catch (e) {
            summary.errors.push({ wallet: address, tokenId: id, error: e.shortMessage || e.message?.slice(0, 200) });
            log(`[FAIL] token #${id}: ${e.shortMessage || e.message?.slice(0, 120)}`);
          }
        }
        summary.success++;
      } else {
        // ERC-1155: use balanceOfBatch with discovered ids
        const ids = await ownedTokenIds1155(contract, address, provider, log);
        if (ids.length === 0) { summary.success++; continue; }
        if (dryRun) {
          log(`[DRY] ${address.slice(0, 10)}… would batch-transfer ${ids.length} ERC-1155 ids → ${dest.slice(0, 10)}…`);
          summary.success++;
          summary.transferred += ids.length;
          continue;
        }
        const c1155 = new ethers.Contract(contract, ERC1155_ABI, signer);
        const balances = await c1155.balanceOfBatch(ids.map(() => address), ids);
        const ownedIds = [], ownedAmts = [];
        for (let i = 0; i < ids.length; i++) {
          if (balances[i] > 0n) { ownedIds.push(ids[i]); ownedAmts.push(balances[i]); }
        }
        if (ownedIds.length === 0) { summary.success++; continue; }
        log(`[SWEEP] ${address.slice(0, 10)}… batch ${ownedIds.length} ids → ${dest.slice(0, 10)}…`);
        const tx = await c1155.safeBatchTransferFrom(address, dest, ownedIds, ownedAmts, '0x', { gasLimit: 200000 + ownedIds.length * 60000 });
        log(`[SENT] ${tx.hash}`);
        const rcpt = await tx.wait();
        if (rcpt.status === 1) {
          summary.transferred += ownedIds.length;
          summary.txs.push({ wallet: address, tokenIds: ownedIds, hash: tx.hash, explorer: explorer + tx.hash });
        }
        summary.success++;
      }
    } catch (e) {
      summary.failed++;
      summary.errors.push({ wallet: address, error: e.shortMessage || e.message?.slice(0, 200) });
      log(`[FAIL] wallet ${address}: ${e.shortMessage || e.message?.slice(0, 120)}`);
    }
  }

  log(`[DONE] sweep complete — wallets ok ${summary.success}/${summary.total}, tokens moved ${summary.transferred}`);
  return summary;
}

async function ownedTokenIds1155(contract, ownerAddr, provider, log) {
  const currentBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: contract,
    topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(ownerAddr, 32)],
    fromBlock: Math.max(1, currentBlock - 500000),
    toBlock: currentBlock,
  });
  const seen = new Set();
  for (const l of logs) {
    if (l.topics.length >= 4) {
      seen.add(BigInt(l.topics[3]).toString());
    } else {
      // ERC-1155 TransferSingle: id in data. data layout: operator(32) from(32) to(32) id(32) value(32)
      const id = BigInt('0x' + l.data.slice(2 + 64 * 3, 2 + 64 * 4)).toString();
      seen.add(id);
    }
  }
  log(`[SCAN] ${ownerAddr.slice(0, 10)}… seen ${seen.size} ERC-1155 ids`);
  return [...seen];
}
