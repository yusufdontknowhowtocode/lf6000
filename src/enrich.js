// src/enrich.js
import 'dotenv/config';
import {promises as fs} from 'fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SOCIALS = (process.env.SOCIAL_SOURCES || 'facebook,instagram,x,linkedin')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const REQUEST_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 8000);
const THROTTLE_MS        = Number(process.env.SCRAPE_THROTTLE_MS || 700);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function decodeEntities(s = '') {
  // Handle &#NN; and &#xNN; and a few named entities (lightweight)
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractEmails(text = '') {
  const out = new Set();
  const source = decodeEntities(text);
  // reasonably permissive email regex (keeps + tags)
  const re = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/gi;
  let m;
  while ((m = re.exec(source))) out.add(m[0]);
  return [...out];
}

function absoluteUrl(base, href) {
  try { return new URL(href, base).toString(); }
  catch { return null; }
}

async function fetchWithTimeout(url, extra = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.9' },
      redirect: 'follow',
      signal: ctrl.signal,
      ...extra
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return { html, url: res.url };
  } finally {
    clearTimeout(t);
  }
}

function pickSocialLinks(baseUrl, html) {
  const links = [];
  const add = (u) => { const abs = absoluteUrl(baseUrl, u); if (abs) links.push(abs); };

  // grab all anchors quickly (regex is fine for this narrow task)
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (/facebook\.com\/[^?#/][^"']*/i.test(href) && SOCIALS.includes('facebook')) add(href);
    if (/(^|\/\/)instagram\.com\/[^/?#]/i.test(href) && SOCIALS.includes('instagram')) add(href);
    if (/twitter\.com\/[^/?#]/i.test(href) && SOCIALS.includes('twitter')) add(href);
    if (/(^|\/\/)x\.com\/[^/?#]/i.test(href) && SOCIALS.includes('x')) add(href);
    if (/linkedin\.com\/(company|in)\//i.test(href) && SOCIALS.includes('linkedin')) add(href);
    if (/linktr\.ee\//i.test(href)) add(href);
  }
  return [...new Set(links)];
}

function addCommonSubpages(base) {
  return [
    base,
    absoluteUrl(base, '/contact'),
    absoluteUrl(base, '/contact-us'),
    absoluteUrl(base, '/contactus'),
    absoluteUrl(base, '/about'),
    absoluteUrl(base, '/about-us'),
    absoluteUrl(base, '/privacy'),
  ].filter(Boolean);
}

function emailsFromHtml(html) {
  const found = new Set();

  // mailto links
  const mailtoRe = /href\s*=\s*["']mailto:([^"']+)["']/gi;
  let m;
  while ((m = mailtoRe.exec(html))) {
    const addr = decodeURIComponent(m[1].split('?')[0] || '');
    if (addr) found.add(addr);
  }

  // JSON-LD with "email"
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(html))) {
    const raw = decodeEntities(m[1] || '');
    try {
      const j = JSON.parse(raw);
      const stack = Array.isArray(j) ? j : [j];
      for (const obj of stack) {
        if (obj && typeof obj === 'object') {
          if (obj.email) found.add(String(obj.email));
          if (obj.contactPoint && Array.isArray(obj.contactPoint)) {
            for (const cp of obj.contactPoint) {
              if (cp.email) found.add(String(cp.email));
            }
          }
        }
      }
    } catch {}
  }

  // plain text emails
  for (const e of extractEmails(html)) found.add(e);

  return [...found];
}

async function findOnFacebook(url) {
  // Accept both http(s)://facebook.com/… and www.facebook.com/…
  if (!/facebook\.com/i.test(url)) return null;

  // Normalize to a canonical path without trailing junk we don’t need
  let base = url.replace(/(\?|#).*$/, '');
  // Try a few “about” variants that often expose emails
  const candidates = [
    base,
    base + '/about',
    base + '/about_contact_and_basic_info',
    base + '?sk=about'
  ];

  for (const u of candidates) {
    try {
      const { html } = await fetchWithTimeout(u);
      const emails = emailsFromHtml(html);
      if (emails.length) return emails[0];
    } catch {}
    await sleep(THROTTLE_MS);
  }
  return null;
}

async function findOnGenericSocial(url) {
  // Instagram/X/LinkedIn sometimes show emails in bios or mailto links,
  // but many pages are behind JS/login. We still try a lightweight fetch.
  try {
    const { html } = await fetchWithTimeout(url);
    const emails = emailsFromHtml(html);
    if (emails.length) return emails[0];
  } catch {}
  return null;
}

export async function findEmailOnSite(siteUrl) {
  if (!siteUrl) return null;

  // Normalize scheme
  try { new URL(siteUrl); } catch { siteUrl = 'https://' + String(siteUrl).replace(/^\/+/, ''); }

  // Crawl primary pages
  const queue = addCommonSubpages(siteUrl);
  const visited = new Set();
  const seenEmails = new Set();

  // First pass: site pages
  for (const url of queue) {
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      const { html } = await fetchWithTimeout(url);
      for (const e of emailsFromHtml(html)) seenEmails.add(e);
      // collect socials from homepage only
      if (url === queue[0]) {
        var socialLinks = pickSocialLinks(url, html);
      }
      if (seenEmails.size) break;
    } catch {
      // ignore fetch errors
    }
    await sleep(THROTTLE_MS);
  }
  if (seenEmails.size) return [...seenEmails][0];

  // Second pass: socials (if discovered)
  if (Array.isArray(socialLinks) && socialLinks.length) {
    // Dedup and prioritize Facebook first
    const uniq = [...new Set(socialLinks)];
    const fb = uniq.filter(u => /facebook\.com/i.test(u));
    const rest = uniq.filter(u => !/facebook\.com/i.test(u));

    for (const f of fb) {
      const got = await findOnFacebook(f);
      if (got) return got;
      await sleep(THROTTLE_MS);
    }
    for (const u of rest) {
      const got = await findOnGenericSocial(u);
      if (got) return got;
      await sleep(THROTTLE_MS);
    }
  }

  return null;
}
