// src/runner.js

// Streams business results across many pages (and optional fallback queries)
export async function* leadStream({
  primaryQuery,
  fallbackQueries = [],
  fetchBusinessesPage,      // fn({ query, cursor }) -> { items, nextCursor }
  maxPagesPerQuery = Number(process.env.SEARCH_PAGES_PER_QUERY || 8),
  maxTotalPages     = Number(process.env.SEARCH_TOTAL_PAGES || 40),
  perPageDelayMs    = Number(process.env.SEARCH_PAGE_DELAY_MS || 400),
}) {
  const queries = [primaryQuery, ...fallbackQueries];
  let totalPages = 0;

  for (const q of queries) {
    let cursor = null;
    let pages  = 0;

    while (pages < maxPagesPerQuery && totalPages < maxTotalPages) {
      const pack = await fetchBusinessesPage({ query: q, cursor }).catch(() => null);
      const items = pack?.items || [];
      const nextCursor = pack?.nextCursor ?? null;

      if (!items.length) break;

      for (const biz of items) yield { ...biz, _q: q, _page: pages };

      cursor = nextCursor;
      pages++;
      totalPages++;
      if (!cursor) break;
      if (perPageDelayMs) await new Promise(r => setTimeout(r, perPageDelayMs));
    }
  }
}

/**
 * Run a prospecting job until we actually SEND `want` emails (or exhaust results / caps).
 */
export async function runJob({
  query,                       // e.g., "Orthodontist in Raleigh"
  want = 25,                   // target sends
  fetchBusinessesPage,         // from src/places.js
  findEmailOnSite,             // from src/enrich.js
  sendEmail,                   // from src/mailer.js
  fallbackQueries = [],        // optional “near …” variations
  log = () => {},              // logger function
}) {
  const caps = {
    maxInspected: Number(process.env.MAX_INSPECTED || 500), // safety guard
  };

  let found = 0, withEmail = 0, sent = 0, skipped = 0, inspected = 0;

  for await (const biz of leadStream({
    primaryQuery: query,
    fallbackQueries,
    fetchBusinessesPage,
  })) {
    if (sent >= want) break;                 // << stop when we hit the goal
    if (inspected >= caps.maxInspected) break;

    inspected++;
    found++;

    const hints = { name: biz.name, city: biz.city, state: biz.state };
    const email = await findEmailOnSite(biz.website || biz.url, hints).catch(() => null);

    if (!email) {
      skipped++;
      log(`❌ No email for ${biz.name}${biz.city ? ` (${biz.city})` : ''}`);
      continue;
    }

    withEmail++;
    const ok = await sendEmail(email, { biz }).catch(() => false);

    if (ok) {
      sent++;
      log(`✅ Sent to ${email} (${biz.name})`);
    } else {
      skipped++;
      log(`⚠️ Failed to send to ${email} (${biz.name})`);
    }
  }

  const doneBecause = sent >= want ? 'goal_reached' : 'exhausted_results';
  return { found, withEmail, sent, skipped, inspected, doneBecause };
}
