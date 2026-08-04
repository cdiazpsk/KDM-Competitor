#!/usr/bin/env node
/**
 * AWF-4: Miami-Dade Permit Activity Puller (pilot county)
 *
 * Confirmed via awf4-explore.js against the live service:
 *   https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0
 *   139,225 records, PermitIssuedDate range 2024-08-03 to 2026-08-02 (2-year window).
 *
 * Unlike AWF-2 and AWF-3, this source needs no fuzzy name matching: the
 * ContractorNumber field on each permit IS the DBPR license number, which we
 * already have exact in acq_licenses. Matching is a direct equality join, not
 * a guess — the single biggest reliability upgrade of any AWF-series source
 * so far, since every prior matcher had to solve fuzzy identity and every one
 * of them turned up a real false positive during testing.
 *
 * Rather than download all 139k permits, the WHERE filter is pushed to the
 * API itself: ContractorNumber IN (our known license numbers), batched and
 * sent via POST to stay well under any URL length limit. Only permits pulled
 * by contractors already in our universe come back.
 *
 * Modes:
 *   DISCOVERY=1 -> one batch only, prints matched vs unmatched counts and
 *                  sample rows. No writes.
 *   DRY_RUN=1   -> full pull, real signal-relevant stats, no writes.
 *   (default)   -> full pull, writes to acq_permits.
 */

const SERVICE_URL = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0';
const LICENSE_BATCH_SIZE = 150;   // license numbers per IN-clause, kept modest and safe
const PAGE_SIZE = 2000;           // ArcGIS result page size per query
const CHUNK = 500;                // Supabase write batch size

const DISCOVERY = process.env.DISCOVERY === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const log = (...a) => console.log(...a);

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

// Single quotes inside a license number would break the WHERE clause; none
// are expected in a DBPR license number, but escape defensively anyway.
function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

function buildInClause(field, values) {
  return `${field} IN (${values.map(v => `'${sqlEscape(v)}'`).join(',')})`;
}

