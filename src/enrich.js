// src/enrich.js
import { setTimeout as delay } from 'timers/promises';
import { URL } from 'url';

/* -------------------------------- Config -------------------------------- */

const REQUEST_TIMEOUT_MS = Number(process.env.ENRICH_TIMEOUT_MS || 10000);     // per-request soft timeout
const HARD_TIMEOUT_MS    = Number(process.env.ENRICH_HARD_TIMEOUT_MS || 15000); // overall watchdog per network op
const THROTTLE_MS        = Number(process.env.ENRICH_THROTTLE_MS || 400);
const MAX_PAGES          = Number(process.env.ENRICH_MAX_PAGES || 12);
const FETCH_SOCIALS      = String(process.env.ENRICH_SOCIALS || '1').match(/^(1|true|yes)$/i);

// Facebook fallback governors
const FB_SEARCH_ENABLED   = String(process.env.ENRICH_FB_SEARCH || '1').match(/^(1|true|yes)$/i);
const FB_SEARCH_MAX_SLUGS = Number(process.env.ENRICH_FB_SEARCH_MAX || 2);
const FB_SEARCH_TIMEOUT   = Number(process.env.ENRICH_FB_SEARCH_TIMEOUT_MS || 8000);

// Global network gate
const NET_MAX_CONCURRENCY = Number(process.env.NET_MAX_CONCURRENCY || 5);
const NET_RETRY_ATTEMPTS  = Number(process.env.NET_RETRY_ATTEMPTS  || 2);
const NET_RETRY_BASE_MS   = Number(process.env.NET_RETRY_BASE_MS   || 400);

// Safety: cap how much of a response we read (prevents huge pages from stalling)
const MAX_BYTES           = Number(process.env.ENRICH_MAX_BYTES || 1_500_000); // ~1.5MB

/* ------------------------- Network helpers (gated) ----------------------- */

let inflight = 0;
async function withNetSlot(fn){
  while (inflight >= NET_MAX_CONCURRENCY) await delay(40);
  inflight++;
  try { return await fn(); }
  finally { inflight--; }
}

// Read body with a byte cap; cancels stalled streams safely.
async function readBodyLimited(res, maxBytes = MAX_BYTES) {
  // If body is not a stream (undici always is), fallback
  const reader = res.body?.getReader?.();
  if (!reader) return await res.text();

  const chunks = [];
  let received = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) {
        received += value.length;
        if (received > maxBytes) {
          // stop reading anything else
          try { await reader.cancel(); } catch {}
          break;
        }
        chunks.push(Buffer.from(value));
      }
    }
  } catch (e) {
    // cancel on error to free socket
    try { await reader.cancel(); } catch {}
    throw e;
  }

  const buf = Buffer.concat(chunks);
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

async function fetchWithTimeoutRaw(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (ProspectorBot; +https://example.com)',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9'
      },
      ...opts
    });
    const ctype = r.headers.get('content-type') || '';
    // IMPORTANT: limit body size & time
    const html = await readBodyLimited(r, MAX_BYTES);
    return { ok: r.ok, status: r.status, url: r.url, html, contentType: ctype };
  } finally {
    clearTimeout(t);
  }
}

// Hard watchdog around the whole network op (req + body read)
async function netFetch(url, opts) {
  return withNetSlot(async () => {
    let lastErr;
    for (let i = 0; i <= NET_RETRY_ATTEMPTS; i++) {
      try {
        const result = await Promise.race([
          fetchWithTimeoutRaw(url, opts),
          (async () => { await delay(HARD_TIMEOUT_MS); throw new Error('hard_timeout'); })()
        ]);
        return result;
      } catch (e) {
        lastErr = e;
      }
      await delay(NET_RETRY_BASE_MS * Math.pow(2, i)); // exp backoff
    }
    throw lastErr;
  });
}

/* ----------------------------- Small utilities --------------------------- */

function normUrl(u) {
  if (!u) return null;
  try {
    const hasProto = /^[a-z]+:\/\//i.test(u);
    const url = new URL(hasProto ? u : `https://${u}`);
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

function absoluteUrl(base, href) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

/* -------------------------- Email extraction bits ------------------------ */

function uniqLower(arr) { return [...new Set(arr.map(s => s.toLowerCase()))]; }

function extractEmails(text = '') {
  const re = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24})/gi;
  const out = new Set();
  let m; while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}

