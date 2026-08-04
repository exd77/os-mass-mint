/**
 * Mass NFT Minter — Multi-wallet parallel minting
 *
 * Usage:
 *   node src/mass-mint.js <url-or-contract> [chain] [amount-per-wallet] [--wallets <file>] [--max-concurrent 5]
 *
 * Examples:
 *   node src/mass-mint.js https://opensea.io/collection/hoodies-879658705 robinhood 3
 *   node src/mass-mint.js 0x00f1cc...19e3 robinhood 1 --wallets /root/wallets/evm-wallets.json
 */

import { ethers } from 'ethers';
import 'dotenv/config';
import fs from 'fs';
import pLimit from 'p-limit';

// Import shared config from mint.js
const RPCS = {
  ethereum: process.env.RPC_ETHEREUM || 'https://ethereum.publicnode.com',
  base: process.env.RPC_BASE || 'https://mainnet.base.org',
  polygon: process.env.RPC_POLYGON || 'https://polygon-bor-rpc.publicnode.com',
  arbitrum: process.env.RPC_ARBITRUM || 'https://arb1.arbitrum.io/rpc',
  optimism: process.env.RPC_OPTIMISM || 'https://mainnet.optimism.io',
  bsc: process.env.RPC_BSC || 'https://bsc-dataseed.binance.org',
  'zora-network': process.env.RPC_ZORA || 'https://rpc.zora.energy',
  robinhood: process.env.RPC_ROBINHOOD || 'https://rpc.mainnet.chain.robinhood.com/',
};

const CHAIN_IDS = {
  ethereum: 1, base: 8453, polygon: 137, arbitrum: 42161,
  optimism: 10, bsc: 56, 'zora-network': 7777777, robinhood: 4663,
};

const CHAIN_SLUG_MAP = {
  ethereum: 'ethereum', eth: 'ethereum', mainnet: 'ethereum',
  base: 'base', matic: 'polygon', polygon: 'polygon',
  arbitrum: 'arbitrum', arb: 'arbitrum',
  optimism: 'optimism', op: 'optimism',
  zora: 'zora-network', 'zora-network': 'zora-network',
  robinhood: 'robinhood', rh: 'robinhood', bsc: 'bsc', binance: 'bsc',
};

const EXPLORERS = {
  ethereum: 'https://etherscan.io/tx/',
  base: 'https://basescan.org/tx/',
  polygon: 'https://polygonscan.com/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
  bsc: 'https://bscscan.com/tx/',
  'zora-network': 'https://explorer.zora.energy/tx/',
  robinhood: 'https://robinhoodchain.blockscout.com/tx/',
};

const SEADROP_KNOWN = {
  ethereum: '0x00005EA00Ac477B1030CE78506496e52C3dA7006',
  robinhood: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
};

// ─── Parse input (same as mint.js) ───

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

async function resolveOpenSeaSlug(slug) {
  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) throw new Error('OPENSEA_API_KEY not set');
  const r = await fetch(
    `${process.env.OPENSEA_API_BASE || 'https://api.opensea.io/api/v2'}/collections/${slug}`,
    { headers: { 'X-API-KEY': apiKey } }
  );
  const j = await r.json();
  if (!j.contracts || j.contracts.length === 0) throw new Error(`no contract found for "${slug}"`);
  return { contract: j.contracts[0].address, chain: CHAIN_SLUG_MAP[j.contracts[0].chain] || j.contracts[0].chain };
}

// ─── SeaDrop discovery (shared logic) ───

async function discoverSeadropAddress(nftContract, provider) {
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const chainName = Object.entries(CHAIN_IDS).find(([_, id]) => id === chainId)?.[0];
  if (chainName && SEADROP_KNOWN[chainName]) return SEADROP_KNOWN[chainName];

  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const zeroAddr = ethers.zeroPadValue(ethers.ZeroAddress, 32);
  const currentBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: nftContract, topics: [transferTopic, zeroAddr],
    fromBlock: Math.max(0, currentBlock - 100000), toBlock: currentBlock,
  });
  if (logs.length === 0) throw new Error('no mint events to trace SeaDrop');
  const tx = await provider.getTransaction(logs[0].transactionHash);
  return tx.to;
}

async function getSeadropPriceAndFeeRecipient(seadropAddr, nftContract, provider) {
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
      return { pricePerNFT, feeRecipient };
    }
  }
  return { pricePerNFT: 0n, feeRecipient: ethers.ZeroAddress };
}

// ─── Mint per wallet ───

