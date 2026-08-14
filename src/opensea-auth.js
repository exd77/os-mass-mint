/**
 * OpenSea SIWE Auth + Voucher Fetch
 *
 * Flow (per OpenSea auth endpoints):
 *   1. GET /auth/nonce → per-address nonce
 *   2. Sign EIP-4361 (SIWE) message with wallet
 *   3. POST /auth (apikey auth) → JWT (valid ~15 min for wallet endpoint)
 *   4. GET /drops/v2/... voucher via wallet JWT → signed mint voucher
 *   5. BatchMintVoucherRequest on-chain (SeaDrop) — allowlist phase mints
 *
 * Storage: opensea-jwt.json (gitignored) — { [address]: { jwt, exp } }
 */

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JWT_FILE = path.join(__dirname, '..', 'opensea-jwt.json');
const API_BASE = 'https://api.opensea.io/api/v2';

function loadJwtStore() {
  try { return JSON.parse(fs.readFileSync(JWT_FILE, 'utf-8')); } catch { return {}; }
}
function saveJwtStore(store) {
  fs.writeFileSync(JWT_FILE, JSON.stringify(store, null, 2));
}

export function getStoredJwt(address) {
  const store = loadJwtStore();
  const e = store[address.toLowerCase()];
  if (!e) return null;
  if (e.exp && Date.now() / 1000 > e.exp - 60) return null; // expired
  return e.jwt;
}

function domainFor(chain) {
  // opensea uses per-chain subdomains for wallet API
  return { ethereum: 'api.opensea.io' }[chain] || 'api.opensea.io';
}

/**
 * Full SIWE login for one wallet. Returns JWT.
 */
export async function siweLogin(wallet, apiKey, chain = 'ethereum', log = () => {}) {
  const lower = wallet.address.toLowerCase();

  // 1. nonce
  const nr = await fetch(`${API_BASE}/auth/nonce?address=${lower}`, {
    headers: { 'x-api-key': apiKey },
  });
  if (!nr.ok) throw new Error(`nonce endpoint ${nr.status} — OpenSea SIWE auth may require a valid (non-expired) API key; public v2 API may not expose /auth/nonce. Regenerate key at opensea.io/settings`);
  const { nonce } = await nr.json();
  log(`[SIWE] nonce ${nonce.slice(0, 12)}… for ${wallet.address.slice(0, 10)}…`);

  // 2. SIWE message (EIP-4361)
  const issued = new Date().toISOString();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const siweMessage = [
    `opensea.io wants you to sign in with your Ethereum account:`,
    `${wallet.address}`,
    ``,
    `Sign in with Ethereum to the platform.`,
    ``,
    `URI: https://opensea.io`,
    `Version: 1`,
    `Chain ID: ${chainIdFor(chain)}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issued}`,
    `Expiration Time: ${expires}`,
  ].join('\n');

  const signature = await wallet.signMessage(siweMessage);

  // 3. verify → JWT
  const vr = await fetch(`${API_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ address: wallet.address, signature, nonce, chain: 'ethereum', statement: 'Sign in with Ethereum to the platform.' }),
  });
  if (!vr.ok) throw new Error(`auth ${vr.status}: ${(await vr.text()).slice(0, 200)}`);
  const { jwt } = await vr.json();
  if (!jwt) throw new Error('no jwt in auth response');

  // parse exp
  let exp = 0;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    exp = payload.exp || 0;
  } catch { /* keep 0 */ }
  log(`[SIWE] JWT ok for ${wallet.address.slice(0, 10)}… exp ${exp ? new Date(exp * 1000).toISOString() : '?'}`);

  const store = loadJwtStore();
  store[lower] = { jwt, exp };
  saveJwtStore(store);
  return jwt;
}

function chainIdFor(chain) {
  return { ethereum: 1, base: 8453, polygon: 137, arbitrum: 42161, optimism: 10, bsc: 56, 'zora-network': 7777777, robinhood: 4663 }[chain] || 1;
}

/**
 * Fetch mint voucher for a wallet on a drop (allowlist/claim phases).
 * dropId: opensea drop identifier (from collection drop data).
 */
export async function fetchVoucher(wallet, apiKey, { dropId, chain = 'ethereum' }, log = () => {}) {
  const jwt = getStoredJwt(wallet.address) || await siweLogin(wallet, apiKey, chain, log);

  const r = await fetch(`https://api.opensea.io/api/v2/drops/${dropId}/voucher?address=${wallet.address.toLowerCase()}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (r.status === 401) {
    log(`[VOUCHER] 401 — refreshing jwt`);
    const fresh = await siweLogin(wallet, apiKey, chain, log);
    return fetchVoucherInner(fresh, wallet, dropId);
  }
  return fetchVoucherInner(jwt, wallet, dropId);
}

async function fetchVoucherInner(jwt, wallet, dropId) {
  const r = await fetch(`https://api.opensea.io/api/v2/drops/${dropId}/voucher?address=${wallet.address.toLowerCase()}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) throw new Error(`voucher ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).voucher || (await r.json());
}

/**
 * List JWT store status (masked).
 */
export function jwtStatus() {
  const store = loadJwtStore();
  return Object.entries(store).map(([addr, e]) => ({
    address: addr.slice(0, 8) + '…' + addr.slice(-4),
    valid: !e.exp || Date.now() / 1000 < e.exp,
    expires: e.exp ? new Date(e.exp * 1000).toISOString() : null,
  }));
}
