/**
 * CAPTCHA Solver — unified multi-provider
 *
 * Providers (priority order, first configured wins; fallback chain):
 *   2captcha  — TWOCAPTCHA_API_KEY    (image/recaptcha2/3/hcaptcha/turnstile)
 *   capsolver — CAPSOLVER_API_KEY     (recaptcha/hcaptcha/turnstile, faster)
 *
 * Usage:
 *   const id  = await submit({ type: 'turnstile', sitekey, pageurl });
 *   const tok = await poll(id, { provider });
 */

const API2 = 'https://2captcha.com/in.php';
const API2_RES = 'https://2captcha.com/res.php';
const CAPS = 'https://api.capsolver.com';

function providers() {
  const list = [];
  if (process.env.CAPSOLVER_API_KEY) list.push('capsolver');
  if (process.env.TWOCAPTCHA_API_KEY) list.push('2captcha');
  return list;
}

export function captchaStatus() {
  return { providers: providers(), ready: providers().length > 0 };
}

// ─── 2captcha ───

async function submit2(type, data) {
  const key = process.env.TWOCAPTCHA_API_KEY;
  const params = new URLSearchParams({ key, json: 1 });
  if (type === 'image') {
    params.set('method', 'base64');
    params.set('body', data.imageBase64);
  } else {
    params.set('method', type === 'recaptcha2' ? 'userrecaptcha' : type);
    params.set('googlekey', data.sitekey);
    params.set('pageurl', data.pageurl);
    if (type === 'recaptcha3') { params.set('version', 'v3'); params.set('action', data.action || 'verify'); params.set('min_score', String(data.minScore || 0.3)); }
    if (data.action && type !== 'recaptcha3') params.set('action', data.action);
    if (data.proxy) { params.set('proxy', data.proxy); params.set('proxytype', data.proxyType || 'HTTP'); }
  }
  const r = await fetch(API2, { method: 'POST', body: params });
  const j = await r.json();
  if (j.status !== 1) throw new Error(`2captcha submit: ${j.request}`);
  return j.request;
}

async function poll2(id, { timeoutMs = 120000 } = {}) {
  const key = process.env.TWOCAPTCHA_API_KEY;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 5000));
    const r = await fetch(`${API2_RES}?key=${key}&action=get&json=1&id=${id}`);
    const j = await r.json();
    if (j.status === 1) return j.request;
    if (j.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha: ${j.request}`);
  }
  throw new Error('2captcha timeout');
}

// ─── capsolver ───

async function submitCaps(type, data) {
  const key = process.env.CAPSOLVER_API_KEY;
  const types = {
    recaptcha2: 'ReCaptchaV2TaskProxyLess',
    recaptcha3: 'ReCaptchaV3TaskProxyLess',
    hcaptcha: 'HCaptchaTaskProxyLess',
    turnstile: 'AntiTurnstileTaskProxyLess',
  };
  const body = {
    clientKey: key,
    task: {
      type: types[type],
      websiteURL: data.pageurl,
      websiteKey: data.sitekey,
      ...(type === 'recaptcha3' ? { pageAction: data.action || 'verify', minScore: data.minScore || 0.3 } : {}),
    },
  };
  const r = await fetch(`${CAPS}/createTask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.errorId) throw new Error(`capsolver: ${j.errorDescription || j.errorCode}`);
  return j.taskId;
}

async function pollCaps(id, { timeoutMs = 120000 } = {}) {
  const key = process.env.CAPSOLVER_API_KEY;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await fetch(`${CAPS}/getTaskResult`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: key, taskId: id }),
    });
    const j = await r.json();
    if (j.status === 'ready') return j.solution?.token || j.solution?.gRecaptchaResponse;
    if (j.errorId) throw new Error(`capsolver: ${j.errorDescription || j.errorCode}`);
  }
  throw new Error('capsolver timeout');
}

// ─── Unified API ───

/**
 * Solve a captcha end-to-end. Tries configured providers in order.
 * type: image | recaptcha2 | recaptcha3 | hcaptcha | turnstile
 */
export async function solveCaptcha({ type = 'recaptcha2', provider, ...data }, { timeoutMs = 120000, log = () => {} } = {}) {
  const chain = provider ? [provider] : providers();
  if (!chain.length) throw new Error('no captcha provider configured — set CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY in .env');
  let lastErr;
  for (const p of chain) {
    try {
      log(`[CAPTCHA] submitting ${type} via ${p}…`);
      const id = p === '2captcha' ? await submit2(type, data) : await submitCaps(type, data);
      const token = p === '2captcha' ? await poll2(id, { timeoutMs }) : await pollCaps(id, { timeoutMs });
      log(`[CAPTCHA] solved via ${p}: ${String(token).slice(0, 20)}…`);
      return { provider: p, token };
    } catch (e) {
      lastErr = e;
      log(`[CAPTCHA] ${p} failed: ${e.message}`);
    }
  }
  throw lastErr || new Error('captcha solve failed');
}