async function mintForWallet(wallet, target, amount) {
  const rpcUrl = RPCS[target.chain];
  if (!rpcUrl) throw new Error(`no RPC for "${target.chain}"`);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = wallet.connect(provider);
  const chainId = CHAIN_IDS[target.chain];

  // Check balance first
  const balance = await provider.getBalance(wallet.address);
  if (balance === 0n) {
    return { wallet: wallet.address, status: 'skipped', error: 'zero balance' };
  }

  // Try SeaDrop flow
  const seadropAddr = await discoverSeadropAddress(target.contract, provider);
  const { pricePerNFT, feeRecipient } = await getSeadropPriceAndFeeRecipient(seadropAddr, target.contract, provider);
  const totalValue = pricePerNFT * BigInt(amount);

  if (totalValue > 0 && balance < totalValue + ethers.parseUnits('0.001', 'ether')) {
    return { wallet: wallet.address, status: 'skipped', error: 'insufficient balance' };
  }

  const abi = ['function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable'];
  const seadrop = new ethers.Contract(seadropAddr, abi, signer);

  try {
    // Simulate
    await seadrop.mintPublic.staticCall(target.contract, feeRecipient, signer.address, amount, { value: totalValue });
  } catch (e) {
    return { wallet: wallet.address, status: 'error', error: `sim failed: ${e.reason || e.shortMessage || e.message}` };
  }

  // Send
  const tx = await seadrop.mintPublic(target.contract, feeRecipient, signer.address, amount, {
    value: totalValue, gasLimit: 300000,
  });

  const receipt = await tx.wait();

  // Find minted token IDs
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const mintLogs = receipt.logs.filter(
    l => l.topics[0] === transferTopic && l.topics[1] === ethers.zeroPadValue(ethers.ZeroAddress, 32)
  );
  const tokenIds = mintLogs.map(l => BigInt(l.topics[3]).toString());

  return {
    wallet: wallet.address,
    status: receipt.status === 1 ? 'success' : 'reverted',
    hash: tx.hash,
    tokenIds,
    gasUsed: receipt.gasUsed.toString(),
  };
}

// ─── Main ───

async function main() {
  const argv = process.argv.slice(2);
  const walletsFlag = argv.indexOf('--wallets');
  const walletsFile = walletsFlag >= 0 ? argv[walletsFlag + 1] : process.env.WALLETS_FILE || '/root/wallets/evm-wallets.json';
  const concurrentFlag = argv.indexOf('--max-concurrent');
  const maxConcurrent = concurrentFlag >= 0 ? parseInt(argv[concurrentFlag + 1]) : 5;

  const input = argv.filter(a => !a.startsWith('--') && a !== argv[walletsFlag + 1] && a !== argv[concurrentFlag + 1]).join(' ');
  if (!input) {
    console.error('Usage: node src/mass-mint.js <url|contract> [chain] [amount] [--wallets <file>] [--max-concurrent N]');
    process.exit(1);
  }

  // Load wallets
  const walletsData = JSON.parse(fs.readFileSync(walletsFile, 'utf-8'));
  const wallets = walletsData.map(w => new ethers.Wallet(w.privateKey || w.private_key || w.pk));
  console.log(`[WALLETS] Loaded ${wallets.length} wallets from ${walletsFile}`);

  // Parse target
  let target = parseTarget(input);
  if (target.source === 'opensea_slug') {
    const resolved = await resolveOpenSeaSlug(target.slug);
    target.contract = resolved.contract;
    target.chain = resolved.chain;
  }
  if (!target.amount) target.amount = 1;

  console.log(`[TARGET] ${target.contract} on ${target.chain} × ${target.amount} per wallet`);
  console.log(`[CONCURRENCY] ${maxConcurrent} parallel\n`);

  // Discover SeaDrop + price once (shared)
  const provider = new ethers.JsonRpcProvider(RPCS[target.chain]);
  const seadropAddr = await discoverSeadropAddress(target.contract, provider);
  const { pricePerNFT, feeRecipient } = await getSeadropPriceAndFeeRecipient(seadropAddr, target.contract, provider);
  console.log(`[SEADROP] ${seadropAddr}`);
  console.log(`[PRICE] ${ethers.formatEther(pricePerNFT)} ETH per NFT`);
  console.log(`[FEE] ${feeRecipient}\n`);

  // Mint in parallel
  const limit = pLimit(maxConcurrent);
  const tasks = wallets.map((w, i) => limit(async () => {
    console.log(`[${i + 1}/${wallets.length}] ${w.address} minting...`);
    try {
      const result = await mintForWallet(w, target, target.amount);
      if (result.status === 'success') {
        console.log(`[${i + 1}/${wallets.length}] ✅ ${w.address} → ${result.hash.slice(0, 20)}... tokens: ${result.tokenIds.join(', ')}`);
      } else if (result.status === 'skipped') {
        console.log(`[${i + 1}/${wallets.length}] ⏭  ${w.address} → ${result.error}`);
      } else {
        console.log(`[${i + 1}/${wallets.length}] ❌ ${w.address} → ${result.error}`);
      }
      return result;
    } catch (e) {
      console.log(`[${i + 1}/${wallets.length}] ❌ ${w.address} → ${e.message}`);
      return { wallet: w.address, status: 'error', error: e.message };
    }
  }));

  const results = await Promise.allSettled(tasks);
  const ok = results.filter(r => r.value?.status === 'success').length;
  const skipped = results.filter(r => r.value?.status === 'skipped').length;
  const failed = results.filter(r => r.value?.status === 'error' || r.status === 'rejected').length;

  console.log(`\n=== DONE ===`);
  console.log(`✅ Success: ${ok}/${wallets.length}`);
  console.log(`⏭  Skipped: ${skipped}`);
  console.log(`❌ Failed: ${failed}`);

  // Save results
  const reportFile = `/root/minting/mint-${Date.now()}.json`;
  fs.writeFileSync(reportFile, JSON.stringify(results.map(r => r.value || r.reason?.message), null, 2));
  console.log(`\nReport: ${reportFile}`);
}

main().catch(e => {
  console.error(`[FAIL] ${e.message}`);
  process.exit(1);
});
