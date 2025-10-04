// server.js (lead finder 6000) — private edition
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

import { fetchBusinessesPage } from './src/places.js';
import { findEmailOnSite } from './src/enrich.js';
import { sendEmail, transporter } from './src/mailer.js';

// csv-writer is CJS
import csvWriterPkg from 'csv-writer';
const { createObjectCsvWriter } = csvWriterPkg;

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ---------------------------- Private controls --------------------------- */
app.set('trust proxy', true);

const BASIC_USER = process.env.BASIC_AUTH_USER || '';
const BASIC_PASS = process.env.BASIC_AUTH_PASS || '';
const ALLOW_IPS  = (process.env.ALLOW_IPS || '').split(',').map(s => s.trim()).filter(Boolean);

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.stack || e));
process.on('uncaughtException',  (e) => console.error('[uncaughtException]',  e?.stack || e));

/* ------------------------------ HTTPS redirect --------------------------- */
app.use((req, res, next) => {
  const xfproto = req.headers['x-forwarded-proto'];
  if (xfproto && xfproto !== 'https') return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  next();
});

/* ------------------------------ IP allow list ---------------------------- */
app.use((req, res, next) => {
  if (!ALLOW_IPS.length) return next();
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip  = fwd || req.ip || '';
  if (ALLOW_IPS.includes(ip)) return next();
  res.status(403).send('Forbidden');
});

/* -------------------------------- Basic auth ----------------------------- */
function requireAuth(req, res, next) {
  if (!BASIC_USER || !BASIC_PASS) return res.status(503).send('Auth not configured');
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="LF6000"');
    return res.status(401).send('Auth required');
  }
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  if (user === BASIC_USER && pass === BASIC_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="LF6000"');
  return res.status(401).send('Bad credentials');
}
app.use(requireAuth);

/* ----------------------------- robots (private) -------------------------- */
app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

/* -------------------------- Middleware / static -------------------------- */
app.disable('x-powered-by');

const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigins.length ? corsOrigins : false, credentials: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/public', express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/brand', express.static(path.join(__dirname, 'public/brand')));

/* ------------------------------ SSE helper ------------------------------ */
function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); };
  const ping = setInterval(() => send('ping', { t: Date.now() }), 20000);
  res.on('close', () => clearInterval(ping));
  return send;
}

/* ---------------------- Cross-run dedupe (persisted) --------------------- */
const SENT_FILE = path.join(__dirname, 'sent-emails.json');
let SENT = new Set();
async function loadSent() {
  try { const raw = await fs.readFile(SENT_FILE, 'utf8'); SENT = new Set(JSON.parse(raw)); }
  catch { SENT = new Set(); }
}
let saveTimer = null;
async function queueSaveSent() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await fs.writeFile(SENT_FILE, JSON.stringify([...SENT], null, 2)); }
    catch (e) { console.warn('[dedupe] save failed:', e?.message); }
  }, 1000);
}
await loadSent();

/* --------------------------- Dedupe handy endpoints ---------------------- */
app.get('/api/dedupe/stats', (_req, res) => res.json({ ok:true, total: SENT.size }));
app.post('/api/dedupe/clear', async (_req, res) => {
  SENT = new Set();
  try { await fs.writeFile(SENT_FILE, '[]'); } catch {}
  res.json({ ok:true, cleared:true });
});

/* --------------------------------- State -------------------------------- */
const jobs = new Map(); // jobId -> { log, done, file, stats, cancelled, _senders:Set, _hb }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pushLog = (job, message) => {
  const line = { ts: Date.now(), message: String(message) };
  job.log.push(line);
  if (job._senders) for (const fn of job._senders) { fn('log', line); fn('stats', job.stats); }
};

/* ----------------------- Concurrency pool (parallelize) ------------------ */
const CONCURRENCY = Number(process.env.LEAD_CONCURRENCY || 6);
async function runPool(tasks, limit = CONCURRENCY) {
  const q = tasks.slice();
  const workers = Array.from({ length: Math.min(limit, q.length || 0) }, async () => {
    while (q.length) { const t = q.shift(); try { await t(); } catch {} }
  });
  await Promise.all(workers);
}

