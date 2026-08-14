/**
 * Drop Page Checker — fetch + parse mint pages for status/WL detection
 *
 * Lighter than full browser automation: curl-cffi-style fetch with
 * browser headers, then pattern-match the HTML/JSON for drop phase,
 * price, and WL indicators. Falls back gracefully when pages are JS-only
 * (reports needsBrowser: true so the operator can open it in the panel).
 */

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

export async function checkDropPage(url, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { headers: BROWSER_HEADERS, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    const html = await r.text();
    const ms = Date.now() - t0;

    const signals = {
      url: r.url, status: r.status, latencyMs: ms, bytes: html.length,
      needsBrowser: false,
      // pattern extraction
      soldOut: /sold\s?out|soldout/i.test(html),
      live: /mint(?:ing)?\s?(?:is\s)?(?:now|live|open)|live\s?now/i.test(html),
      upcoming: /coming\s?soon|upcoming|not\s?yet/i.test(html),
      allowlist: /allowlist|whitelist|\bwl\b|allow[- ]?list/i.test(html),
      price: extractPrice(html),
      phase: extractPhase(html),
      // embedded JSON state (next.js/remix data)
      hasJsonState: /__NEXT_DATA__|window\.__remixContext|__NUXT__/i.test(html),
    };
    if (signals.hasJsonState && !signals.soldOut && !signals.live && !signals.upcoming) {
      signals.needsBrowser = true; // JS-rendered page we can't parse statically
    }
    return signals;
  } catch (e) {
    return { url, error: String(e.message).slice(0, 150), latencyMs: Date.now() - t0 };
  }
}

function extractPrice(html) {
  // common patterns: "0.05 ETH", "0.05Ξ", "5 SOL", price in JSON
  const m = html.match(/"price"\s*:\s*"?([\d.]+)\s?(ETH|SOL|MATIC|ETH)"?/i)
    || html.match(/([\d.]+)\s?(?:ETH|Ξ)/i)
    || html.match(/([\d.]+)\s?SOL/i);
  return m ? `${m[1]} ${m[2] || ''}`.trim() : null;
}

function extractPhase(html) {
  const m = html.match(/(?:phase|stage)["'\s:]{1,4}(public|allowlist|whitelist|presale|waitlist|open|closed)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Watch mode: poll a drop page until a condition flips.
 * Returns an abort handle.
 */
export function watchDropPage(url, { intervalMs = 30000, until = (s) => s.live || s.soldOut, onUpdate } = {}) {
  const stop = { cancelled: false };
  (async () => {
    while (!stop.cancelled) {
      const s = await checkDropPage(url);
      onUpdate?.(s);
      if (until(s)) { stop.flipped = true; break; }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  })();
  return stop;
}
