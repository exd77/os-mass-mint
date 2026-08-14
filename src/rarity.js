/**
 * Rarity Fetcher — OpenSea rarity + collection stats
 *
 * API: OpenSea API v2 (X-API-KEY from env)
 * Cache: in-memory Map + file persistence (rarity-cache.json)
 *
 * Endpoints used:
 *   GET /collections/{slug}                    — collection meta
 *   GET /collections/{slug}/stats              — floor, volume
 *   GET /chain/{chain}/contract/{address}/nfts/{id}/rarity  — per-token rarity (OpenSea rarity feature)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const BASE = process.env.OPENSEA_API_BASE || 'https://api.opensea.io/api/v2';
const API_KEY = () => process.env.OPENSEA_API_KEY;

const CACHE_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'rarity-cache.json');
const CACHE_TTL = 1000 * 60 * 15; // 15 min
const cache = new Map();

// ─── File persistence ───

function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    for (const [k, v] of Object.entries(data)) cache.set(k, v);
  } catch { /* fresh */ }
}
function persistCache() {
  const obj = {};
  for (const [k, v] of cache.entries()) obj[k] = v;
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2)); } catch { /* ignore */ }
}
loadCache();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) { cache.delete(key); return null; }
  return hit.data;
}
function cacheSet(key, data) {
  cache.set(key, { at: Date.now(), data });
  persistCache();
}

// ─── OpenSea request helper ───

async function osFetch(pathname, retries = 2) {
  const key = API_KEY();
  if (!key) throw new Error('OPENSEA_API_KEY not set');
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(`${BASE}${pathname}`, { headers: { 'X-API-KEY': key } });
      if (r.status === 429) {
        await new Promise(res => setTimeout(res, 1200 * (i + 1)));
        continue;
      }
      if (!r.ok) throw new Error(`opensea ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(res => setTimeout(res, 800 * (i + 1)));
    }
  }
}

// ─── Collection stats ───

export async function collectionStats(slug) {
  const ck = `stats:${slug}`;
  const cached = cacheGet(ck);
  if (cached) return { ...cached, cached: true };

  const j = await osFetch(`/collections/${slug}/stats`);
  const data = {
    slug,
    floorPrice: j?.total?.floor_price ?? null,
    floorSymbol: j?.total?.floor_price_symbol || 'ETH',
    totalVolume: j?.total?.volume ?? null,
    totalSales: j?.total?.sales ?? null,
    totalSupply: j?.total?.count ?? null,
    numOwners: j?.total?.num_owners ?? null,
    marketCap: j?.total?.market_cap ?? null,
    avgPrice24h: j?.intervals?.find(i => i.interval === '1d')?.avg_price ?? null,
  };
  cacheSet(ck, data);
  return { ...data, cached: false };
}

// ─── Collection meta (resolve slug → contract) ───

export async function collectionMeta(slug) {
  const ck = `meta:${slug}`;
  const cached = cacheGet(ck);
  if (cached) return { ...cached, cached: true };

  const j = await osFetch(`/collections/${slug}`);
  const data = {
    slug,
    name: j.name,
    description: (j.description || '').slice(0, 300),
    chain: j.contracts?.[0]?.chain,
    contract: j.contracts?.[0]?.address,
    tokenStandard: j.contracts?.[0]?.token_standard,
    imageUrl: j.image_url,
    discordUrl: j.discord_url,
    externalUrl: j.external_url,
    twitterUrl: j.twitter_url,
    totalSupply: j.total_supply,
    floorPrice: j.floor_price ? `${j.floor_price} ${j.payment_tokens?.[0]?.symbol || 'ETH'}` : null,
  };
  cacheSet(ck, data);
  return { ...data, cached: false };
}

// ─── Per-token rarity (OpenSea rarity endpoint) ───

const OS_CHAIN_SLUGS = {
  ethereum: 'ethereum', base: 'base', polygon: 'matic', arbitrum: 'arbitrum',
  optimism: 'optimism', bsc: 'bsc', 'zora-network': 'zora', robinhood: null, // RH not on OS
};
const OS_CHAIN_BY_NAME = {
  ethereum: 'ethereum', matic: 'polygon', polygon: 'polygon', arbitrum: 'arbitrum',
  base: 'base', optimism: 'optimism', bsc: 'bsc', 'zora-network': 'zora',
};

export async function tokenRarity(chainName, contract, tokenId) {
  const osChain = OS_CHAIN_BY_NAME[chainName];
  if (!osChain) throw new Error(`rarity not available for chain "${chainName}" (OpenSea-supported: ${Object.keys(OS_CHAIN_BY_NAME).join(', ')})`);

  const ck = `rarity:${osChain}:${contract.toLowerCase()}:${tokenId}`;
  const cached = cacheGet(ck);
  if (cached) return { ...cached, cached: true };

  const j = await osFetch(`/chain/${osChain}/contract/${contract}/nfts/${tokenId}/rarity`);
  const data = {
    chain: osChain,
    contract,
    tokenId,
    rarityRank: j?.rarity_rank ?? null,
    rarityScore: j?.rarity_score ?? null,
    nft: j?.nft ? { name: j.nft.name, image: j.nft.image_url, description: (j.nft.description || '').slice(0, 200) } : null,
  };
  cacheSet(ck, data);
  return { ...data, cached: false };
}

/**
 * Batch rarity: fetch multiple token IDs for a contract.
 * Rate-limit friendly: sequential with small delay.
 */
export async function batchRarity(chainName, contract, tokenIds, { delayMs = 350 } = {}) {
  const results = [];
  for (const id of tokenIds.slice(0, 50)) {
    try {
      results.push(await tokenRarity(chainName, contract, id));
    } catch (e) {
      results.push({ tokenId: id, error: e.message });
    }
    if (tokenIds.length > 1) await new Promise(r => setTimeout(r, delayMs));
  }
  const ranked = results.filter(r => r.rarityRank != null).sort((a, b) => a.rarityRank - b.rarityRank);
  return { total: results.length, ranked: ranked.length, results, best: ranked[0] || null };
}

export function rarityCacheStats() {
  return { entries: cache.size, file: CACHE_FILE };
}