function emailsFromJsonLd(html = '') {
  const out = new Set();
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const blk of blocks) {
    const body = blk.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    try {
      const data = JSON.parse(body);
      const stack = [data];
      while (stack.length) {
        const v = stack.pop();
        if (v == null) continue;
        if (typeof v === 'string') {
          extractEmails(v).forEach(e => out.add(e));
        } else if (Array.isArray(v)) {
          v.forEach(x => stack.push(x));
        } else if (typeof v === 'object') {
          for (const k of Object.keys(v)) stack.push(v[k]);
          if (typeof v.email === 'string') extractEmails(v.email).forEach(e => out.add(e));
        }
      }
    } catch {}
  }
  return [...out];
}

// Cloudflare obfuscation
function decodeCfEmail(cfStr) {
  try {
    const r = parseInt(cfStr.slice(0, 2), 16);
    let out = '';
    for (let n = 2; n < cfStr.length; n += 2) {
      const i = parseInt(cfStr.substr(n, 2), 16) ^ r;
      out += String.fromCharCode(i);
    }
    return out;
  } catch { return null; }
}
function emailsFromCloudflare(html = '') {
  const out = new Set();
  const re = /data-cfemail=["']([0-9a-fA-F]+)["']/g;
  let m; while ((m = re.exec(html))) {
    const e = decodeCfEmail(m[1]);
    if (e) out.add(e);
  }
  return [...out];
}

// Obfuscated formats: name [at] domain [dot] com, etc.
function extractObfuscated(text = '') {
  const s = text.replace(/\u200B|\u200C|\u200D/g, ''); // strip zero-width
  const out = new Set();

  const re1 = /([A-Z0-9._%+-]+)\s*(?:\(|\[)?\s*at\s*(?:\)|\])?\s*([A-Z0-9.-]+)\s*(?:\(|\[)?\s*dot\s*(?:\)|\])?\s*([A-Z]{2,24})/gi;
  let m1; while ((m1 = re1.exec(s))) out.add(`${m1[1]}@${m1[2]}.${m1[3]}`);

  const re2 = /([A-Z0-9._%+-]+)\s*\(?\s*@\s*\)?\s*([A-Z0-9.-]+)\s*\.\s*([A-Z]{2,24})/gi;
  let m2; while ((m2 = re2.exec(s))) out.add(`${m2[1]}@${m2[2]}.${m2[3]}`);

  return [...out].map(s => s.toLowerCase());
}

function pickLikelyPages(baseUrl, html = '') {
  const out = new Set();
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gsi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = (m[2] || '').toLowerCase();
    const abs = absoluteUrl(baseUrl, href);
    if (!abs) continue;
    if (
      /contact|about|team|staff|support|help|privacy|legal|impressum|terms|policy|connect|locations?/i.test(href) ||
      /contact|about|team|staff|support|help|privacy|legal|impressum|terms|policy/i.test(text)
    ) out.add(abs);
  }
  return [...out].slice(0, 8);
}

function pickDocLinks(baseUrl, html = '') {
  const out = new Set();
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (/\.(pdf|vcf|vcard)$/i.test(href) || /privacy|terms|impressum|legal/i.test(href)) {
      const abs = absoluteUrl(baseUrl, href);
      if (abs) out.add(abs);
    }
  }
  return [...out].slice(0, 6);
}

async function tryWellKnown(base) {
  for (const p of ['/ .well-known/security.txt', '/humans.txt'].map(s => s.replace(' ', ''))) {
    try {
      const r = await netFetch(absoluteUrl(base, p));
      if (r.ok) {
        const emails = [
          ...extractEmails(r.html),
          ...extractObfuscated(r.html)
        ];
        if (emails.length) return emails;
      }
    } catch {}
  }
  return [];
}

/* ------------------------------ Sitemaps --------------------------------- */

async function discoverSitemaps(baseUrl) {
  const urls = new Set();
  for (const u of [absoluteUrl(baseUrl, '/robots.txt'), absoluteUrl(baseUrl, '/sitemap.xml')]) {
    try {
      const r = await netFetch(u);
      if (!r.ok) continue;
      if (/robots\.txt/i.test(r.url)) {
        const m = r.html.match(/^\s*Sitemap:\s*(\S+)/gim) || [];
        m.forEach(line => urls.add(line.split(/\s+/).pop()));
      } else {
        urls.add(r.url);
      }
    } catch {}
  }
  return [...urls];
}

