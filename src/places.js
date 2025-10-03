// src/places.js (ESM)
const API_KEY = process.env.GOOGLE_PLACES_KEY;
if (!API_KEY) throw new Error('Missing GOOGLE_PLACES_KEY in .env');

const PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

// Small utility: parse "City, ST ..." out of a formatted address
function cityStateFromFormatted(addr = '') {
  // Examples Google returns:
  // "123 Main St, Miami, FL 33130, USA"
  // "742 Evergreen Terrace, Springfield, IL, USA"
  // "Somewhere, Dubai, United Arab Emirates"
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return { city: '', state: '' };

  // Heuristic: country is last; state/region is second-to-last; city is third-to-last
  const country = parts[parts.length - 1];
  const stateish = parts[parts.length - 2] || '';
  const cityish  = parts[parts.length - 3] || '';

  // State may include ZIP. Keep first token: "FL 33130" -> "FL"
  const state = stateish.split(/\s+/)[0] || '';
  const city  = cityish || (parts.length >= 2 ? parts[parts.length - 2] : '');

  // Avoid returning country as city when only two parts
  if (parts.length === 2) return { city: parts[0], state: '' };

  return { city, state };
}

/**
 * Fetch ONE page of Places results for a text query.
 * Returns { items, nextCursor }.
 *
 * items[i] shape:
 *  { name, website, url, address, city, state }
 */
export async function fetchBusinessesPage({ query, cursor = null, pageSize = 20 }) {
  const body = {
    textQuery: String(query || '').trim(),
    pageSize: Math.min(20, Math.max(1, pageSize)),
    pageToken: cursor || undefined,
  };

  const resp = await fetch(PLACES_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      // Ask explicitly for the fields we need (keeps payload small & fast):
      'X-Goog-FieldMask': [
        'places.id',
        'places.displayName',
        'places.websiteUri',
        'places.formattedAddress',
        'nextPageToken',
      ].join(','),
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Places search failed: ${resp.status} ${txt}`);
  }

  const data = await resp.json();
  const places = data.places || [];

  const items = places.map(p => {
    const name    = p.displayName?.text || p.displayName || '';
    const website = p.websiteUri || '';
    const addr    = p.formattedAddress || '';
    const { city, state } = cityStateFromFormatted(addr);

    return {
      name,
      website,
      url: website,     // alias used by our runner/enricher
      address: addr,
      city,
      state,
    };
  });

  const nextCursor = data.nextPageToken || null;
  return { items, nextCursor };
}

/**
 * Convenience helper (keeps your old call site working):
 * Find up to `max` businesses for "niche in city" and return de-duplicated list.
 */
export async function findBusinesses(city, niche, max = 300) {
  const query = `${niche} in ${city}`;
  const out = [];
  let cursor = null;

  while (out.length < max) {
    const { items, nextCursor } = await fetchBusinessesPage({
      query,
      cursor,
      pageSize: Math.min(20, max - out.length),
    });

    if (!items.length) break;

    for (const it of items) {
      out.push({ name: it.name, website: it.website });
      if (out.length >= max) break;
    }

    cursor = nextCursor;
    if (!cursor) break;

    // very short pause to be polite; can tune/remove
    await new Promise(r => setTimeout(r, 200));
  }

  // de-dup by website (fallback to name)
  const seen = new Set();
  const deduped = [];
  for (const r of out) {
    const key = (r.website || r.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  return deduped;
}
