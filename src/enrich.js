// src/enrich.js
import 'dotenv/config';

const TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 10000);

/** fetch with AbortController timeout */
function fetchWithTimeout(resource, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(resource, { ...opts, signal: controller.signal, redirect: 'follow' })
    .finally(() => clearTimeout(id));
}

/** normalize a site string to an absolute https URL */
function normalizeUrl(site) {
  if (!site) return null;
  let s = String(site).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  return s;
}

/**
 * Try to find an email address on the site's homepage.
 * Returns the first email found (string) or null.
 */
export async function findEmailOnSite(site) {
  const url = normalizeUrl(site);
  if (!url) return null;

  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const html = await res.text();

    // Prefer mailto: addresses
    const m1 = html.match(/mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
    if (m1) return m1[1];

    // Fall back to raw emails in the page
    const m2 = html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m2 ? m2[0] : null;
  } catch {
    // timeout / network / abort -> just skip
    return null;
  }
}
