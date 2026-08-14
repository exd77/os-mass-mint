/**
 * Social Module — mint announcements
 *
 * X (Twitter): via xurl CLI (installed at ~/tweets/ or PATH)
 *   Env: XURL_POST_ACCT — account name configured in xurl
 * Telegram: reuse TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from webhook module
 *
 * Templates: mint success, flash fire result, rarity hit
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execFile);

// ─── X via xurl ───

async function xurlPost(text) {
  const acct = process.env.XURL_POST_ACCT;
  const args = acct ? ['--acct', acct, 'post', text] : ['post', text];
  try {
    const { stdout } = await exec('xurl', args, { timeout: 30000 });
    return { ok: true, raw: stdout.trim().slice(0, 200) };
  } catch (e) {
    // try full path fallback
    try {
      const { stdout } = await exec('/root/.local/bin/xurl', args, { timeout: 30000 });
      return { ok: true, raw: stdout.trim().slice(0, 200) };
    } catch (e2) {
      throw new Error(`xurl: ${String(e2.stderr || e2.message).slice(0, 150)}`);
    }
  }
}

// ─── Telegram ───

async function tgPost(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('telegram not configured');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}`);
  return { ok: true };
}

// ─── Templates ───

export function mintAnnounce({ chain, contract, tokenIds, wallet, txHash, rarity }) {
  const lines = [
    `minted ${tokenIds.length} on ${chain}`,
    `collection: ${contract}`,
    `tokens: ${tokenIds.map(t => '#' + t).join(' ')}`,
  ];
  if (rarity) lines.push(`best rarity: rank ${rarity.rank} score ${rarity.score}`);
  if (wallet) lines.push(`wallet: ${wallet.slice(0, 10)}…`);
  if (txHash) lines.push(`tx: ${txHash}`);
  return lines.join('\n');
}

// ─── Unified announce ───

export async function announce({ text, targets = ['telegram'] }, log = () => {}) {
  const results = {};
  for (const t of targets) {
    try {
      if (t === 'x') results.x = await xurlPost(text);
      else if (t === 'telegram') results.telegram = await tgPost(text);
      else results[t] = { error: 'unknown target' };
      log(`[SOCIAL] ${t} ok`);
    } catch (e) {
      results[t] = { error: e.message };
      log(`[SOCIAL] ${t} fail: ${e.message}`);
    }
  }
  return results;
}

export function socialStatus() {
  return {
    x: Boolean(process.env.XURL_POST_ACCT),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  };
}
