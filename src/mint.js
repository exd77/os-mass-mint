/**
 * Universal NFT Minter — Standalone Executable
 *
 * Usage:
 *   node src/mint.js <url-or-contract> [chain] [amount] [--dry-run] [--wallet <pk>]
 *
 * Examples:
 *   node src/mint.js https://opensea.io/collection/hoodies-879658705
 *   node src/mint.js https://opensea.io/collection/hoodies-879658705 robinhood 3
 *   node src/mint.js 0x00f1cc...19e3 robinhood 3
 *   node src/mint.js 0x00f1cc...19e3 robinhood 3 --dry-run
 */

import { ethers } from 'ethers';
import 'dotenv/config';

// ─── RPC Configuration ───

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

const CHAIN_IDS = {
  ethereum: 1, base: 8453, polygon: 137, arbitrum: 42161,
  optimism: 10, bsc: 56, 'zora-network': 7777777, robinhood: 4663,
};

const CHAIN_SLUG_MAP = {
  ethereum: 'ethereum', eth: 'ethereum', mainnet: 'ethereum',
  base: 'base',
  matic: 'polygon', polygon: 'polygon',
  arbitrum: 'arbitrum', arb: 'arbitrum',
  optimism: 'optimism', op: 'optimism',
  zora: 'zora-network', 'zora-network': 'zora-network',
  robinhood: 'robinhood', rh: 'robinhood',
  bsc: 'bsc', binance: 'bsc',
};

// ─── SeaDrop known addresses (fallback only — always discover from chain) ───

const SEADROP_KNOWN = {
  ethereum: '0x00005EA00Ac477B1030CE78506496e52C3dA7006',
  robinhood: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
};

// ─── Mint function signatures (tried in order) ───

const MINT_SIGNATURES = [
  { sig: 'mint(uint256)', args: ['amount'] },
  { sig: 'mint(address,uint256)', args: ['to', 'amount'] },
  { sig: 'publicMint(uint256)', args: ['amount'] },
  { sig: 'mintPublic(uint256)', args: ['amount'] },
  { sig: 'mint()', args: [] },
  { sig: 'claim(uint256)', args: ['amount'] },
  { sig: 'claim()', args: [] },
  // SeaDrop
  { sig: 'mintPublic(address,address,address,uint256)',
    args: ['nftContract', 'feeRecipient', 'minterIfNotPayer', 'quantity'],
    protocol: 'seadrop' },
  // Zora 1155
  { sig: 'mintWithRewards(address,uint256,uint256,bytes,address)',
    args: ['minter', 'tokenId', 'quantity', 'minterArgs', 'mintReferral'],
    protocol: 'zora' },
  // ERC1155 generic
  { sig: 'mint(address,uint256,uint256,bytes)',
    args: ['to', 'id', 'amount', 'data'] },
];

// ─── Price readers ───

const PRICE_READERS = [
  'function mintPrice() view returns (uint256)',
  'function price() view returns (uint256)',
  'function cost() view returns (uint256)',
  'function PRICE() view returns (uint256)',
  'function publicSalePrice() view returns (uint256)',
];

// ─── Parse input ───

function parseTarget(input) {
  const s = input.trim();

  // OpenSea assets URL
  let m = s.match(/opensea\.io\/assets\/([\w-]+)\/(0x[a-fA-F0-9]{40})(?:\/(\d+))?/);
  if (m) return { source: 'opensea', chain: chainSlug(m[1]), contract: m[2], tokenId: m[3] };

  // OpenSea collection URL → needs slug → contract lookup
  m = s.match(/opensea\.io\/collection\/([\w-]+)/);
  if (m) return { source: 'opensea_slug', slug: m[1] };

  // Manifold
  m = s.match(/manifold\.xyz\/c\/(\w+)/);
  if (m) return { source: 'manifold', claimId: m[1] };

  // Zora
  m = s.match(/zora\.co\/collect\/(\w+):(0x[a-fA-F0-9]{40})(?:\/(\d+))?/);
  if (m) return { source: 'zora', chain: chainSlug(m[1]), contract: m[2], tokenId: m[3] };

  // "0xABC on base 5" or "0xABC base 3"
  m = s.match(/(0x[a-fA-F0-9]{40})(?:\s+on\s+(\w+))?(?:\s+x?(\d+))?/i);
  if (m) return { source: 'direct', contract: m[1], chain: m[2] || 'ethereum', amount: Number(m[3] || 1) };

  throw new Error('cannot parse mint target');
}

