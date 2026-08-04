#!/usr/bin/env node
/**
 * AWF-3: Web Footprint Scanner
 *
 * For each contractor, searches Google Places (New) by name + city, pulls the
 * business listing (website, rating, review count, most recent review dates,
 * operating status), and writes presence signals. This is the "no website, no
 * reviews" corroboration for Strategy 1 and 2, and business_status_closed is a
 * strong standalone signal for Strategies 4 and 10.
 *
 * Two calls per contractor: Text Search (cheap, id + name only) to find the
 * place, then Place Details (pricier — includes reviews) only for confirmed
 * matches. Never trusts the top search result blindly: the returned name is
 * token-matched against the contractor's normalized name before anything is
 * written, same rule as every other matcher in this system.
 *
 * Rolling batch by design (like a weekly AWF- job): each run processes the N
 * contractors with the oldest last_enriched, so the whole 3,807-contractor
 * universe gets a full pass over several runs rather than one giant one.
 *
 * Modes:
 *   DISCOVERY=1 -> runs a small sample (10 contractors), prints raw API
 *                  responses so field names and match quality can be checked
 *                  before trusting anything. No writes.
 *   DRY_RUN=1   -> full batch, real matching + signal logic, counts only.
 *   (default)   -> full batch, writes to Supabase.
 */

const CHUNK = 200;                  // Supabase write batch size
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 300);   // contractors per run
const DISCOVERY_SAMPLE = 10;
const REQUEST_DELAY_MS = 120;       // spacing between Places calls
const REVIEW_STALE_MONTHS = 12;
const SITE_CHECK_TIMEOUT_MS = 8000;

