// src/enrich.js
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;

export async function findEmailOnSite(website) {
  if (!website) return null;

  const urls = dedupe([
    normalize(website),
    normalize(website) + '/contact',
    normalize(website) + '/contact-us',
  ]);

  for (const u of urls) {
    try {
      const html = await fetchText(u, 6000);
      if (!html) continue;

      const emails = [...new Set((html.match(EMAIL_RE) || []).map(e => e.toLowerCase()))];
      // Prefer non-generic if possible
      const preferred = emails.find(e => !/info@|hello@|support@|admin@|noreply@/.test(e));
      if (preferred) return preferred;
      if (emails.length) return emails[0];
    } catch {
      // ignore and move on
    }
  }
  return null;
}

function normalize(u) {
  try {
    const url = new URL(u.startsWith('http') ? u : `https://${u}`);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function dedupe(arr) { return [...new Set(arr.filter(Boolean))]; }

async function fetchText(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return '';
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml\+xml/i.test(ct)) return '';
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}
// src/enrich.js (add a timeout wrapper and use it for all fetch calls)
const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 10000);

async function fetchWithTimeout(url, ms = DEFAULT_TIMEOUT_MS, init = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: {
      'user-agent': 'Mozilla/5.0 (Prospector bot; contact info@agentlyne.com)'
    }});
    return res;
  } finally {
    clearTimeout(id);
  }
}

// …wherever you had: const res = await fetch(url)
// replace with:
const res = await fetchWithTimeout(url);
