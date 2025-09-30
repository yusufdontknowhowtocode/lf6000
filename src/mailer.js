// src/mailer.js
import 'dotenv/config';
import nodemailer from 'nodemailer';

const BRAND        = process.env.SENDER_BRAND || 'Agentlyne';
const FROM_ADDR    = (process.env.EMAIL_USER || 'info@agentlyne.com').trim();
const FROM_EMAIL   = `${BRAND} <${FROM_ADDR}>`;
const REPLY_TO     = (process.env.REPLY_TO || FROM_ADDR).trim();
const BCC_TO       = (process.env.BCC_TO || '').trim();

const MG_USER      = (process.env.MAILGUN_SMTP_USER || '').trim();   // e.g. postmaster@mg.agentlyne.com
const MG_PASS      = (process.env.MAILGUN_SMTP_PASS || '').trim();
const MG_DOMAIN    = (process.env.MAILGUN_DOMAIN || 'mg.agentlyne.com').trim();
const MG_REGION    = (process.env.MAILGUN_REGION || '').trim().toLowerCase(); // optional: 'eu' to force EU

// pick the right host (EU vs US)
const SMTP_HOST = MG_REGION === 'eu' ? 'smtp.eu.mailgun.org' : 'smtp.mailgun.org';

// Allow overrides via generic SMTP_* if you later add them
const host   = process.env.SMTP_HOST || SMTP_HOST;
const port   = Number(process.env.SMTP_PORT || 587);
const secure = String(process.env.SMTP_SECURE || 'false').match(/^(1|true|yes|on)$/i) ? true : false;
const user   = process.env.SMTP_USER || MG_USER;
const pass   = process.env.SMTP_PASS || MG_PASS;

if (!user || !pass) {
  console.warn('[mailer] Missing SMTP credentials. Check MAILGUN_SMTP_USER/MAILGUN_SMTP_PASS (or SMTP_USER/SMTP_PASS).');
}

export const transporter = nodemailer.createTransport({
  host, port, secure,
  auth: { user, pass },
  pool: true,
  tls: { minVersion: 'TLSv1.2' },
  logger: !!process.env.DEBUG_EMAIL,
  debug:  !!process.env.DEBUG_EMAIL
});

// Verify once at module load
(async () => {
  try {
    await transporter.verify();
    console.log(`[mailer] SMTP ready (${host}:${port}) as ${user}`);
  } catch (e) {
    console.error('[mailer] SMTP verify FAILED:', e.message);
  }
})();

/**
 * Send a plaintext email (with minimal HTML mirror).
 * @param {string} to      Recipient address
 * @param {string} subject Subject
 * @param {string} text    Body (plain text)
 * @param {object} opts    { html?, headers? }
 */
export async function sendEmail(to, subject, text, opts = {}) {
  if (!to) throw new Error('Missing "to"');

  // Debug mode: redirect all mail to yourself but keep the original in headers
  const debugMode = String(process.env.DEBUG_EMAIL || '').trim() !== '' && process.env.DEBUG_EMAIL !== '0';
  const finalTo   = debugMode ? FROM_ADDR : to;

  const html =
    opts.html ??
    `<pre style="font:14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif">${escapeHtml(
      text || ''
    )}</pre>`;

  const headers = {
    'X-Mailer-App': 'lead-finder-6000',
    'List-Unsubscribe': `<mailto:unsubscribe@${(FROM_ADDR.split('@')[1] || 'agentlyne.com')}?subject=unsubscribe>`,
    ...(debugMode ? { 'X-Original-To': to } : {}),
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

  const info = await transporter.sendMail(mail);
  return { id: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
