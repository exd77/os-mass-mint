/**
 * Webhook Notifier — Discord + Telegram
 *
 * Config in .env:
 *   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
 *   TELEGRAM_BOT_TOKEN=123456:ABC...
 *   TELEGRAM_CHAT_ID=-100123456789
 *
 * Usage:
 *   import { notify, notifyMint } from './webhook.js';
 *   notify('mass mint done', { detail: '18/20 ok' });
 */

import 'dotenv/config';

const DISCORD_URL = process.env.DISCORD_WEBHOOK_URL || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

// ─── Fire and forget (never throw) ───

export async function notify(title, fields = {}) {
  const tasks = [];
  if (DISCORD_URL) tasks.push(sendDiscord(title, fields));
  if (TG_TOKEN && TG_CHAT) tasks.push(sendTelegram(title, fields));
  await Promise.allSettled(tasks);
}

export async function notifyMint(event) {
  // event: { type: 'mint'|'mass-mint'|'sweep', status, wallet, chain, contract, tokenIds, txHash, explorer, error, duration }
  const icon = event.status === 'success' ? '[OK]' : '[FAIL]';
  const title = `${icon} ${event.type || 'mint'} ${event.status}`;
  const fields = { ...event, icon: undefined };
  await notify(title, fields);
}

// ─── Discord ───

async function sendDiscord(title, fields) {
  const body = {
    username: 'rusminter',
    embeds: [{
      title: title.slice(0, 256),
      color: String(fields.status).includes('success') || String(fields.status) === 'success' ? 0x22c55e : (String(fields.status).includes('fail') || String(fields.status) === 'error' ? 0xef4444 : 0x111111),
      fields: buildFields(fields),
      footer: { text: `rusminter · ${new Date().toISOString().slice(0, 19).replace('T', ' ')}` },
      timestamp: new Date().toISOString(),
    }],
  };
  const r = await fetch(DISCORD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error(`[webhook] discord ${r.status}`);
  return r.status;
}

function buildFields(fields) {
  const out = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || k === 'icon') continue;
    let val = String(v);
    if (val.length > 1024) val = val.slice(0, 1021) + '...';
    out.push({ name: k.slice(0, 256), value: val.slice(0, 1024) || '-', inline: val.length < 32 });
  }
  return out.slice(0, 25); // Discord limit
}

// ─── Telegram ───

async function sendTelegram(title, fields) {
  const lines = [`<b>${escapeHtml(title)}</b>`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || k === 'icon') continue;
    lines.push(`<code>${escapeHtml(k)}</code>: ${escapeHtml(String(v).slice(0, 500))}`);
  }
  const text = lines.join('\n').slice(0, 4000);
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!r.ok) console.error(`[webhook] telegram ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Test ───

export async function testWebhooks() {
  const results = {};
  if (DISCORD_URL) {
    try {
      const status = await sendDiscord('rusminter — webhook test', { status: 'success', note: 'webhook configured correctly' });
      results.discord = { configured: true, status };
    } catch (e) {
      results.discord = { configured: true, error: e.message };
    }
  } else {
    results.discord = { configured: false };
  }
  if (TG_TOKEN && TG_CHAT) {
    try {
      const status = await sendTelegram('rusminter — webhook test', { status: 'success', note: 'webhook configured correctly' });
      results.telegram = { configured: true, status };
    } catch (e) {
      results.telegram = { configured: true, error: e.message };
    }
  } else {
    results.telegram = { configured: false };
  }
  return results;
}

export function webhookStatus() {
  return {
    discord: !!DISCORD_URL,
    telegram: !!(TG_TOKEN && TG_CHAT),
  };
}
