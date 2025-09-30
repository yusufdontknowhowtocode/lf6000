// src/places.js (ESM)
const API_KEY = process.env.GOOGLE_PLACES_KEY;
if (!API_KEY) throw new Error('Missing GOOGLE_PLACES_KEY in .env');

/**
 * Find businesses using Places API v1 searchText and return name + website.
 * We request websiteUri in the field mask so we get it in one round-trip.
 */
export async function findBusinesses(city, niche, max = 300) {
  const out = [];
  let pageToken = undefined;

  while (out.length < max) {
    const body = {
      textQuery: `${niche} in ${city}`,
      // Tune this if you want to bias results (optional):
      // locationBias: { circle: { center: { latitude, longitude }, radius: 50000 } }
      pageSize: Math.min(20, max - out.length),
      pageToken,
    };

    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY,
        // Ask explicitly for the fields we need:
        'X-Goog-FieldMask': 'places.id,places.displayName,places.websiteUri,nextPageToken',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Places search failed: ${resp.status} ${txt}`);
    }

    const data = await resp.json();
    const places = data.places || [];

    for (const p of places) {
      out.push({
        name: p.displayName?.text || p.displayName || '',
        website: p.websiteUri || '',
      });
      if (out.length >= max) break;
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  // de-dup & keep top
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