const DISCOVERY = process.env.DISCOVERY === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || '';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------- Supabase helpers ----------------
async function sb(method, q, body, extra) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
    method,
    headers: Object.assign({
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    }, extra || {}),
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${q} -> ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function sbGetAll(q) {
  const out = []; const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Range: `${offset}-${offset + PAGE - 1}`, 'Range-Unit': 'items'
      }
    });
    if (!res.ok) throw new Error(`Supabase GET ${q} -> ${res.status}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

// ---------------- Name matching (never trust blindly) ----------------
const STOPWORDS = new Set(['AIR', 'CONDITIONING', 'MECHANICAL', 'INC', 'LLC', 'CORP',
  'CO', 'COMPANY', 'SERVICES', 'SERVICE', 'AC', 'A', 'C', 'AND', 'THE', 'OF',
  // Common HVAC-trade filler words. On their own these are weak evidence of
  // identity — "Cool Breeze" and "Arctic Breeze" are different companies that
  // both use "Breeze"; treating trade adjectives as distinctive produces
  // false-positive matches. Distinctive tokens are surnames, place names, and
  // invented brand words, not the trade vocabulary every competitor shares.
  'COOL', 'COOLING', 'HEAT', 'HEATING', 'REFRIGERATION', 'COMFORT', 'HVAC',
  'SYSTEMS', 'SOLUTIONS', 'GROUP', 'HOME', 'PROS', 'PLUS', 'CONTRACTING',
  'CONTRACTOR', 'CONTRACTORS', 'SPECIALIST', 'SPECIALISTS', 'TECH', 'TECHNOLOGIES']);

function tokens(name) {
  return String(name || '').toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

// Overlap on the DISTINCTIVE tokens (proper nouns, surnames, invented brand
// words) rather than raw Jaccard over everything. ALWAYS requires 2+ shared
// distinctive tokens — no single-token exception, after two confirmed false
// positives both traced to exactly that escape hatch: "R Palacios & Company"
// matched a law firm on the surname "Palacios" alone (8 chars), and
// "Reinaldo Horday A/C Inc" matched an unrelated doctor on the first name
// "Reinaldo" alone (8 chars). A single name, however long or rare it looks,
// is not reliable identity by itself — first names in particular are shared
// across thousands of unrelated people. Google listings sometimes join words
// Sunbiz/DBPR keep separate ("AirMasters" vs "Air Masters"); a token is also
// credited as a hit if it's a substring (4+ chars) of a token on the other
// side, which is what lets that legitimate case still match with 2 tokens.
function nameMatchScore(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let hits = 0;
  for (const t of ta) {
    if (setB.has(t)) { hits++; continue; }
    if (t.length >= 4 && tb.some(bt => bt.length >= 4 && (bt.includes(t) || t.includes(bt)))) {
      hits++;
    }
  }
  if (hits < 2) return 0;
  return hits / Math.max(ta.length, 1);
}

// A contractor whose entity_name is a bare person's name ("DAVIS, RONALD L",
// the DBPR convention for an individually-licensed contractor with no DBA)
// cannot be safely searched by name alone: Places will happily return any
// other person or business sharing that name — a doctor, a lawyer, a
// stranger — and our token matcher will score it as a strong match, because
// the tokens genuinely do overlap. Caught in testing: "DAVIS, RONALD L"
// matched to a pediatric neurologist named "Ronald G. Davis," score 1.00.
// These contractors are skipped rather than searched. This isn't a real
// loss — an individual license with no corporate entity is already the
// strongest standalone Strategy 1 signal (established in AWF-2), so nothing
// downstream depends on web-footprint enrichment for this group.
function isBarePersonName(name) {
  const s = String(name || '').trim();
  if (/\d/.test(s)) return false;
  const m = s.match(/^([a-z' \-]+),\s*(.+)$/i);
  if (!m) return false;
  // A comma alone isn't enough — "Kendale Air Conditioning, Inc." has one too.
  // The distinguishing check is what comes after it: a real person-name comma
  // is followed by a first name; a corporate name is followed by a suffix.
  const CORP_SUFFIX = new Set(['INC', 'LLC', 'CORP', 'CO', 'LTD', 'LLP', 'LP', 'PA', 'PC', 'PLLC']);
  const afterComma = m[2].trim().toUpperCase().replace(/\./g, '');
  const firstWordAfter = afterComma.split(/\s+/)[0];
  return !CORP_SUFFIX.has(firstWordAfter);
}

// DBPR uses "INDIVIDUAL" as a literal placeholder in the DBA field when an
// individually-licensed person has no company name on file. It is not a real
// business name and must never be searched: caught in production — 12
// separate contractors all named "INDIVIDUAL" all matched to the same
// unrelated website (a professional whose Google listing happened to contain
// the generic word "individual"), because the placeholder itself was long
// enough to clear the token-match bar. Same treatment as bare person names.
function isPlaceholderName(name) {
  return String(name || '').trim().toUpperCase() === 'INDIVIDUAL';
}
async function placesTextSearch(query) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress'
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 3 })
  });
  if (res.status === 429) { await sleep(1500); return placesTextSearch(query); }
  if (!res.ok) throw new Error(`searchText ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function placeDetails(placeId) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': 'id,displayName,websiteUri,nationalPhoneNumber,rating,userRatingCount,businessStatus,reviews'
    }
  });
  if (res.status === 429) { await sleep(1500); return placeDetails(placeId); }
  if (!res.ok) throw new Error(`details ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function checkSiteAlive(url) {
  if (!url) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SITE_CHECK_TIMEOUT_MS);
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (KDM-AWF3 site check)' } });
    clearTimeout(timer);
    return res.status < 400;
  } catch {
    return false;
  }
}

function mostRecentReviewDate(reviews) {
  if (!Array.isArray(reviews) || !reviews.length) return null;
  const dates = reviews.map(r => r.publishTime).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1].slice(0, 10) : null;
}

// Every signal object must carry the exact same key set — PostgREST's bulk
// insert rejects a batch where objects have different shapes (PGRST102), and
// several push sites below previously omitted license_no entirely rather
// than setting it null, which is exactly that mismatch. One builder, one
// shape, guaranteed.
function makeSignal(contractorId, signalType, strategyIds, source, payload) {
  return {
    contractor_id: contractorId,
    license_no: null,
    signal_type: signalType,
    strategy_ids: strategyIds,
    source,
    payload: payload || {}
  };
}

function monthsAgo(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const now = new Date();
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
}

// ---------------- Main ----------------
async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY required.');
  if (!PLACES_KEY) throw new Error('GOOGLE_PLACES_API_KEY required.');

  const wantCount = DISCOVERY ? DISCOVERY_SAMPLE : BATCH_SIZE;
  log(`Loading rolling batch (${wantCount} contractors, oldest last_enriched first)...`);
  const rows = await sbGetAll(
    `acq_contractors?select=id,entity_name,city,state,county,region,last_enriched` +
    `&order=last_enriched.asc.nullsfirst&limit=${wantCount}`
  );
  log(`  ${rows.length} contractors loaded.`);

  const results = [];
  let apiCalls = 0;

  for (const c of rows) {
    if (isBarePersonName(c.entity_name) || isPlaceholderName(c.entity_name)) {
      results.push({ contractor: c, skipped: 'individual_name', matched: false });
      continue;
    }

    const query = `${c.entity_name} ${c.city || ''} FL`.replace(/\s+/g, ' ').trim();
    let search;
    try {
      search = await placesTextSearch(query);
      apiCalls++;
      await sleep(REQUEST_DELAY_MS);
    } catch (e) {
      results.push({ contractor: c, error: `search failed: ${e.message}` });
      continue;
    }

    const candidates = search.places || [];
    let best = null, bestScore = 0;
    for (const p of candidates) {
      const s = nameMatchScore(c.entity_name, p.displayName?.text || '');
      if (s > bestScore) { bestScore = s; best = p; }
    }

    // Require meaningful token overlap. Below this, treat as "not found" —
    // wrong-business false positives are worse than a missing enrichment.
    const MATCH_THRESHOLD = 0.4;
    if (!best || bestScore < MATCH_THRESHOLD) {
      results.push({ contractor: c, matched: false, candidates: candidates.map(p => p.displayName?.text) });
      continue;
    }

    let details;
    try {
      details = await placeDetails(best.id);
      apiCalls++;
      await sleep(REQUEST_DELAY_MS);
    } catch (e) {
      results.push({ contractor: c, matched: true, matchScore: bestScore, error: `details failed: ${e.message}` });
      continue;
    }

    const website = details.websiteUri || null;
    let siteAlive = null;
    if (website && !DISCOVERY) siteAlive = await checkSiteAlive(website);

    results.push({
      contractor: c,
      matched: true,
      matchScore: bestScore,
      placeId: details.id,
      displayName: details.displayName?.text,
      website,
      siteAlive,
      phone: details.nationalPhoneNumber || null,
      rating: details.rating ?? null,
      reviewCount: details.userRatingCount ?? 0,
      businessStatus: details.businessStatus || null,
      reviewLastDate: mostRecentReviewDate(details.reviews)
    });
  }

  log(`\nAPI calls made: ${apiCalls}`);

  if (DISCOVERY) {
    log('\n===== DISCOVERY: RAW MATCH RESULTS =====');
    results.forEach((r, i) => {
      log(`\n[${i}] ${r.contractor.entity_name} (${r.contractor.city}, ${r.contractor.county})`);
      if (r.error) { log(`    ERROR: ${r.error}`); return; }
      if (r.skipped) { log(`    SKIPPED (individual license, name-only search unreliable)`); return; }
      if (!r.matched) { log(`    NO MATCH (candidates seen: ${JSON.stringify(r.candidates)})`); return; }
      log(`    matched: "${r.displayName}"  (score ${r.matchScore.toFixed(2)})`);
      log(`    website: ${r.website || '(none)'}`);
      log(`    phone: ${r.phone || '(none)'}`);
      log(`    rating: ${r.rating ?? '(none)'}  reviews: ${r.reviewCount}`);
      log(`    businessStatus: ${r.businessStatus || '(none)'}`);
      log(`    mostRecentReviewDate: ${r.reviewLastDate || '(none)'}`);
    });
    log('\nDiscovery only. No writes. If matches look wrong, tighten MATCH_THRESHOLD');
    log('or add STOPWORDS. Then re-run with DRY_RUN=1.');
    return;
  }

  // ---- Build updates + signals ----
  // PostgREST rejects a batch insert whose objects don't all share the same
  // keys (PGRST102) — and JSON.stringify silently drops keys set to
  // `undefined`, so a mixed matched/unmatched batch fails. Splitting into two
  // uniform-shape batches also protects correctness, not just the API call:
  // an unmatched contractor on this rolling pass may have real website/review
  // data from an earlier pass, and must never be overwritten with nulls just
  // because this particular run didn't find a listing.
  const matchedUpdates = [];
  const touchedOnly = [];
  const signals = [];
  const counts = { matched: 0, unmatched: 0, no_website: 0, closed: 0, stale_reviews: 0, zero_reviews: 0, site_dead: 0 };

  for (const r of results) {
    const cid = r.contractor.id;
    if (r.error) continue;

    if (!r.matched) {
      touchedOnly.push({ id: cid, last_enriched: new Date().toISOString() });
      if (r.skipped) {
        signals.push(makeSignal(cid, 'individual_license_no_web_check', [], 'AWF-3',
          { reason: 'bare person name; name-only search unreliable' }));
      } else {
        counts.unmatched++;
        signals.push(makeSignal(cid, 'no_gbp_listing', [1, 2, 4], 'AWF-3',
          { query: `${r.contractor.entity_name} ${r.contractor.city}` }));
      }
      continue;
    }

    counts.matched++;
    matchedUpdates.push({
      id: cid,
      website: r.website || null,
      gbp_place_id: r.placeId || null,
      phone: r.phone || null,
      review_count: r.reviewCount ?? 0,
      review_last_date: r.reviewLastDate || null,
      last_enriched: new Date().toISOString()
    });

    if (!r.website) {
      counts.no_website++;
      signals.push(makeSignal(cid, 'no_website', [1, 2], 'AWF-3', { place_id: r.placeId }));
    } else if (r.siteAlive === false) {
      counts.site_dead++;
      signals.push(makeSignal(cid, 'site_dead', [1, 2, 4], 'AWF-3', { website: r.website }));
    }

    if (!r.reviewCount) {
      counts.zero_reviews++;
      signals.push(makeSignal(cid, 'zero_reviews', [1, 2], 'AWF-3', { place_id: r.placeId }));
    } else {
      const age = monthsAgo(r.reviewLastDate);
      if (age !== null && age >= REVIEW_STALE_MONTHS) {
        counts.stale_reviews++;
        signals.push(makeSignal(cid, 'reviews_stale_12mo', [1, 2], 'AWF-3',
          { last_review: r.reviewLastDate, months_stale: age }));
      }
    }

    if (r.businessStatus === 'CLOSED_PERMANENTLY') {
      counts.closed++;
      signals.push(makeSignal(cid, 'business_closed_permanently', [4, 10], 'AWF-3', { place_id: r.placeId }));
    } else if (r.businessStatus === 'CLOSED_TEMPORARILY') {
      signals.push(makeSignal(cid, 'business_closed_temporarily', [4], 'AWF-3', { place_id: r.placeId }));
    }
  }

  log('\n===== SUMMARY =====');
  log(`  contractors processed:  ${results.length}`);
  log(`  matched to a listing:   ${counts.matched}`);
  log(`  no GBP listing found:   ${counts.unmatched}`);
  log(`  matched, no website:    ${counts.no_website}`);
  log(`  matched, site unreach.: ${counts.site_dead}`);
  log(`  zero reviews:           ${counts.zero_reviews}`);
  log(`  reviews stale 12mo+:    ${counts.stale_reviews}`);
  log(`  business closed perm.:  ${counts.closed}`);
  log(`  signals to write:       ${signals.length}`);

  if (DRY_RUN) {
    log('\nDRY_RUN=1 -> nothing written.');
    if (matchedUpdates[0]) log('Sample matched update: ' + JSON.stringify(matchedUpdates[0]));
    if (touchedOnly[0]) log('Sample touch-only update: ' + JSON.stringify(touchedOnly[0]));
    if (signals[0]) log('Sample signal: ' + JSON.stringify(signals[0]));
    return;
  }

  log('\nUpdating matched contractors...');
  // PATCH, not POST-upsert: acq_contractors.id is GENERATED ALWAYS AS
  // IDENTITY, which Postgres refuses to write to even inside an upsert's
  // underlying INSERT — every other table in this system upserts by a
  // natural key (license_no, document_no, match_key) and never touches the
  // surrogate id. This script is the first one updating pre-existing rows by
  // their own id, which is a plain UPDATE, not an upsert, so PATCH is both
  // the fix and the semantically correct call.
  for (const u of matchedUpdates) {
    const { id, ...fields } = u;
    await sb('PATCH', `acq_contractors?id=eq.${id}`, fields, { Prefer: 'return=minimal' });
  }

  log('Touching unmatched/skipped contractors (last_enriched only)...');
  for (const u of touchedOnly) {
    const { id, ...fields } = u;
    await sb('PATCH', `acq_contractors?id=eq.${id}`, fields, { Prefer: 'return=minimal' });
  }

  if (signals.length) {
    log('Inserting signals...');
    for (let i = 0; i < signals.length; i += CHUNK) {
      await sb('POST', 'acq_signals', signals.slice(i, i + CHUNK),
        { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    }
  }

  log('\n===== RUN SUMMARY =====');
  log(`  batchSize:          ${rows.length}`);
  log(`  apiCalls:           ${apiCalls}`);
  log(`  matchedUpdated:     ${matchedUpdates.length}`);
  log(`  unmatchedTouched:   ${touchedOnly.length}`);
  log(`  signalsWritten:     ${signals.length}`);
  log(`  remaining universe left to enrich: run again to continue the rolling pass.`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