function extractUrlsFromSitemap(xml = '') {
  const out = new Set();
  const locRe = /<loc>([^<]+)<\/loc>/gi;
  let m; while ((m = locRe.exec(xml))) out.add(m[1]);
  return [...out];
}

/* ------------------------------- Socials --------------------------------- */

const SOCIAL_DOMAINS = [
  'facebook.com', 'm.facebook.com', 'mbasic.facebook.com',
  'instagram.com',
  'x.com', 'twitter.com',
  'linkedin.com'
];

function socialLinks(baseUrl, html = '') {
  const out = new Set();
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const abs = absoluteUrl(baseUrl, href);
    if (!abs) continue;
    try {
      const u = new URL(abs);
      if (SOCIAL_DOMAINS.some(d => u.hostname.endsWith(d))) out.add(abs);
    } catch {}
  }
  return [...out].slice(0, 6);
}

function toFacebookAbout(urlOrSlug = '') {
  try {
    const u = new URL(urlOrSlug);
    if (!u.hostname.includes('facebook.com')) return null;
    const parts = u.pathname.replace(/^\/+/, '').split(/[/?#]/);
    const slug = parts[0] || '';
    if (!slug) return null;
    return `https://mbasic.facebook.com/${slug}/about`;
  } catch {
    const slug = String(urlOrSlug).replace(/^\/+/, '').split(/[/?#]/)[0];
    return slug ? `https://mbasic.facebook.com/${slug}/about` : null;
  }
}

async function emailsFromFacebook(urlOrSlug) {
  const aboutUrl = toFacebookAbout(urlOrSlug);
  if (!aboutUrl) return [];
  try {
    const r = await netFetch(aboutUrl, { });
    if (!r.ok) return [];
    return uniqLower([
      ...extractEmails(r.html),
      ...extractObfuscated(r.html)
    ]);
  } catch { return []; }
}

async function facebookSearchSlugs(query) {
  const q = encodeURIComponent(query.trim());
  const url = `https://mbasic.facebook.com/search/?search=${q}`;
  try {
    const r = await netFetch(url, { });
    if (!r.ok) return [];
    const out = new Set();
    const re = /href="\/([A-Za-z0-9._-]{3,})\/(?!photos|videos|posts|groups|marketplace)[^"]*"/gi;
    let m; while ((m = re.exec(r.html))) out.add(m[1]);
    return [...out].slice(0, FB_SEARCH_MAX_SLUGS);
  } catch { return []; }
}

/* -------------------------- Email scoring logic -------------------------- */

function bestEmailForDomain(candidates, siteHost) {
  if (!candidates.length) return null;
  const host = (siteHost || '').toLowerCase();

  function score(e) {
    const [, domain] = e.split('@');
    let s = 0;
    if (domain === host) s += 50;
    if (domain.endsWith('.' + host)) s += 40;
    if (/^(info|contact|hello|office|support|sales|bookings|admin|team|service|hi)\@/i.test(e)) s += 8;
    if (/(gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|aol\.com)$/i.test(domain)) s -= 20;
    s -= Math.max(0, e.length - 24) * 0.1;
    return s;
  }

  return [...candidates].sort((a, b) => score(b) - score(a))[0];
}

/* ---------------------------- Public main API ---------------------------- */

const sessionCache = new Map(); // domain -> email

/**
 * @param {string} site Website URL (or any URL from the business)
 * @param {{name?: string, city?: string, state?: string}} hints Optional hints for social search
 */
export async function findEmailOnSite(site, hints = {}) {
  const siteUrl = normUrl(site);

  if (!siteUrl) {
    if (FETCH_SOCIALS && FB_SEARCH_ENABLED && hints?.name) {
      const q = [hints.name, hints.city, hints.state].filter(Boolean).join(' ');
      const slugs = await facebookSearchSlugs(q);
      for (const slug of slugs) {
        const emails = await emailsFromFacebook(slug);
        if (emails.length) return emails[0];
        await delay(THROTTLE_MS);
      }
    }
    return null;
  }

  const siteHost = new URL(siteUrl).hostname;
  if (sessionCache.has(siteHost)) return sessionCache.get(siteHost);

  const seen = new Set();
  const visited = new Set();

  // 1) Homepage
  try {
    const r = await netFetch(siteUrl);
    if (r.ok) {
      visited.add(r.url);
      const html = r.html;

      for (const e of [
        ...extractEmails(html),
        ...emailsFromJsonLd(html),
        ...extractObfuscated(html),
        ...emailsFromCloudflare(html)
      ]) seen.add(e);

      // likely pages
      const candidates = pickLikelyPages(r.url, html);
      for (const u of candidates) {
        if (visited.size > MAX_PAGES) break;
        try {
          const r2 = await netFetch(u);
          if (!r2.ok) continue;
          visited.add(r2.url);
          for (const e of [
            ...extractEmails(r2.html),
            ...emailsFromJsonLd(r2.html),
            ...extractObfuscated(r2.html),
            ...emailsFromCloudflare(r2.html)
          ]) seen.add(e);
          if (seen.size) break;
          await delay(THROTTLE_MS);
        } catch {}
      }

      // docs
      if (!seen.size) {
        const docs = pickDocLinks(r.url, html);
        for (const durl of docs) {
          if (visited.size > MAX_PAGES) break;
          try {
            const r3 = await netFetch(durl);
            if (!r3.ok) continue;
            visited.add(r3.url);
            for (const e of [
              ...extractEmails(r3.html),
              ...extractObfuscated(r3.html)
            ]) seen.add(e);
            if (seen.size) break;
            await delay(THROTTLE_MS);
          } catch {}
        }
      }

      // socials (Facebook special-cased)
      if (FETCH_SOCIALS && !seen.size) {
        const socials = socialLinks(r.url, html);

        // Facebook About first (fastest signal)
        const fbLinks = socials.filter(u => /facebook\.com/i.test(u));
        for (const fb of fbLinks) {
          const fbEmails = await emailsFromFacebook(fb);
          fbEmails.forEach(e => seen.add(e));
          if (seen.size) break;
          await delay(THROTTLE_MS);
        }

        // Light fetch others
        if (!seen.size) {
          for (const sUrl of socials) {
            if (visited.size > MAX_PAGES) break;
            try {
              const r4 = await netFetch(sUrl);
              if (!r4.ok) continue;
              visited.add(r4.url);
              for (const e of [
                ...extractEmails(r4.html),
                ...extractObfuscated(r4.html)
              ]) seen.add(e);
              if (seen.size) break;
              await delay(THROTTLE_MS);
            } catch {}
          }
        }
      }
    }
  } catch {}

  // 2) Well-known files
  if (!seen.size) {
    try { (await tryWellKnown(siteUrl)).forEach(e => seen.add(e)); } catch {}
  }

  // 3) Sitemaps (capped)
  if (!seen.size) {
    try {
      const maps = await discoverSitemaps(siteUrl);
      let fetched = 0;
      for (const mapUrl of maps) {
        if (fetched > MAX_PAGES) break;
        const sm = await netFetch(mapUrl);
        if (!sm.ok) continue;
        const urls = extractUrlsFromSitemap(sm.html).slice(0, 25);
        for (const u of urls) {
          if (visited.has(u)) continue;
          if (fetched++ > MAX_PAGES) break;
          try {
            const r = await netFetch(u);
            if (!r.ok) continue;
            visited.add(r.url);
            for (const e of [
              ...extractEmails(r.html),
              ...emailsFromJsonLd(r.html),
              ...extractObfuscated(r.html),
              ...emailsFromCloudflare(r.html)
            ]) seen.add(e);
            if (seen.size) break;
            await delay(THROTTLE_MS);
          } catch {}
        }
        if (seen.size) break;
      }
    } catch {}
  }

  // 4) FB name search fallback
  if (FETCH_SOCIALS && FB_SEARCH_ENABLED && !seen.size && hints?.name) {
    const q = [hints.name, hints.city, hints.state].filter(Boolean).join(' ');
    const slugs = await facebookSearchSlugs(q);
    for (const slug of slugs) {
      const emails = await emailsFromFacebook(slug);
      emails.forEach(e => seen.add(e));
      if (seen.size) break;
      await delay(THROTTLE_MS);
    }
  }

  const uniq = uniqLower([...seen]);
  const best = bestEmailForDomain(uniq, siteHost) || uniq[0] || null;
  sessionCache.set(siteHost, best || null);
  return best;
}
