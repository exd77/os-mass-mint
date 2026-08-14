/**
 * Solana Support — wallet gen/import, balance, transfer, NFT mint
 *
 * RPC: https://api.mainnet-beta.solana.com (rate limited) —
 *      set SOLANA_RPC in .env for a paid endpoint (Helius/QuickNode)
 *
 * Wallet store: solana-wallets.json (gitignored), same shape as EVM wallets
 */

import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
  SystemProgram, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOL_WALLETS_FILE = path.join(__dirname, '..', 'solana-wallets.json');

function conn() {
  const url = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  return new Connection(url, 'confirmed');
}

function loadSolWallets() {
  try { return JSON.parse(fs.readFileSync(SOL_WALLETS_FILE, 'utf-8')); } catch { return []; }
}
function saveSolWallets(w) { fs.writeFileSync(SOL_WALLETS_FILE, JSON.stringify(w, null, 2)); }

// ─── Wallet management ───

export function generateSolWallets(count = 1) {
  const wallets = loadSolWallets();
  const created = [];
  for (let i = 0; i < count; i++) {
    const kp = Keypair.generate();
    const entry = {
      index: wallets.length,
      publicKey: kp.publicKey.toBase58(),
      secretKey: Buffer.from(kp.secretKey).toString('base64'),
    };
    wallets.push(entry);
    created.push({ index: entry.index, publicKey: entry.publicKey });
  }
  saveSolWallets(wallets);
  return created;
}

export function importSolWallet(secretKeyBase58Or64) {
  const wallets = loadSolWallets();
  let kp;
  try {
    // try base64 (our format) then raw base58 secret array
    const raw = Buffer.from(secretKeyBase58Or64, 'base64');
    kp = Keypair.fromSecretKey(raw);
  } catch {
    try {
      const arr = JSON.parse(secretKeyBase58Or64);
      kp = Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {
      throw new Error('unrecognized secret key format — base64 or JSON array');
    }
  }
  const entry = { index: wallets.length, publicKey: kp.publicKey.toBase58(), secretKey: Buffer.from(kp.secretKey).toString('base64') };
  wallets.push(entry);
  saveSolWallets(wallets);
  return { index: entry.index, publicKey: entry.publicKey };
}

function kpFromEntry(entry) {
  return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(entry.secretKey, 'base64')));
}

// ─── Read ops (public keys only — safe) ───

export async function solBalances() {
  const connection = conn();
  const wallets = loadSolWallets();
  const out = [];
  for (const w of wallets) {
    try {
      const lamports = await connection.getBalance(new PublicKey(w.publicKey));
      out.push({ index: w.index, publicKey: w.publicKey, sol: lamports / LAMPORTS_PER_SOL, lamports });
    } catch (e) {
      out.push({ index: w.index, publicKey: w.publicKey, sol: null, error: String(e.message).slice(0, 100) });
    }
  }
  return out;
}

// ─── Transfer SOL (dev fund → mint wallets) ───

export async function solTransfer({ fromIndex, toAddress, sol, log = () => {} }) {
  const wallets = loadSolWallets();
  const from = wallets[fromIndex];
  if (!from) throw new Error(`wallet index ${fromIndex} not found`);
  const connection = conn();
  const fromKp = kpFromEntry(from);
  const lamports = Math.floor(sol * LAMPORTS_PER_SOL);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKp.publicKey,
      toPubkey: new PublicKey(toAddress),
      lamports,
    }),
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [fromKp]);
  log(`[SOL] transfer ${sol} SOL → ${toAddress.slice(0, 8)}… sig ${sig.slice(0, 12)}…`);
  return { signature: sig };
}

// ─── Candy Machine v3 mint (via UMI would be heavy — use manual compute) ───
// For CMv3 we shell out to `solana` CLI or use Metaplex RPC directly.
// Simplified: mpl-candy-machine rpc `mintV2` is complex; for now support
// direct mint instructions via a provided program + mint IX builder hook.

export async function solNftInfo(mintAddress) {
  const connection = conn();
  const mint = new PublicKey(mintAddress);
  const info = await connection.getParsedAccountInfo(mint);
  return info?.value?.data?.parsed ?? { raw: true, owner: info?.value?.owner?.toBase58?.() };
}

export function solWalletList(masked = true) {
  return loadSolWallets().map(w => ({
    index: w.index,
    publicKey: w.publicKey,
    ...(masked ? {} : { secretKey: w.secretKey }),
  }));
}

export function deleteSolWallet(index) {
  const wallets = loadSolWallets();
  if (index < 0 || index >= wallets.length) throw new Error('index out of range');
  const [removed] = wallets.splice(index, 1);
  saveSolWallets(wallets.map((w, i) => ({ ...w, index: i })));
  return removed;
}
