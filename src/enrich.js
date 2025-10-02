// src/enrich.js
import { setTimeout as delay } from 'timers/promises';
import { URL } from 'url';

/* -------------------------------- Config -------------------------------- */

const REQUEST_TIMEOUT_MS = Number(process.env.ENRICH_TIMEOUT_MS || 10000);
const THROTTLE_MS        = Number(process.env.ENRICH_THROTTLE_MS || 400);
const MAX_PAGES          = Number(process.env.ENRICH_MAX_PAGES || 12);  // sitemap/pages cap
const FETCH_SOCIALS      = String(process.env.ENRICH_SOCIALS || '1').match(/^(1|true|yes)$/i);

/* ----------------------------- Small utilities --------------------------- */

function normUrl(u) {
  if (!u) return null;
  try {
    // add protocol if missing
    const hasProto = /^[a-z]+:\/\//i.test(u);
    const url = new URL(hasProto ? u : `https://${u}`);
    // drop fragments
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

function absoluteUrl(base, href) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (ProspectorBot; +https://example.com)',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      ...opts
    });
    const ctype = r.headers.get('content-type') || '';
    const txt = await r.text();
    return { ok: r.ok, status: r.status, url: r.url, html: txt, contentType: ctype };
  } finally {
    clearTimeout(t);
  }
}

/* -------------------------- Email extraction bits ------------------------ */

function uniqLower(arr) { return [...new Set(arr.map(s => s.toLowerCase()))]; }

function extractEmails(text = '') {
  // basic email (no internationalized domain here)
  const re = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24})/gi;
  const out = new Set();
  let m; while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}

// Cloudflare __cf_email__ decoder
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

  // name [at] domain [dot] tld  OR name(at)domain(dot)tld
  const re1 = /([A-Z0-9._%+-]+)\s*(?:\(|\[)?\s*at\s*(?:\)|\])?\s*([A-Z0-9.-]+)\s*(?:\(|\[)?\s*dot\s*(?:\)|\])?\s*([A-Z]{2,24})/gi;
  let m1; while ((m1 = re1.exec(s))) out.add(`${m1[1]}@${m1[2]}.${m1[3]}`);

  // name @ domain . tld with spaces
  const re2 = /([A-Z0-9._%+-]+)\s*\(?\s*@\s*\)?\s*([A-Z0-9.-]+)\s*\.\s*([A-Z]{2,24})/gi;
  let m2; while ((m2 = re2.exec(s))) out.add(`${m2[1]}@${m2[2]}.${m2[3]}`);

  return [...out].map(s => s.toLowerCase());
}

function pickLikelyPages(baseUrl, html = '') {
  // Extract a few candidate links: contact, about, team, privacy, legal, impressum
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
      const r = await fetchWithTimeout(absoluteUrl(base, p));
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
      const r = await fetchWithTimeout(u);
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
  'facebook.com', 'm.facebook.com',
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
  return [...out].slice(0, 4);
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

    // role accounts
    if (/^(info|contact|hello|office|support|sales|bookings|admin|team|service|hi)\@/i.test(e)) s += 8;

    // deprioritize free webmail
    if (/(gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|aol\.com)$/i.test(domain)) s -= 20;

    // shorter is cleaner
    s -= Math.max(0, e.length - 24) * 0.1;
    return s;
  }

  return [...candidates].sort((a, b) => score(b) - score(a))[0];
}

/* ---------------------------- Public main API ---------------------------- */

const sessionCache = new Map(); // domain -> email (memory per process)

export async function findEmailOnSite(site) {
  const siteUrl = normUrl(site);
  if (!siteUrl) return null;

  const siteHost = new URL(siteUrl).hostname;
  if (sessionCache.has(siteHost)) return sessionCache.get(siteHost);

  const seen = new Set(); // emails found
  const visited = new Set(); // urls fetched

  // 1) Homepage
  try {
    const r = await fetchWithTimeout(siteUrl);
    if (r.ok) {
      visited.add(r.url);
      const html = r.html;

      // direct mailto + visible/plain/JSON-LD + obfuscated + CF protected
      for (const e of [
        ...extractEmails(html),
        ...extractObfuscated(html),
        ...emailsFromCloudflare(html)
      ]) seen.add(e);

      // likely pages
      const candidates = pickLikelyPages(r.url, html);
      for (const u of candidates) {
        if (visited.size > MAX_PAGES) break;
        try {
          const r2 = await fetchWithTimeout(u);
          if (!r2.ok) continue;
          visited.add(r2.url);
          for (const e of [
            ...extractEmails(r2.html),
            ...extractObfuscated(r2.html),
            ...emailsFromCloudflare(r2.html)
          ]) seen.add(e);
          if (seen.size) break;
          await delay(THROTTLE_MS);
        } catch {}
      }

      // docs (pdf/vcf/policies)
      if (!seen.size) {
        const docs = pickDocLinks(r.url, html);
        for (const durl of docs) {
          if (visited.size > MAX_PAGES) break;
          try {
            const r3 = await fetchWithTimeout(durl);
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

      // socials (light)
      if (FETCH_SOCIALS && !seen.size) {
        const socials = socialLinks(r.url, html);
        for (const sUrl of socials) {
          if (visited.size > MAX_PAGES) break;
          try {
            const r4 = await fetchWithTimeout(sUrl);
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
  } catch {}

  // 2) well-known files
  if (!seen.size) {
    try {
      const found = await tryWellKnown(siteUrl);
      found.forEach(e => seen.add(e));
    } catch {}
  }

  // 3) Sitemaps (last resort, capped)
  if (!seen.size) {
    try {
      const maps = await discoverSitemaps(siteUrl);
      let fetched = 0;
      for (const mapUrl of maps) {
        if (fetched > MAX_PAGES) break;
        const sm = await fetchWithTimeout(mapUrl);
        if (!sm.ok) continue;
        const urls = extractUrlsFromSitemap(sm.html).slice(0, 25);
        for (const u of urls) {
          if (visited.has(u)) continue;
          if (fetched++ > MAX_PAGES) break;
          try {
            const r = await fetchWithTimeout(u);
            if (!r.ok) continue;
            visited.add(r.url);
            for (const e of [
              ...extractEmails(r.html),
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

  const uniq = uniqLower([...seen]);
  const best = bestEmailForDomain(uniq, siteHost) || uniq[0] || null;
  sessionCache.set(siteHost, best || null);
  return best;
}
