#!/usr/bin/env node
/**
 * AWF-1: Contractor Universe Build
 * Downloads the Florida DBPR construction licensee extract, filters to CAC/CMC
 * in the 8 target counties, and upserts into Supabase (acq_contractors,
 * acq_licenses, acq_signals).
 *
 * Runs on a GitHub Actions runner: 7GB RAM, no execution-record persistence,
 * so the ~60MB source file is a non-issue. The file is streamed to disk and
 * read line by line; the full row set is never held in memory.
 *
 * Modes:
 *   DISCOVERY=1  -> prints class census + county codes, writes NOTHING
 *   (default)    -> full load
 *   DRY_RUN=1    -> parses and reports counts, writes NOTHING
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const https = require('https');

// ============ CONFIG ============
const SOURCE_URL = 'https://www2.myfloridalicense.com/sto/file_download/extracts//CONSTRUCTIONLICENSE_1.csv';
const LICENSE_CLASSES = ['CAC', 'CMC'];

// Raw DBPR county code -> { county, region }
// Confirmed from real file rows: 60 = Palm Beach (Boynton Beach).
// Fill the rest from a DISCOVERY=1 run, then commit.
const COUNTY_CODE_MAP = {
  // '60': { county: 'Palm Beach', region: 'SFL' },
};

// TRUE column layout, verified against real rows 2026-07-31.
// The published DBPR layout page is wrong: class prefix is alone in col 1,
// digits-only number in col 12, full assembled license number in col 20.
const COL = {
  boardNumber: 0, classPrefix: 1, licenseeName: 2, dba: 3,
  addr1: 5, addr2: 6, addr3: 7, city: 8, state: 9, zip: 10,
  countyCode: 11, licenseDigits: 12, primaryStatus: 13, secondaryStatus: 14,
  originalIssue: 15, effectiveDate: 16, expirationDate: 17, licenseFull: 20
};

const CHUNK = 500;
// ================================

const DISCOVERY = process.env.DISCOVERY === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

function log(...args) { console.log(...args); }

function parseLine(line) {
  const row = [];
  let field = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else { field += c; }
  }
  row.push(field);
  return row;
}

function toISODate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function normalizeMatchKey(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/[.,'&\/\\-]+/g, ' ')
    .replace(/\b(LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LC|PLLC|PA|PLC|LTD|LLP|LP)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'KDM-AWF1/1.0' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function sb(method, pathAndQuery, body, extraHeaders) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: Object.assign({
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    }, extraHeaders || {}),
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${pathAndQuery} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sbGetAll(pathAndQuery) {
  const out = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Range: `${offset}-${offset + PAGE - 1}`,
        'Range-Unit': 'items'
      }
    });
    if (!res.ok) throw new Error(`Supabase GET ${pathAndQuery} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

async function main() {
  const tmp = path.join(os.tmpdir(), 'construction_license.csv');
  log('Downloading DBPR extract...');
  await download(SOURCE_URL, tmp);
  const bytes = fs.statSync(tmp).size;
  log(`Downloaded ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  if (bytes < 1000000) throw new Error('File suspiciously small; aborting.');

  const matched = [];
  const classCensus = {};
  let totalRows = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(tmp, { encoding: 'latin1' }),
    crlfDelay: Infinity
  });

  for await (const rawLine of rl) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    totalRows++;
    if (DISCOVERY) {
      const r = parseLine(line);
      const cls = String(r[COL.classPrefix] || '').trim().toUpperCase() || '(blank)';
      classCensus[cls] = (classCensus[cls] || 0) + 1;
      if (LICENSE_CLASSES.includes(cls)) matched.push(r);
    } else {
      if (!LICENSE_CLASSES.some(c => line.includes('"' + c + '"'))) continue;
      const r = parseLine(line);
      const cls = String(r[COL.classPrefix] || '').trim().toUpperCase();
      if (LICENSE_CLASSES.includes(cls)) matched.push(r);
    }
  }
  fs.unlinkSync(tmp);
  log(`Parsed ${totalRows} rows; ${matched.length} CAC/CMC statewide.`);

  if (DISCOVERY) {
    const byCounty = {};
    for (const r of matched) {
      const code = String(r[COL.countyCode] || '').trim();
      const city = String(r[COL.city] || '').trim().toUpperCase();
      byCounty[code] = byCounty[code] || { count: 0, cities: {} };
      byCounty[code].count++;
      byCounty[code].cities[city] = (byCounty[code].cities[city] || 0) + 1;
    }
    log('\n===== CLASS CENSUS =====');
    Object.entries(classCensus).sort((a, b) => b[1] - a[1])
      .forEach(([cls, n]) => log(`  ${cls}: ${n}`));
    log('\n===== COUNTY CODES (CAC/CMC rows only) =====');
    Object.entries(byCounty)
      .map(([code, v]) => ({
        code, count: v.count,
        cities: Object.entries(v.cities).sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([c, n]) => `${c} (${n})`).join(', ')
      }))
      .sort((a, b) => b.count - a.count)
      .forEach(c => log(`  code ${c.code}: ${c.count} licenses | ${c.cities}`));
    log('\n===== SAMPLE CAC/CMC ROWS =====');
    matched.slice(0, 3).forEach((r, i) => log(`  [${i}] ${JSON.stringify(r)}`));
    log('\nFill COUNTY_CODE_MAP in scripts/awf1.js from the county codes above, commit, then run without DISCOVERY.');
    return;
  }

  if (Object.keys(COUNTY_CODE_MAP).length === 0) {
    throw new Error('COUNTY_CODE_MAP is empty. Run with DISCOVERY=1 first, fill the map, commit.');
  }

  const pullDate = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const r of matched) {
    const code = String(r[COL.countyCode] || '').trim();
    const geo = COUNTY_CODE_MAP[code];
    if (!geo) continue;
    const cls = String(r[COL.classPrefix] || '').trim().toUpperCase();
    const licFull = String(r[COL.licenseFull] || '').trim().toUpperCase()
      || (cls + String(r[COL.licenseDigits] || '').trim());
    const licenseeName = String(r[COL.licenseeName] || '').trim();
    const dba = String(r[COL.dba] || '').trim();
    const entityName = dba || licenseeName;
    rows.push({
      license_no: licFull,
      class: cls,
      class_code: cls,
      primary_status: String(r[COL.primaryStatus] || '').trim() || null,
      secondary_status: String(r[COL.secondaryStatus] || '').trim() || null,
      original_issue_date: toISODate(r[COL.originalIssue]),
      effective_date: toISODate(r[COL.effectiveDate]),
      expiration_date: toISODate(r[COL.expirationDate]),
      qualifier_name: dba ? licenseeName : null,
      county_code: code,
      entity_name: entityName,
      dba: dba || null,
      match_key: normalizeMatchKey(entityName),
      county: geo.county,
      region: geo.region,
      address: [r[COL.addr1], r[COL.addr2], r[COL.addr3]].map(x => String(x || '').trim()).filter(Boolean).join(', ') || null,
      city: String(r[COL.city] || '').trim() || null,
      state: String(r[COL.state] || '').trim() || null,
      zip: String(r[COL.zip] || '').trim() || null
    });
  }
  log(`${rows.length} rows in the 8 target counties.`);
  if (rows.length === 0) throw new Error('0 rows after county filter. Check COUNTY_CODE_MAP.');

  // Contractors
  const seen = new Map();
  for (const r of rows) {
    const key = r.match_key + '||' + r.county_code;
    if (!seen.has(key)) {
      seen.set(key, {
        match_key: r.match_key, entity_name: r.entity_name, dba: r.dba,
        region: r.region, county: r.county, county_code: r.county_code,
        address: r.address, city: r.city, state: r.state, zip: r.zip,
        updated_at: new Date().toISOString()
      });
    }
  }
  const contractors = [...seen.values()];
  log(`${contractors.length} distinct contractors.`);

  if (DRY_RUN) {
    log('DRY_RUN=1 -> nothing written. Sample contractor:', JSON.stringify(contractors[0]));
    log('Sample license:', JSON.stringify(rows[0]));
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.');
  }

  log('Upserting contractors...');
  for (let i = 0; i < contractors.length; i += CHUNK) {
    await sb('POST', 'acq_contractors?on_conflict=match_key,county_code',
      contractors.slice(i, i + CHUNK),
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
    log(`  ${Math.min(i + CHUNK, contractors.length)}/${contractors.length}`);
  }

  log('Fetching contractor IDs...');
  const idRows = await sbGetAll('acq_contractors?select=id,match_key,county_code');
  const idMap = new Map(idRows.map(r => [r.match_key + '||' + r.county_code, r.id]));
  log(`  ${idRows.length} contractors in table.`);

  log('Fetching existing licenses...');
  const existingRows = await sbGetAll('acq_licenses?select=license_no,present_in_last_pull');
  const existingSet = new Set(existingRows.map(r => r.license_no));
  const currentSet = new Set(rows.map(r => r.license_no));
  log(`  ${existingRows.length} licenses on record.`);

  const licenseUpserts = [];
  const signals = [];
  let unmatched = 0;
  for (const r of rows) {
    const cid = idMap.get(r.match_key + '||' + r.county_code) ?? null;
    if (cid === null) unmatched++;
    licenseUpserts.push({
      license_no: r.license_no, class: r.class, class_code: r.class_code,
      primary_status: r.primary_status, secondary_status: r.secondary_status,
      original_issue_date: r.original_issue_date, effective_date: r.effective_date,
      expiration_date: r.expiration_date, qualifier_name: r.qualifier_name,
      contractor_id: cid, county_code: r.county_code,
      present_in_last_pull: true, last_seen_pull: pullDate,
      updated_at: new Date().toISOString()
    });
    if (!existingSet.has(r.license_no)) {
      signals.push({
        contractor_id: cid, license_no: r.license_no,
        signal_type: 'license_new', strategy_ids: [1, 2],
        payload: { class: r.class, county: r.county, original_issue_date: r.original_issue_date },
        source: 'AWF-1'
      });
    }
  }

  // DBPR excludes delinquent/void licenses from the file, so a license
  // vanishing between pulls IS the distress signal (Strategies 4, 10).
  const dropped = existingRows
    .filter(r => r.present_in_last_pull !== false && !currentSet.has(r.license_no))
    .map(r => r.license_no);
  for (const lic of dropped) {
    signals.push({
      contractor_id: null, license_no: lic, signal_type: 'license_dropped',
      strategy_ids: [4, 10], payload: { pull_date: pullDate }, source: 'AWF-1'
    });
  }

  log('Upserting licenses...');
  for (let i = 0; i < licenseUpserts.length; i += CHUNK) {
    await sb('POST', 'acq_licenses?on_conflict=license_no',
      licenseUpserts.slice(i, i + CHUNK),
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
    log(`  ${Math.min(i + CHUNK, licenseUpserts.length)}/${licenseUpserts.length}`);
  }

  if (signals.length) {
    log(`Inserting ${signals.length} signals...`);
    for (let i = 0; i < signals.length; i += CHUNK) {
      await sb('POST', 'acq_signals', signals.slice(i, i + CHUNK),
        { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    }
  }

  if (dropped.length) {
    log(`Marking ${dropped.length} dropped licenses...`);
    for (let i = 0; i < dropped.length; i += CHUNK) {
      const list = dropped.slice(i, i + CHUNK).map(l => `"${l}"`).join(',');
      await sb('PATCH', `acq_licenses?license_no=in.(${list})`,
        { present_in_last_pull: false, updated_at: new Date().toISOString() },
        { Prefer: 'return=minimal' });
    }
  }

  log('\n===== RUN SUMMARY =====');
  log(`  pullDate:                  ${pullDate}`);
  log(`  contractors:               ${contractors.length}`);
  log(`  licenseRows:               ${licenseUpserts.length}`);
  log(`  newLicenses:               ${signals.filter(s => s.signal_type === 'license_new').length}`);
  log(`  droppedLicenses:           ${dropped.length}`);
  log(`  rowsWithoutContractorMatch: ${unmatched}`);
  const pct = licenseUpserts.length ? (unmatched / licenseUpserts.length * 100) : 0;
  if (pct > 1) log(`  WARNING: ${pct.toFixed(1)}% unmatched — check match_key normalization.`);
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