async function queryPermits(where, resultOffset) {
  const body = new URLSearchParams({
    f: 'json',
    where,
    outFields: '*',
    resultOffset: String(resultOffset || 0),
    resultRecordCount: String(PAGE_SIZE)
  });
  const res = await fetch(`${SERVICE_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`ArcGIS query ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  if (j.error) throw new Error(`ArcGIS query error: ${JSON.stringify(j.error)}`);
  return j;
}

async function queryAllForBatch(licenseBatch) {
  const where = buildInClause('ContractorNumber', licenseBatch);
  let offset = 0;
  const all = [];
  for (;;) {
    const page = await queryPermits(where, offset);
    const feats = page.features || [];
    all.push(...feats);
    if (feats.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

function toDate(v) {
  if (v === null || v === undefined) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function toNumeric(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY required.');

  log('Loading Miami-Dade license numbers from acq_licenses...');
  const licenseRows = await sbGetAll(
    "acq_licenses?select=license_no,contractor_id&county_code=eq.23"
  );
  const licenseMap = new Map(licenseRows.map(r => [r.license_no, r.contractor_id]));
  const allLicenses = [...licenseMap.keys()];
  log(`  ${allLicenses.length} Miami-Dade CAC/CMC license numbers loaded.`);
  if (allLicenses.length === 0) throw new Error('No Miami-Dade licenses found — check county_code mapping (23).');

  const batches = [];
  for (let i = 0; i < allLicenses.length; i += LICENSE_BATCH_SIZE) {
    batches.push(allLicenses.slice(i, i + LICENSE_BATCH_SIZE));
  }
  log(`  Querying in ${batches.length} batches of up to ${LICENSE_BATCH_SIZE} license numbers each.`);

  const useBatches = DISCOVERY ? batches.slice(0, 1) : batches;
  const allPermits = [];
  for (let i = 0; i < useBatches.length; i++) {
    const feats = await queryAllForBatch(useBatches[i]);
    allPermits.push(...feats);
    log(`  batch ${i + 1}/${useBatches.length}: ${feats.length} permits (running total ${allPermits.length})`);
  }

  const matched = allPermits.filter(f => licenseMap.has(f.attributes.ContractorNumber));
  const unmatchedLicenseValues = new Set(
    allPermits.filter(f => !licenseMap.has(f.attributes.ContractorNumber)).map(f => f.attributes.ContractorNumber)
  );

  log(`\nPermits returned: ${allPermits.length}`);
  log(`Matched to a known license: ${matched.length}`);
  if (unmatchedLicenseValues.size) {
    log(`WARNING: ${unmatchedLicenseValues.size} distinct ContractorNumber values in results did not match our license list.`);
    log(`  This should not happen since we queried BY those exact numbers — sample: ${[...unmatchedLicenseValues].slice(0, 5).join(', ')}`);
  }

  if (DISCOVERY) {
    log('\n===== SAMPLE MATCHED PERMITS =====');
    matched.slice(0, 5).forEach((f, i) => log(`  [${i}] ${JSON.stringify(f.attributes)}`));
    log('\nDiscovery covered 1 of ' + batches.length + ' license batches only. Re-run with DRY_RUN=1 for the full pull.');
    return;
  }

  const rows = matched.map(f => {
    const a = f.attributes;
    return {
      source_permit_id: a.GlobalID,
      permit_number: a.PermitNumber || null,
      process_number: a.ProcessNumber || null,
      contractor_id: licenseMap.get(a.ContractorNumber) ?? null,
      license_no: a.ContractorNumber || null,
      contractor_name_raw: a.ContractorName || null,
      permit_type: a.PermitType || null,
      application_type: a.ApplicationTypeDescription || null,
      residential_commercial: a.ResidentialCommercial || null,
      estimated_value: toNumeric(a.EstimatedValue),
      proposed_use: a.ProposedUseDescription || null,
      category_1: a.Category1 || null,
      category_1_desc: a.CategoryDescription1 || null,
      property_address: a.PropertyAddress || null,
      folio_number: a.FolioNumber || null,
      issue_date: toDate(a.PermitIssuedDate),
      county: 'Miami-Dade',
      updated_at: new Date().toISOString()
    };
  });

  log(`\nRows to write: ${rows.length}`);
  const withContractorId = rows.filter(r => r.contractor_id !== null).length;
  log(`  with resolved contractor_id: ${withContractorId}`);
  log(`  without (license matched but contractor_id lookup missed): ${rows.length - withContractorId}`);

  const licensesWithPermits = new Set(rows.map(r => r.license_no));
  const licensesWithoutPermits = allLicenses.filter(l => !licensesWithPermits.has(l));
  log(`  distinct licenses WITH at least one permit: ${licensesWithPermits.size}`);
  log(`  distinct licenses with ZERO permits in this 2-year window: ${licensesWithoutPermits.length}`);

  const commercialCount = rows.filter(r => r.residential_commercial === 'C').length;
  log(`  commercial-flagged permits: ${commercialCount} of ${rows.length}`);

  if (DRY_RUN) {
    log('\nDRY_RUN=1 -> nothing written.');
    if (rows[0]) log('Sample row: ' + JSON.stringify(rows[0]));
    return;
  }

  log('\nUpserting permits...');
  for (let i = 0; i < rows.length; i += CHUNK) {
    await sb('POST', 'acq_permits?on_conflict=source_permit_id', rows.slice(i, i + CHUNK),
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
    log(`  ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }

  log('\n===== RUN SUMMARY =====');
  log(`  licensesQueried:            ${allLicenses.length}`);
  log(`  permitsWritten:             ${rows.length}`);
  log(`  licensesWithPermits:        ${licensesWithPermits.size}`);
  log(`  licensesWithZeroPermits:    ${licensesWithoutPermits.length}`);
  log(`  commercialShare:            ${rows.length ? (commercialCount / rows.length * 100).toFixed(1) : 0}%`);
  log(`  Run permit_signals.sql next to derive permits_dead_24mo and concentration signals.`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