/* -------------------------- City fanout + queries ------------------------ */
// Expand metro names and whole STATES into many metros for broader coverage.
function expandCity(city) {
  const c = String(city || '').trim();
  if (!c) return [];
  const L = c.toLowerCase();

  // State → metro fanout
  const states = {
    'pennsylvania': ['Philadelphia','Pittsburgh','Allentown','Erie','Reading','Scranton','Harrisburg','Lancaster','Bethlehem','York','State College','Wilkes-Barre'],
    'texas': ['Houston','San Antonio','Dallas','Austin','Fort Worth','El Paso','Arlington','Plano','Corpus Christi','Lubbock'],
    'florida': ['Miami','Orlando','Tampa','Jacksonville','St. Petersburg','Hialeah','Fort Lauderdale','Tallahassee','Sarasota','Boca Raton'],
    'california': ['Los Angeles','San Diego','San Jose','San Francisco','Sacramento','Fresno','Long Beach','Oakland','Bakersfield','Riverside'],
    'new york': ['New York','Buffalo','Rochester','Yonkers','Syracuse','Albany','White Plains'],
    'illinois': ['Chicago','Aurora','Naperville','Joliet','Elgin','Waukegan'],
  };
  for (const k of Object.keys(states)) if (L === k) return states[k];

  // Metro presets
  const metros = {
    'new york city': ['New York','Manhattan','Brooklyn','Queens','Bronx','Staten Island','Long Island','Jersey City','Hoboken','Newark'],
    'los angeles': ['Los Angeles','Santa Monica','Beverly Hills','Pasadena','Burbank','Glendale','Long Beach'],
    'chicago': ['Chicago','Evanston','Oak Park','Skokie','Cicero'],
    'miami': ['Miami','Miami Beach','Coral Gables','Hialeah','Doral','North Miami'],
    'dallas': ['Dallas','Plano','Richardson','Irving','Arlington','Garland'],
    'houston': ['Houston','Sugar Land','Pearland','Pasadena TX','Spring','The Woodlands'],
    'san francisco': ['San Francisco','Oakland','Berkeley','Daly City','San Mateo','San Jose'],
    'seattle': ['Seattle','Bellevue','Redmond','Kirkland','Renton'],
    'boston': ['Boston','Cambridge','Somerville','Brookline','Quincy'],
    'atlanta': ['Atlanta','Sandy Springs','Decatur','Marietta','Smyrna'],
  };
  for (const k of Object.keys(metros)) if (L === k) return metros[k];

  // Generic compass fanout
  return [ c, `North ${c}`, `South ${c}`, `East ${c}`, `West ${c}`, `${c} Downtown`, `${c} Suburbs` ];
}
function cityQueries(niche, city) {
  return [ `${niche} in ${city}`, `${niche} near ${city}`, `${city} ${niche}` ];
}

/* ------------------------------- Endpoints ------------------------------- */
// SMTP verify / test
app.get('/api/email-verify', async (_req, res) => {
  if (!transporter) return res.status(500).json({ ok:false, error:'smtp_disabled' });
  try { await transporter.verify(); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ ok:false, error:String(e.message || e) }); }
});
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