function chainSlug(s) {
  return CHAIN_SLUG_MAP[s.toLowerCase()] || s;
}

// ─── Resolve OpenSea slug → contract ───

async function resolveOpenSeaSlug(slug) {
  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) throw new Error('OPENSEA_API_KEY not set — needed to resolve collection slug');

  const r = await fetch(
    `${process.env.OPENSEA_API_BASE || 'https://api.opensea.io/api/v2'}/collections/${slug}`,
    { headers: { 'X-API-KEY': apiKey } }
  );
  const j = await r.json();
  if (!j.contracts || j.contracts.length === 0) {
    throw new Error(`no contract found for collection "${slug}"`);
  }

  const c = j.contracts[0];
  const chain = chainSlug(c.chain);
  console.log(`[SLUG] ${slug} → ${c.address} on ${chain}`);
  return { contract: c.address, chain, slug };
}

// ─── Detect mint function ───

async function detectMintFunction(contract, signer) {
  // First check if this is a SeaDrop collection by fetching ABI from Blockscout
  const chainId = (await signer.provider.getNetwork()).chainId;
  const chainName = Object.entries(CHAIN_IDS).find(([_, id]) => id === Number(chainId))?.[0];
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
  const blockscoutUrl = blockscoutMap[chainName];
  if (blockscoutUrl) {
    try {
      const r = await fetch(`${blockscoutUrl}/api?module=contract&action=getabi&address=${contract}`);
      const j = await r.json();
      if (j.result && j.result !== 'Contract source code not verified') {
        const abi = JSON.parse(j.result);
        const hasMintSeaDrop = abi.some(e => e.name === 'mintSeaDrop');
        if (hasMintSeaDrop) {
          console.log('[FN] mintSeaDrop(address,uint256) — detected (seadrop)');
          return { sig: 'mintPublic(address,address,address,uint256)',
                   args: ['nftContract', 'feeRecipient', 'minterIfNotPayer', 'quantity'],
                   protocol: 'seadrop' };
        }
      }
    } catch (e) {
      console.log('[FN] Blockscout ABI fetch failed, trying direct detection...');
    }
  }

  // Standard mint function detection
  for (const fn of MINT_SIGNATURES) {
    const iface = new ethers.Interface([`function ${fn.sig} payable`]);
    const fnName = fn.sig.split('(')[0];

    // Build synthetic args
    const synthArgs = fn.args.map(arg => {
      if (arg === 'amount' || arg === 'quantity') return 1;
      if (arg === 'to' || arg === 'minter' || arg === 'minterIfNotPayer') return signer.address;
      if (arg === 'nftContract') return contract;
      if (arg === 'feeRecipient') return ethers.ZeroAddress;
      if (arg === 'mintReferral') return ethers.ZeroAddress;
      if (arg === 'tokenId') return 1;
      if (arg === 'minterArgs') return '0x';
      if (arg === 'data') return '0x';
      if (arg === 'id') return 1;
      return 0;
    });

    try {
      const data = iface.encodeFunctionData(fnName, synthArgs);
      await signer.provider.call({ to: contract, from: signer.address, data, value: 0n });
      // If call succeeds → function exists and works
      console.log(`[FN] ${fn.sig} — detected${fn.protocol ? ` (${fn.protocol})` : ''}`);
      return fn;
    } catch (e) {
      // Distinguish "no such function" from "reverted with reason"
      if (e.data && e.data !== '0x') {
        console.log(`[FN] ${fn.sig} — detected (reverts with data, needs value/args)${fn.protocol ? ` (${fn.protocol})` : ''}`);
        return fn;
      }
      continue;
    }
  }
  throw new Error('no recognized mint function found');
}

