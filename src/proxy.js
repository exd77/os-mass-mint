/**
 * Proxy Pool Manager — per-wallet proxy rotation
 *
 * Storage: /root/minting/proxies.json (gitignored)
 * Format: { "proxies": [ { id, url, label, status, lastUsed, failCount } ] }
 *
 * URL schemes: http://, https://, socks5://, socks4://
 * With auth: http://user:pass@host:port
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const PROXIES_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'proxies.json');
const POOL_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'proxy-assignments.json');

let proxies = [];
let assignments = {}; // walletAddress -> proxyId

// ─── Persistence ───

function load() {
  try {
    proxies = JSON.parse(fs.readFileSync(PROXIES_FILE, 'utf-8')).proxies || [];
  } catch {
    proxies = [];
  }
  try {
    assignments = JSON.parse(fs.readFileSync(POOL_FILE, 'utf-8')).assignments || {};
  } catch {
    assignments = {};
  }
}

function save() {
  fs.writeFileSync(PROXIES_FILE, JSON.stringify({ proxies }, null, 2));
}

function saveAssignments() {
  fs.writeFileSync(POOL_FILE, JSON.stringify({ assignments }, null, 2));
}

load();

// ─── CRUD ───

export function listProxies() {
  return proxies.map(p => ({ ...p, url: maskUrl(p.url) }));
}

function maskUrl(url) {
  // Mask credentials in URL for display
  try {
    const u = new URL(url);
    if (u.username) {
      u.username = '***';
      u.password = '';
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

export function addProxy(url, label = '') {
  if (!isValidProxyUrl(url)) throw new Error(`invalid proxy url: ${url}`);
  if (proxies.some(p => p.url === url)) throw new Error('proxy already exists');
  const p = {
    id: crypto.randomUUID().slice(0, 8),
    url: url.trim(),
    label: label.trim(),
    status: 'unknown',
    failCount: 0,
    lastUsed: null,
    addedAt: Date.now(),
  };
  proxies.push(p);
  save();
  return p;
}

export function addProxiesBulk(text) {
  // Accept newline or comma separated
  const lines = text.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  const added = [], skipped = [];
  for (const line of lines) {
    try {
      const p = addProxy(line);
      added.push(p.id);
    } catch (e) {
      skipped.push({ line, reason: e.message });
    }
  }
  return { added: added.length, skipped };
}

export function removeProxy(id) {
  const before = proxies.length;
  proxies = proxies.filter(p => p.id !== id);
  if (proxies.length === before) throw new Error(`proxy ${id} not found`);
  // Clean assignments pointing to deleted proxy
  for (const [addr, pid] of Object.entries(assignments)) {
    if (pid === id) delete assignments[addr];
  }
  save();
  saveAssignments();
  return { removed: id };
}

export function clearProxies() {
  proxies = [];
  assignments = {};
  save();
  saveAssignments();
}

export function proxyCount() {
  return proxies.length;
}

export function isRotationEnabled() {
  return proxies.length > 0;
}

// ─── Validation ───

function isValidProxyUrl(url) {
  if (!/^((http|https|socks4|socks4a|socks5|socks5h):\/\/)/i.test(url)) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// ─── Test ───

export async function testProxy(id) {
  const p = proxies.find(x => x.id === id);
  if (!p) throw new Error(`proxy ${id} not found`);

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const r = await fetch('http://ip-api.com/json/?fields=status,message,query,country,city,isp', {
      agent: makeAgent(p.url),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const j = await r.json();
    const latency = Date.now() - start;
    if (j.status !== 'success') throw new Error(j.message || 'proxy returned error');
    p.status = 'ok';
    p.lastTested = Date.now();
    p.latency = latency;
    p.exitIp = j.query;
    p.geo = `${j.country}/${j.city}`;
    p.isp = j.isp;
    save();
    return { id, status: 'ok', latency, exitIp: j.query, geo: p.geo, isp: j.isp };
  } catch (e) {
    p.status = 'fail';
    p.failCount++;
    p.lastTested = Date.now();
    save();
    throw new Error(`proxy test failed: ${e.message}`);
  }
}

export async function testAllProxies() {
  const results = await Promise.allSettled(
    proxies.map(p => testProxy(p.id))
  );
  return {
    total: proxies.length,
    ok: results.filter(r => r.status === 'fulfilled').length,
    fail: results.filter(r => r.status === 'rejected').length,
  };
}

function makeAgent(url) {
  if (/^socks/i.test(url)) return new SocksProxyAgent(url);
  return new HttpsProxyAgent(url);
}

// ─── Per-wallet assignment ───

export function getAssignment(walletAddress) {
  return assignments[walletAddress] || null;
}

/**
 * Get a proxy for a wallet — sticky assignment.
 * If wallet already has a proxy, reuse it.
 * If not, assign the least-recently-used healthy proxy.
 * Returns null if pool empty (rotation disabled).
 */
export function proxyForWallet(walletAddress) {
  if (proxies.length === 0) return null;

  // Sticky: reuse existing assignment if proxy still exists
  const existing = assignments[walletAddress];
  if (existing) {
    const p = proxies.find(x => x.id === existing);
    if (p) return p;
    delete assignments[walletAddress];
  }

  // Assign: prefer 'ok' status, least recently used
  const sorted = [...proxies].sort((a, b) => {
    const sa = (a.status === 'ok' ? 0 : 1) + (a.lastUsed ?? 0) / 1e15;
    const sb = (b.status === 'ok' ? 0 : 1) + (b.lastUsed ?? 0) / 1e15;
    return sa - sb;
  });
  const chosen = sorted[0];
  assignments[walletAddress] = chosen.id;
  chosen.lastUsed = Date.now();
  saveAssignments();
  save();
  return chosen;
}

export function resetAssignments() {
  assignments = {};
  saveAssignments();
  return { cleared: true };
}

export function listAssignments() {
  const result = [];
  for (const [addr, pid] of Object.entries(assignments)) {
    const p = proxies.find(x => x.id === pid);
    if (p) result.push({ wallet: addr, proxyId: pid, proxyLabel: p.label || p.url.split('@').pop() || p.url });
  }
  return result;
}

// ─── Ethers provider through proxy ───

/**
 * Create a JsonRpcProvider routed through a proxy.
 * Ethers v6 FetchRequest supports custom getRequest/fetch.
 */
export function proxiedProvider(rpcUrl, proxyUrl) {
  if (!proxyUrl) return new ethers.JsonRpcProvider(rpcUrl);
  const fm = new ethers.FetchRequest(rpcUrl);
  const agent = makeAgent(proxyUrl);
  fm.getUrlFunc = ethers.FetchRequest.createGetUrlFunc({ agent });
  // Actually: ethers v6 supports getUrlFunc override
  const provider = new ethers.JsonRpcProvider(fm, undefined, { staticNetwork: true });
  return provider;
}