// Places demo
app.get('/api/places-test', async (req, res) => {
  try {
    const { city = 'Austin', niche = 'orthodontist' } = req.query;
    const { items } = await fetchBusinessesPage({ query: `${niche} in ${city}`, pageSize: 10 });
    res.json({ ok: true, count: items.length, sample: items.slice(0, 5) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* ---------------------------- Helper: sender ----------------------------- */
async function trySend(job, rows, {
  company, area, website, demoSite, subject, body, email
}) {
  const ctx = { company: company || 'your business', city: area, firstName: 'there', website: website || '', yourSite: demoSite || '' };
  const render = (tpl) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? '');
  const subj = render(subject || 'Quick idea for {company}');
  const txt  = render(body || 'Hey {firstName}, quick idea for {company} in {city}. Free demo: {yourSite}');

  try {
    await sendEmail(email, subj, txt);
    job.stats.sent++;
    rows.push({ email, company, city: area, website, status: 'sent' });
    pushLog(job, `✅ Sent to ${email} (${company || 'Unknown'})`);
    return true;
  } catch (e) {
    job.stats.skipped++;
    rows.push({ email, company, city: area, website, status: 'send_failed' });
    pushLog(job, `❌ Send failed to ${email}: ${String(e?.message || e)}`.slice(0, 200));
    return false;
  }
}

/* -------------------------- Main run: /api/run --------------------------- */
app.post('/api/run', async (req, res) => {
  const { niche, cities, cap, subject, body, yourSite, website, site, ignorePrevious } = req.body || {};
  if (!niche) return res.status(400).json({ error: 'Missing niche' });

  const demoSite = String(yourSite || website || site || process.env.DEMO_SITE || '').trim();
  const cityList = String(cities || '').split(',').map(s => s.trim()).filter(Boolean);

  const maxSend    = Number(process.env.DEFAULT_SEND_CAP || 200);
  const requested  = Number(cap || maxSend);
  const targetCap  = Math.min(requested, maxSend);

  const throttleMs  = Number(process.env.SEND_THROTTLE_MS || 1500);
  const IGNORE_PREV = !!ignorePrevious;
  const RESEND_ON_SHORTFALL = String(process.env.RESEND_ON_SHORTFALL || '').match(/^(1|true|yes)$/i);

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    log: [],
    done: false,
    cancelled: false,
    file: null,
    stats: { found: 0, withEmail: 0, sent: 0, skipped: 0 },
  };
  jobs.set(jobId, job);

  (async () => {
    const rows = [];
    const seenInRunEmails = new Set(); // per-run email dedupe
    const seenInRunSites  = new Set(); // per-run website dedupe

    const rawCities = cityList.length ? cityList : ['United States'];
    const areas = rawCities.flatMap(expandCity);

    job._hb = setInterval(() => pushLog(job, '⏳ still working…'), 10000);

    // ---------- Primary pass (new contacts only unless ignorePrevious) ----------
    for (const area of areas) {
      if (job.cancelled || job.stats.sent >= targetCap) break;

      for (const query of cityQueries(niche, area)) {
        if (job.cancelled || job.stats.sent >= targetCap) break;

        pushLog(job, `🔎 Searching: "${query}"`);
        let cursor = null, pageNo = 0;

        while (!job.cancelled && job.stats.sent < targetCap) {
          let items = [];
          try {
            const page = await fetchBusinessesPage({ query, cursor, pageSize: 20 });
            items  = page.items || [];
            cursor = page.nextCursor || null;
            pageNo++;
          } catch (e) {
            pushLog(job, `💥 Places error: ${String(e)}`);
            break;
          }

          if (!items.length) {
            pushLog(job, pageNo === 1 ? '📭 No results.' : `📭 No more results (pages=${pageNo-1})`);
            break;
          }
          pushLog(job, `📍 Page ${pageNo}: ${items.length} businesses.`);

          // --- Parallel per-page processing ---
          await runPool(items.map(b => async () => {
            if (job.cancelled || job.stats.sent >= targetCap) return;

            job.stats.found++;

            const siteKey = (b.website || '').toLowerCase();
            if (!b.website || seenInRunSites.has(siteKey)) {
              job.stats.skipped++;
              if (!b.website) pushLog(job, `❎ No website for ${b.name || 'Unknown'}`);
              return;
            }
            seenInRunSites.add(siteKey);

            let email = null;
            try { email = await findEmailOnSite(b.website); } catch {}
            if (!email) {
              job.stats.skipped++;
              pushLog(job, `❎ No email for ${b.name || 'Unknown'}`);
              return;
            }

            const ekey = email.toLowerCase();

            // dedupe logic with the new flag
            if (!IGNORE_PREV && (SENT.has(ekey) || seenInRunEmails.has(ekey))) {
              job.stats.skipped++;
              return;
            }
            if (IGNORE_PREV && seenInRunEmails.has(ekey)) {
              job.stats.skipped++;
              return;
            }

            seenInRunEmails.add(ekey);
            job.stats.withEmail++;

            const sentOk = await trySend(job, rows, {
              company: b.name, area, website: b.website, demoSite, subject, body, email
            });
            if (sentOk) { SENT.add(ekey); queueSaveSent(); }

            if (throttleMs > 0) await sleep(throttleMs); // light pacing
          }), CONCURRENCY);

          if (!cursor) break;
        }
      }
    }

    // ---------- Fallback pass (optional): allow previously-contacted ----------
    if (!job.cancelled && job.stats.sent < targetCap && RESEND_ON_SHORTFALL) {
      pushLog(job, `↩️ Shortfall fallback: allowing previously contacted to reach cap (${job.stats.sent}/${targetCap})`);
      for (const area of areas) {
        if (job.cancelled || job.stats.sent >= targetCap) break;
        for (const query of cityQueries(niche, area)) {
          if (job.cancelled || job.stats.sent >= targetCap) break;
          let cursor = null, pageNo = 0;
          while (!job.cancelled && job.stats.sent < targetCap) {
            let items = [];
            try {
              const page = await fetchBusinessesPage({ query, cursor, pageSize: 20 });
              items  = page.items || [];
              cursor = page.nextCursor || null;
              pageNo++;
            } catch { break; }
            if (!items.length) break;

            await runPool(items.map(b => async () => {
              if (job.cancelled || job.stats.sent >= targetCap) return;
              if (!b.website) return;

              let email = null;
              try { email = await findEmailOnSite(b.website); } catch {}
              if (!email) return;

              const ekey = email.toLowerCase();
              if (seenInRunEmails.has(ekey)) return; // avoid duplicates in THIS run
              seenInRunEmails.add(ekey);
              job.stats.withEmail++;

              await trySend(job, rows, {
                company: b.name, area, website: b.website, demoSite, subject, body, email
              });

              if (throttleMs > 0) await sleep(throttleMs);
            }), CONCURRENCY);

            if (!cursor) break;
          }
        }
      }
    }

    if (job.cancelled) pushLog(job, '🛑 Stopped by user');

    // Write CSV
    try {
      const outPath = path.join(__dirname, `results-${jobId}.csv`);
      const writer = createObjectCsvWriter({
        path: outPath,
        header: [
          { id: 'email',   title: 'Email' },
          { id: 'company', title: 'Company' },
          { id: 'city',    title: 'City/Area' },
          { id: 'website', title: 'Website' },
          { id: 'status',  title: 'Status' },
        ],
      });
      await writer.writeRecords(rows);
      job.file = `/download/${path.basename(outPath)}`;
    } catch (e) {
      pushLog(job, `💾 CSV write failed: ${String(e?.message || e)}`);
    }

    clearInterval(job._hb);
    job.done = true;
    pushLog(job, '🏁 Job complete');
    if (job._senders) for (const fn of job._senders) fn('done', { file: job.file, stats: job.stats });
  })().catch((e) => {
    clearInterval(job._hb);
    pushLog(job, '💥 Job error: ' + String(e));
    const j = jobs.get(jobId); if (j) j.done = true;
  });

  res.json({ jobId });
});

/* --------------------------- Cancel / Stream / DL ------------------------ */
app.post('/api/cancel', (req, res) => {
  const { jobId } = req.query;
  const job = jobs.get(String(jobId || ''));
  if (!job) return res.status(404).json({ ok:false, error:'not_found' });
  job.cancelled = true;
  res.json({ ok:true });
});

app.get('/api/stream', (req, res) => {
  const { jobId } = req.query;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).end();
  const send = sse(res);
  for (const l of job.log) send('log', l);
  send('stats', job.stats);
  if (job.done) { send('done', { file: job.file, stats: job.stats }); return res.end(); }
  job._senders = job._senders || new Set();
  job._senders.add(send);
  req.on('close', () => job._senders.delete(send));
});

app.get('/download/:file', (req, res) => {
  const base = path.basename(req.params.file || '');
  if (!base.startsWith('results-') || !base.endsWith('.csv')) return res.status(400).send('Bad file name');
  res.download(path.join(__dirname, base));
});

// Redirect root to the UI
app.get('/', (_req, res) => res.redirect('/public/index.html'));

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* --------------------------------- Start -------------------------------- */
const PORT = Number(process.env.PORT || 4002);
app.listen(PORT, () => console.log(`Prospector dashboard on :${PORT}`));