// ─── Detect mint price ───

async function detectPrice(contract, provider, amount = 1) {
  for (const sig of PRICE_READERS) {
    try {
      const c = new ethers.Contract(contract, [sig], provider);
      const fnName = sig.match(/function (\w+)/)[1];
      const p = await c[fnName]();
      const total = p * BigInt(amount);
      console.log(`[PRICE] ${fnName}() = ${ethers.formatEther(p)} ETH × ${amount} = ${ethers.formatEther(total)} ETH`);
      return total;
    } catch { continue; }
  }
  console.log('[PRICE] not found via readers (free mint or SeaDrop/Zora)');
  return 0n;
}

// ─── SeaDrop: discover address from on-chain tx history ───

async function discoverSeadropAddress(nftContract, provider) {
  // Try known addresses first
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const chainName = Object.entries(CHAIN_IDS).find(([_, id]) => id === chainId)?.[0];
  if (chainName && SEADROP_KNOWN[chainName]) {
    console.log(`[SEADROP] Using known address: ${SEADROP_KNOWN[chainName]}`);
    return SEADROP_KNOWN[chainName];
  }

  // Discover from recent Transfer events (from == 0x0 = mint)
  console.log('[SEADROP] Discovering from on-chain tx history...');
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const zeroAddr = '0x0000000000000000000000000000000000000000';

  const currentBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: nftContract,
    topics: [transferTopic, ethers.zeroPadValue(zeroAddr, 32)],
    fromBlock: Math.max(0, currentBlock - 100000),
    toBlock: currentBlock,
  });

  if (logs.length === 0) throw new Error('no mint events found to trace SeaDrop address');

  // Get the tx → 'to' field = SeaDrop
  const tx = await provider.getTransaction(logs[0].transactionHash);
  if (!tx) throw new Error('cannot fetch mint tx');

  console.log(`[SEADROP] Discovered: ${tx.to} (from tx ${logs[0].transactionHash.slice(0, 20)}...)`);
  return tx.to;
}

// ─── SeaDrop: get drop config ───

async function getSeadropDropConfig(seadropAddr, nftContract, provider) {
  const abi = [
    'function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  ];
  const seadrop = new ethers.Contract(seadropAddr, abi, provider);

  try {
    const drop = await seadrop.getPublicDrop(nftContract);
    return { mintPrice: drop.mintPrice, startTime: drop.startTime, endTime: drop.endTime,
             maxPerWallet: drop.maxTotalMintableByWallet, feeBps: drop.feeBps };
  } catch (e) {
    console.log('[SEADROP] getPublicDrop() reverted — using fallback price detection');
    return null;
  }
}

// ─── SeaDrop: get fee recipient ───

async function getSeadropFeeRecipient(seadropAddr, nftContract, provider) {
  const abi = [
    'function getAllowedFeeRecipients(address nftContract) view returns (address[])',
  ];
  const seadrop = new ethers.Contract(seadropAddr, abi, provider);

  try {
    const recipients = await seadrop.getAllowedFeeRecipients(nftContract);
    if (recipients.length > 0) return recipients[0];
  } catch {}

  // Fallback: read from recent mint tx
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const zeroAddr = '0x0000000000000000000000000000000000000000';
  const currentBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: nftContract,
    topics: [transferTopic, ethers.zeroPadValue(zeroAddr, 32)],
    fromBlock: Math.max(0, currentBlock - 100000),
    toBlock: currentBlock,
  });

  if (logs.length > 0) {
    const tx = await provider.getTransaction(logs[0].transactionHash);
    if (tx) {
      // Decode mintPublic input: nftContract(32), feeRecipient(32), minter(32), quantity(32)
      const data = tx.data;
      if (data.length >= 170) {
        const feeRecipient = '0x' + data.slice(10 + 64, 10 + 128).slice(24);
        console.log(`[SEADROP] Fee recipient from tx: ${feeRecipient}`);
        return feeRecipient;
      }
    }
  }

  console.log('[SEADROP] Fee recipient: using ZeroAddress');
  return ethers.ZeroAddress;
}

