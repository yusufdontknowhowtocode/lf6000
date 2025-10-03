// src/mailer.js
import 'dotenv/config';
import nodemailer from 'nodemailer';

/* ============================== Config =============================== */

const BRAND      = process.env.SENDER_BRAND || 'Agentlyne';
const FROM_ADDR  = (process.env.EMAIL_USER || 'info@agentlyne.com').trim();
const FROM_EMAIL = `${BRAND} <${FROM_ADDR}>`;
const REPLY_TO   = (process.env.REPLY_TO || FROM_ADDR).trim();
const BCC_TO     = (process.env.BCC_TO || '').trim();

const MG_USER   = (process.env.MAILGUN_SMTP_USER || '').trim();   // e.g. postmaster@mg.example.com
const MG_PASS   = (process.env.MAILGUN_SMTP_PASS || '').trim();
const MG_REGION = (process.env.MAILGUN_REGION || '').trim().toLowerCase(); // 'eu' for EU region
const SMTP_HOST_DEFAULT = MG_REGION === 'eu' ? 'smtp.eu.mailgun.org' : 'smtp.mailgun.org';

// Allow overrides via generic SMTP_* (works with any SMTP, not just Mailgun)
const host   = process.env.SMTP_HOST || SMTP_HOST_DEFAULT;
const port   = Number(process.env.SMTP_PORT || 587);
const secure = /^(1|true|yes|on)$/i.test(String(process.env.SMTP_SECURE || 'false'));
const user   = process.env.SMTP_USER || MG_USER;
const pass   = process.env.SMTP_PASS || MG_PASS;

const DEBUG_MODE = !!(process.env.DEBUG_EMAIL && process.env.DEBUG_EMAIL !== '0');
const MIN_INTERVAL_MS = Number(process.env.MAILER_MIN_INTERVAL_MS || 150); // soft throttle
const MAX_RETRIES     = Number(process.env.MAILER_MAX_RETRIES || 3);

/** Optional default templates used by sendProspectEmail (placeholders in {braces}). */
const DEFAULT_SUBJECT = process.env.PROSPECT_SUBJECT || 'Quick question about {business}';
const DEFAULT_BODY =
  process.env.PROSPECT_BODY ||
  `Hi {business},

We plug in a 24/7 AI receptionist that answers, qualifies, and books—so missed calls become booked jobs (not lost revenue).

Typical lift: +15–35% more booked appointments in 2–3 weeks.
Free demo + details: {yourSite}

Worth a quick look?

– {brand} Sales Team
`;

/* ============================== Transport ============================ */

if (!user || !pass) {
  console.warn('[mailer] Missing SMTP credentials. Set MAILGUN_SMTP_USER/MAILGUN_SMTP_PASS or SMTP_USER/SMTP_PASS.');
}

export const transporter = nodemailer.createTransport({
  host, port, secure,
  auth: { user, pass },
  pool: true,
  tls: { minVersion: 'TLSv1.2' },
  logger: !!process.env.DEBUG_EMAIL,
  debug:  !!process.env.DEBUG_EMAIL
});

// Verify once on boot
(async () => {
  try {
    await transporter.verify();
    console.log(`[mailer] SMTP ready (${host}:${port}) as ${user}`);
  } catch (e) {
    console.error('[mailer] SMTP verify FAILED:', e?.message || e);
  }
})();

/* ============================== Helpers ============================== */

let lastSendTs = 0;
async function throttle() {
  const now = Date.now();
  const wait = lastSendTs + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSendTs = Date.now();
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function transientSmtp(err) {
  const msg = `${err?.message || ''}`.toLowerCase();
  // Common transient patterns / codes
  return (
    /timeout|timed out|connection closed|connection reset|rate.?limit|too many|temporarily unavailable/.test(msg) ||
    /\b(421|450|451|452|454|458|459|471|500|502|503|504)\b/.test(msg)   // include some 5xx that are safe to retry
  );
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function fill(template, ctx = {}) {
  return String(template).replace(/\{([a-z0-9_]+)\}/gi, (_, k) => {
    const v = ctx[k] ?? '';
    return v == null ? '' : String(v);
  });
}

/* ============================== Core APIs ============================ */

/**
 * Low-level send. Backwards compatible with your previous signature.
 * @param {string} to
 * @param {string} subject
 * @param {string} text
 * @param {object} opts { html?, headers? }
 * @returns {Promise<{id:string,accepted:string[],rejected:string[]}>}
 */
export async function sendEmail(to, subject, text, opts = {}) {
  if (!to) throw new Error('Missing "to"');

  await throttle();

  // Debug mode: redirect all mail to yourself but keep original in headers
  const finalTo = DEBUG_MODE ? FROM_ADDR : to;

  const html =
    opts.html ??
    `<pre style="font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif">${escapeHtml(text || '')}</pre>`;

  const headers = {
    'X-Mailer-App': 'lead-finder-6000',
    'List-Unsubscribe': `<mailto:unsubscribe@${(FROM_ADDR.split('@')[1] || 'agentlyne.com')}?subject=unsubscribe>`,
    ...(DEBUG_MODE ? { 'X-Original-To': to } : {}),
    ...(opts.headers || {})
  };

  const mail = {
    from: FROM_EMAIL,
    to: finalTo,
    replyTo: REPLY_TO,
    subject,
    text,
    html,
    headers,
    ...(BCC_TO ? { bcc: BCC_TO } : {})
  };

  // Retry with backoff on transient issues
  let attempt = 0, delay = 400;
  /* eslint-disable no-constant-condition */
  while (true) {
    try {
      const info = await transporter.sendMail(mail);
      return { id: info.messageId, accepted: info.accepted, rejected: info.rejected };
    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES || !transientSmtp(err)) throw err;
      if (process.env.DEBUG_EMAIL) console.warn(`[mailer] transient error, retry ${attempt}/${MAX_RETRIES}:`, err?.message);
      await sleep(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }
  /* eslint-enable no-constant-condition */
}

/**
 * Convenience for prospecting: build subject/body from templates and a biz object.
 * Usage: await sendProspectEmail('owner@site.com', { biz, subject?, text?, html? })
 */
export async function sendProspectEmail(to, { biz = {}, subject, text, html, headers } = {}) {
  const ctx = {
    brand: BRAND,
    business: biz.name || biz.business || '',
    city: biz.city || '',
    state: biz.state || '',
    website: biz.website || biz.url || '',
    yourSite: process.env.YOUR_SITE || process.env.SENDER_SITE || '',
  };

  const subj = subject || fill(DEFAULT_SUBJECT, ctx);
  const body = text || fill(DEFAULT_BODY, ctx);

  return sendEmail(to, subj, body, { html, headers });
}
