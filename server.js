// server.js (lead finder 6000) — private edition
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { findBusinesses } from './src/places.js';
import { findEmailOnSite } from './src/enrich.js';
import { sendEmail } from './src/mailer.js';

// csv-writer is CJS
import csvWriterPkg from 'csv-writer';
const { createObjectCsvWriter } = csvWriterPkg;

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ---------------------------- Private controls --------------------------- */
app.set('trust proxy', true); // respect X-Forwarded-Proto/IP on Render/CF

const BASIC_USER = process.env.BASIC_AUTH_USER || '';
const BASIC_PASS = process.env.BASIC_AUTH_PASS || '';
const ALLOW_IPS  = (process.env.ALLOW_IPS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// HTTPS only (redirect if someone hits http behind a proxy)
app.use((req, res, next) => {
  const xfproto = req.headers['x-forwarded-proto'];
  if (xfproto && xfproto !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});

// Optional IP allow-list (before auth)
app.use((req, res, next) => {
  if (!ALLOW_IPS.length) return next();
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip  = fwd || req.ip || '';
  if (ALLOW_IPS.includes(ip)) return next();
  res.status(403).send('Forbidden');
});

// Basic Auth for everything (UI + APIs)
function requireAuth(req, res, next) {
  if (!BASIC_USER || !BASIC_PASS) return res.status(503).send('Auth not configured');
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Restricted"');
    return res.status(401).send('Auth required');
  }
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  if (user === BASIC_USER && pass === BASIC_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Restricted"');
  return res.status(401).send('Bad credentials');
}
app.use(requireAuth);

// Don’t let bots index this
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

/* -------------------------- Middleware / static -------------------------- */
app.disable('x-powered-by');
// You can lock CORS to your own origin(s) if you want:
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({
  origin: corsOrigins.length ? corsOrigins : false,
  credentials: false,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* ------------------------------ SSE helper ------------------------------ */
function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  return (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

/* --------------------------------- State -------------------------------- */
const jobs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pushLog = (job, message) => {
  const line = { ts: Date.now(), message: String(message) };
  job.log.push(line);
  if (job._senders) {
    for (const fn of job._senders) {
      fn('log', line);
      fn('stats', job.stats);
    }
  }
};

/* ------------------------------- Endpoints ------------------------------- */

// SMTP sanity check
app.get('/api/email-test', async (req, res) => {
  try {
    const to = String(req.query.to || process.env.EMAIL_USER || '').trim();
    if (!to) return res.status(400).json({ ok: false, error: 'Set ?to=recipient@example.com' });
    const r = await sendEmail(to, 'Prospector test', 'If you can read this, SMTP works.');
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Defaults for UI inputs
app.get('/api/defaults', (_req, res) => {
  res.json({
    subject: process.env.SUBJECT_DEFAULT || 'Quick idea to stop missed calls at {company}',
    body:
      process.env.BODY_DEFAULT ||
      [
        'Hey {firstName},',
        '',
        'Noticed {company} in {city} is likely missing after-hours calls from {website}.',
        'We plug in a 24/7 AI receptionist that answers, qualifies, and books—so missed calls = booked jobs, not lost revenue.',
        '',
        'Typical lift: +15–35% more booked appointments in 2–3 weeks.',
        'Free demo + details: {yourSite}',
        '',
        'Worth a quick look?'
      ].join('\n'),
  });
});

// Places demo (debug)
app.get('/api/places-test', async (req, res) => {
  try {
    const { city = 'Austin', niche = 'orthodontist' } = req.query;
    const rows = await findBusinesses(String(city), String(niche), 10);
    res.json({ ok: true, count: rows.length, sample: rows.slice(0, 5) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Kick off a prospecting run
app.post('/api/run', async (req, res) => {
  const { niche, cities, cap, subject, body, yourSite, website, site } = req.body || {};
  if (!niche) return res.status(400).json({ error: 'Missing niche' });

  const demoSite = String(yourSite || website || site || process.env.DEMO_SITE || '').trim();
  const cityList = String(cities || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const maxSend = Number(cap || process.env.DEFAULT_SEND_CAP || 200);
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const job = {
    log: [],
    done: false,
    file: null,
    stats: { found: 0, withEmail: 0, sent: 0, skipped: 0 },
  };
  jobs.set(jobId, job);

  (async () => {
    const rows = [];
    const seenEmails = new Set();
    const citiesToProcess = cityList.length ? cityList : ['United States'];

    for (const city of citiesToProcess) {
      pushLog(job, `🔎 Searching: "${niche}" in ${city}…`);

      let batch = [];
      try {
        batch = await findBusinesses(city, niche, 300);
      } catch (e) {
        pushLog(job, `💥 Places error for ${city}: ${String(e)}`);
        continue;
      }

      pushLog(job, `📍 Found ${batch.length} businesses in ${city}.`);

      for (const b of batch) {
        job.stats.found++;

        let email = null;
        try { email = await findEmailOnSite(b.website); } catch {}
        if (!email) {
          job.stats.skipped++;
          pushLog(job, `❎ No email for ${b.name || 'Unknown'} (${city})`);
          continue;
        }

        const key = email.toLowerCase();
        if (seenEmails.has(key)) { job.stats.skipped++; continue; }
        seenEmails.add(key);
        job.stats.withEmail++;

        const ctx = {
          company: b.name || 'your business',
          city,
          firstName: 'there',
          website: b.website || '',
          yourSite: demoSite || ''
        };
        const render = (tpl) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? '');

        const subj = render(subject || 'Quick idea for {company}');
        const txt  = render(body || 'Hey {firstName}, quick idea for {company} in {city}. Free demo: {yourSite}');

        try {
          await sendEmail(email, subj, txt);
          job.stats.sent++;
          rows.push({ email, company: b.name || '', city, website: b.website || '', status: 'sent' });
          pushLog(job, `✅ Sent to ${email} (${b.name || 'Unknown'})`);
        } catch (e) {
          job.stats.skipped++;
          rows.push({ email, company: b.name || '', city, website: b.website || '', status: 'send_failed' });
          pushLog(job, `❌ Send failed to ${email}: ${String(e).slice(0, 180)}`);
        }

        if (job.stats.sent >= maxSend) break;
        await sleep(1500);
      }
      if (job.stats.sent >= maxSend) break;
    }

    const outPath = path.join(__dirname, `results-${jobId}.csv`);
    const writer = createObjectCsvWriter({
      path: outPath,
      header: [
        { id: 'email',   title: 'Email' },
        { id: 'company', title: 'Company' },
        { id: 'city',    title: 'City' },
        { id: 'website', title: 'Website' },
        { id: 'status',  title: 'Status' },
      ],
    });
    await writer.writeRecords(rows);

    job.file = `/download/${path.basename(outPath)}`;
    job.done = true;
    pushLog(job, '🏁 Job complete');
  })().catch((e) => {
    pushLog(job, '💥 Job error: ' + String(e));
    job.done = true;
  });

  res.json({ jobId });
});

// Stream logs/stats
app.get('/api/stream', (req, res) => {
  const { jobId } = req.query;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).end();

  const send = sse(res);
  for (const l of job.log) send('log', l);
  send('stats', job.stats);

  if (job.done) {
    send('done', { file: job.file, stats: job.stats });
    return res.end();
  }
  job._senders = job._senders || new Set();
  job._senders.add(send);
  req.on('close', () => job._senders.delete(send));
});

// Safe CSV download
app.get('/download/:file', (req, res) => {
  const base = path.basename(req.params.file || '');
  if (!base.startsWith('results-') || !base.endsWith('.csv')) {
    return res.status(400).send('Bad file name');
  }
  res.download(path.join(__dirname, base));
});

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* --------------------------------- Start -------------------------------- */
const PORT = Number(process.env.PORT || 4002);
app.listen(PORT, () => console.log(`Prospector dashboard on :${PORT}`));