// ─── SeaDrop: get mint price from recent tx ───

async function getSeadropPriceFromTx(seadropAddr, nftContract, provider) {
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const zeroAddr = '0x0000000000000000000000000000000000000000';
  const currentBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: nftContract,
    topics: [transferTopic, ethers.zeroPadValue(zeroAddr, 32)],
    fromBlock: Math.max(0, currentBlock - 100000),
    toBlock: currentBlock,
  });

  if (logs.length > 0) {
    const tx = await provider.getTransaction(logs[0].transactionHash);
    if (tx && tx.value > 0n) {
      // Count Transfer events in same tx to get quantity
      const txLogs = logs.filter(l => l.transactionHash === tx.hash);
      const quantity = txLogs.length;
      const pricePerNFT = tx.value / BigInt(quantity);
      console.log(`[SEADROP] Price from tx: ${ethers.formatEther(pricePerNFT)} ETH (qty=${quantity}, total=${ethers.formatEther(tx.value)} ETH)`);
      return { pricePerNFT, feeRecipient: '0x' + tx.data.slice(10 + 64, 10 + 128).slice(24) };
    }
  }

  return { pricePerNFT: 0n, feeRecipient: ethers.ZeroAddress };
}

// ─── Auto gas ───

async function autoGas(provider, txRequest) {
  const feeData = await provider.getFeeData();

  let gasLimit;
  try {
    gasLimit = await provider.estimateGas(txRequest);
    gasLimit = (gasLimit * 120n) / 100n;  // +20% buffer
  } catch (e) {
    console.log(`[GAS] estimateGas failed: ${e.shortMessage || e.message}`);
    gasLimit = 300000n;  // fallback
  }

  // Priority fee
  const priorityFee = feeData.maxPriorityFeePerGas
    ? (feeData.maxPriorityFeePerGas * 110n) / 100n
    : ethers.parseUnits('1.5', 'gwei');

  // Max fee: baseFee*2 + priority
  const baseFee = feeData.gasPrice ?? feeData.maxFeePerGas ?? priorityFee;
  const maxFee = (baseFee * 2n) + priorityFee;

  console.log(`[GAS] limit=${gasLimit} priorityFee=${ethers.formatUnits(priorityFee, 'gwei')} gwei maxFee=${ethers.formatUnits(maxFee, 'gwei')} gwei`);

  return { gasLimit, maxPriorityFeePerGas: priorityFee, maxFeePerGas: maxFee };
}

// ─── Main mint function ───

async function mintOne(target, wallet, { dryRun = false } = {}) {
  const rpcUrl = RPCS[target.chain];
  if (!rpcUrl) throw new Error(`no RPC for chain "${target.chain}"`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = wallet.connect(provider);
  const chainId = CHAIN_IDS[target.chain];
  if (!chainId) throw new Error(`unknown chain ID for "${target.chain}"`);

  const amount = target.amount || 1;
  console.log(`\n[TARGET] ${target.contract} on ${target.chain} × ${amount}`);

  // ── Detect mint function ──
  const fn = await detectMintFunction(target.contract, signer);

  // ── SeaDrop special flow ──
  if (fn.protocol === 'seadrop') {
    return await mintSeadrop(target, signer, amount, dryRun);
  }

  // ── Standard mint flow ──
  const price = await detectPrice(target.contract, provider, amount);

  const iface = new ethers.Interface([`function ${fn.sig} payable`]);
  const fnName = fn.sig.split('(')[0];
  const args = buildArgs(fn, target, signer.address, amount);
  const data = iface.encodeFunctionData(fnName, args);

  const txRequest = {
    to: target.contract,
    from: signer.address,
    data,
    value: price,
  };

  // Simulate
  try {
    await provider.call(txRequest);
    console.log('[SIM] OK — simulation passed');
  } catch (e) {
    const reason = e.reason || e.shortMessage || e.message;
    if (dryRun) {
      console.log(`[SIM] revert: ${reason} (may need value)`);
    } else {
      throw new Error(`simulation revert: ${reason}`);
    }
  }

  if (dryRun) {
    console.log(`\n[DRY-RUN] Would send: to=${target.contract} value=${ethers.formatEther(price)} ETH data=${data.slice(0, 50)}...`);
    return { status: 'dry-run', target, price: price.toString() };
  }

  const gas = await autoGas(provider, txRequest);
  const tx = await signer.sendTransaction({ ...txRequest, ...gas, chainId });
  console.log(`[SENT] ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`[OK] block ${receipt.blockNumber} gasUsed ${receipt.gasUsed.toString()}`);
  console.log(`[VIEW] ${(EXPLORERS[target.chain] || '') + tx.hash}`);

  return {
    status: receipt.status === 1 ? 'success' : 'reverted',
    hash: tx.hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
  };
}

// ─── SeaDrop mint flow ──

async function mintSeadrop(target, signer, amount, dryRun) {
  const provider = signer.provider;

  // 1. Discover SeaDrop address
  const seadropAddr = await discoverSeadropAddress(target.contract, provider);
  console.log(`[SEADROP] Contract: ${seadropAddr}`);

  // 2. Get drop config
  const dropConfig = await getSeadropDropConfig(seadropAddr, target.contract, provider);
  let mintPrice, feeRecipient;

  if (dropConfig) {
    mintPrice = dropConfig.mintPrice * BigInt(amount);
    const fr = await getSeadropFeeRecipient(seadropAddr, target.contract, provider);
    feeRecipient = fr;
    console.log(`[SEADROP] Price: ${ethers.formatEther(dropConfig.mintPrice)} ETH × ${amount} = ${ethers.formatEther(mintPrice)} ETH`);
  } else {
    // Fallback: read from recent tx
    const txInfo = await getSeadropPriceFromTx(seadropAddr, target.contract, provider);
    mintPrice = txInfo.pricePerNFT * BigInt(amount);
    feeRecipient = txInfo.feeRecipient;
    console.log(`[SEADROP] Price (from tx): ${ethers.formatEther(txInfo.pricePerNFT)} ETH × ${amount} = ${ethers.formatEther(mintPrice)} ETH`);
  }

  console.log(`[SEADROP] Fee recipient: ${feeRecipient}`);

  // 3. Build calldata
  const abi = ['function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable'];
  const seadrop = new ethers.Contract(seadropAddr, abi, signer);

  // 4. Simulate
  try {
    await seadrop.mintPublic.staticCall(target.contract, feeRecipient, signer.address, amount, { value: mintPrice });
    console.log('[SIM] OK — simulation passed');
  } catch (e) {
    const reason = e.reason || e.shortMessage || e.message;
    // In dry-run, simulation revert is OK (staticCall may not handle msg.value properly on all chains)
    if (!dryRun) throw new Error(`SeaDrop simulation failed: ${reason}`);
    console.log(`[SIM] revert: ${reason} (proceeding in dry-run mode)`);
  }

  if (dryRun) {
    console.log(`\n[DRY-RUN] Would call mintPublic on ${seadropAddr}`);
    console.log(`  nftContract: ${target.contract}`);
    console.log(`  feeRecipient: ${feeRecipient}`);
    console.log(`  minter: ${signer.address}`);
    console.log(`  quantity: ${amount}`);
    console.log(`  value: ${ethers.formatEther(mintPrice)} ETH`);
    return { status: 'dry-run', seadrop: seadropAddr, price: mintPrice.toString() };
  }

  // 5. Send tx
  const tx = await seadrop.mintPublic(target.contract, feeRecipient, signer.address, amount, {
    value: mintPrice,
    gasLimit: 300000,
  });
  console.log(`[SENT] ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`[OK] block ${receipt.blockNumber} gasUsed ${receipt.gasUsed.toString()}`);
  console.log(`[VIEW] ${(EXPLORERS[target.chain] || '') + tx.hash}`);

  // 6. Verify — find minted token IDs from Transfer logs
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const mintLogs = receipt.logs.filter(
    l => l.topics[0] === transferTopic && l.topics[1] === ethers.zeroPadValue(ethers.ZeroAddress, 32)
  );

  const tokenIds = mintLogs.map(l => BigInt(l.topics[3]));
  console.log(`[MINTED] ${tokenIds.length} NFTs: ${tokenIds.map(id => '#' + id.toString()).join(', ')}`);

  return {
    status: receipt.status === 1 ? 'success' : 'reverted',
    hash: tx.hash,
    block: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    tokenIds: tokenIds.map(id => id.toString()),
  };
}

// ─── Build args for mint function ───

function buildArgs(fn, target, walletAddr, amount) {
  return fn.args.map(arg => {
    if (arg === 'amount' || arg === 'quantity') return amount;
    if (arg === 'to' || arg === 'minter' || arg === 'minterIfNotPayer') return walletAddr;
    if (arg === 'nftContract') return target.contract;
    if (arg === 'feeRecipient') return ethers.ZeroAddress;
    if (arg === 'mintReferral') return ethers.ZeroAddress;
    if (arg === 'tokenId') return target.tokenId ? BigInt(target.tokenId) : 1n;
    if (arg === 'minterArgs') return '0x';
    if (arg === 'data') return '0x';
    if (arg === 'id') return 1n;
    return 0n;
  });
}

// ─── CLI main ───

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const walletFlag = argv.indexOf('--wallet');
  const pkOverride = walletFlag >= 0 ? argv[walletFlag + 1] : null;

  const input = argv.filter(a => !a.startsWith('--') && a !== (pkOverride || '')).join(' ');
  if (!input) {
    console.error('Usage: node src/mint.js <url|contract> [chain] [amount] [--dry-run] [--wallet <pk>]');
    console.error('Examples:');
    console.error('  node src/mint.js https://opensea.io/collection/hoodies-879658705');
    console.error('  node src/mint.js https://opensea.io/collection/hoodies-879658705 robinhood 3');
    console.error('  node src/mint.js 0x00f1cc...19e3 robinhood 3 --dry-run');
    process.exit(1);
  }

  // Load wallet
  const pk = pkOverride || process.env.PRIVATE_KEY;
  if (!pk || pk === '0xyour_private_key_here') {
    console.error('[ERROR] PRIVATE_KEY not set in .env or --wallet flag');
    process.exit(1);
  }
  const wallet = new ethers.Wallet(pk);

  // Parse target
  let target = parseTarget(input);
  if (target.source === 'opensea_slug') {
    const resolved = await resolveOpenSeaSlug(target.slug);
    target.contract = resolved.contract;
    target.chain = resolved.chain;
    if (!target.amount) target.amount = 1;
  }

  console.log(`[WALLET] ${wallet.address}`);
  console.log(`[CHAIN] ${target.chain} (ID: ${CHAIN_IDS[target.chain]})`);

  const result = await mintOne(target, wallet, { dryRun });

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(e => {
  console.error(`[FAIL] ${e.message}`);
  process.exit(1);
});
