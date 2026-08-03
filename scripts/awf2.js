#!/usr/bin/env node
/**
 * AWF-2: Sunbiz Corporate Enrichment
 *
 * Downloads the Florida Division of Corporations quarterly bulk file over SFTP,
 * streams the fixed-width records (1440 chars each), keeps only entities whose
 * normalized name matches a contractor in acq_contractors, and writes entities,
 * principals, and succession signals to Supabase.
 *
 * Source: sftp.floridados.gov  doc/quarterly/cor/cordata.zip
 * Credentials are public and published by the Division of Corporations.
 *
 * Runs on GitHub Actions: the uncompressed data is several GB, so nothing is
 * ever fully materialized. The zip is streamed entry by entry, line by line.
 *
 * Modes:
 *   DISCOVERY=1 -> reports file inventory, record shape, match rate. No writes.
 *   DRY_RUN=1   -> full parse and match, reports counts. No writes.
 *   (default)   -> full load
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const SftpClient = require('ssh2-sftp-client');
const unzipper = require('unzipper');

// ============ CONFIG ============
const SFTP_HOST = 'sftp.floridados.gov';
const SFTP_USER = 'Public';
const SFTP_PASS = 'PubAccess1845!';
const SFTP_DIR = '/doc/quarterly/cor';
const SFTP_FILE = 'cordata.zip';

// Fixed-width layout, per the Division of Corporations file definition.
// Positions in the published doc are 1-based; converted to 0-based here.
const RECORD_LEN = 1440;
const F = (start, len) => [start - 1, start - 1 + len];
const FIELD = {
  documentNo:      F(1, 12),
  entityName:      F(13, 192),
  status:          F(205, 1),
  filingType:      F(206, 15),
  address1:        F(221, 42),
  city:            F(305, 28),
  state:           F(333, 2),
  zip:             F(335, 10),
  fileDate:        F(473, 8),
  feiNumber:       F(481, 14),
  moreThanSix:     F(495, 1),
  lastTxnDate:     F(496, 8),
  reportYear1:     F(506, 4),
  reportDate1:     F(511, 8),
  reportYear2:     F(519, 4),
  reportDate2:     F(524, 8),
  reportYear3:     F(532, 4),
  reportDate3:     F(537, 8),
  agentName:       F(545, 42),
  agentType:       F(587, 1)
};
// Officers repeat 6 times with a 128-char stride starting at position 669.
const OFFICER_BASE = 669;
const OFFICER_STRIDE = 128;
const OFFICER_FIELDS = { title: [0, 4], type: [4, 5], name: [5, 47], address: [47, 89], city: [89, 117], state: [117, 119] };

const CHUNK = 500;
// ================================

const DISCOVERY = process.env.DISCOVERY === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const log = (...a) => console.log(...a);

function normalizeMatchKey(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/[.,'&\/\\-]+/g, ' ')
    .replace(/\b(LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LC|PLLC|PA|PLC|LTD|LLP|LP)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function surnameOf(name) {
  // Sunbiz officer names are usually "LAST, FIRST MIDDLE" or "LAST FIRST".
  const s = String(name || '').trim().toUpperCase();
  if (!s) return null;
  if (s.includes(',')) return s.split(',')[0].trim().replace(/\s+/g, ' ');
  const parts = s.split(/\s+/);
  return parts.length > 1 ? parts[0] : s;
}

function toISO(yyyymmdd) {
  const s = String(yyyymmdd || '').trim();
  if (!/^\d{8}$/.test(s)) return null;
  const y = s.slice(0, 4), m = s.slice(4, 6), d = s.slice(6, 8);
  if (y === '0000' || m === '00' || d === '00') return null;
  return `${y}-${m}-${d}`;
}

const cut = (rec, [a, b]) => rec.slice(a, b).trim();

function parseRecord(rec) {
  const out = {};
  for (const [k, span] of Object.entries(FIELD)) out[k] = cut(rec, span);
  out.officers = [];
  for (let i = 0; i < 6; i++) {
    const base = OFFICER_BASE - 1 + i * OFFICER_STRIDE;
    const seg = rec.slice(base, base + OFFICER_STRIDE);
    const name = seg.slice(OFFICER_FIELDS.name[0], OFFICER_FIELDS.name[1]).trim();
    if (!name) continue;
    out.officers.push({
      slot: i + 1,
      title: seg.slice(OFFICER_FIELDS.title[0], OFFICER_FIELDS.title[1]).trim(),
      type: seg.slice(OFFICER_FIELDS.type[0], OFFICER_FIELDS.type[1]).trim(),
      name,
      city: seg.slice(OFFICER_FIELDS.city[0], OFFICER_FIELDS.city[1]).trim(),
      state: seg.slice(OFFICER_FIELDS.state[0], OFFICER_FIELDS.state[1]).trim()
    });
  }
  return out;
}

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
  const out = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Range: `${offset}-${offset + PAGE - 1}`,
        'Range-Unit': 'items'
      }
    });
    if (!res.ok) throw new Error(`Supabase GET ${q} -> ${res.status}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

function currentQuarter() {
  const d = new Date();
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

async function main() {
  // ---- 1. Load the contractor universe we're matching against ----
  let contractors = [];
  if (!DISCOVERY || SUPABASE_URL) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required (AWF-2 matches against acq_contractors).');
    }
    log('Loading contractor universe...');
    contractors = await sbGetAll('acq_contractors?select=id,match_key,entity_name,county');
    log(`  ${contractors.length} contractors loaded.`);
  }
  const byKey = new Map();
  for (const c of contractors) {
    if (!byKey.has(c.match_key)) byKey.set(c.match_key, []);
    byKey.get(c.match_key).push(c);
  }

  // ---- 2. Download the quarterly zip over SFTP ----
  const tmpZip = path.join(os.tmpdir(), SFTP_FILE);
  const sftp = new SftpClient();
  log(`Connecting to ${SFTP_HOST}...`);
  await sftp.connect({ host: SFTP_HOST, port: 22, username: SFTP_USER, password: SFTP_PASS, readyTimeout: 60000 });
  const listing = await sftp.list(SFTP_DIR);
  log('Remote directory contents:');
  listing.forEach(f => log(`  ${f.name}  ${(f.size / 1024 / 1024).toFixed(1)} MB  ${new Date(f.modifyTime).toISOString().slice(0, 10)}`));
  const target = listing.find(f => f.name.toLowerCase() === SFTP_FILE.toLowerCase());
  if (!target) throw new Error(`${SFTP_FILE} not found in ${SFTP_DIR}`);
  log(`Downloading ${SFTP_FILE} (${(target.size / 1024 / 1024).toFixed(1)} MB)...`);
  await sftp.fastGet(`${SFTP_DIR}/${SFTP_FILE}`, tmpZip);
  await sftp.end();
  log('Download complete.');

  // ---- 3. Stream the zip, entry by entry, line by line ----
  const matchedEntities = [];   // entities whose name hits a contractor
  const keyHits = new Map();    // match_key -> [entity records]
  let totalRecords = 0;
  let shortRecords = 0;
  const sampleRecords = [];
  const entryNames = [];

  const directory = await unzipper.Open.file(tmpZip);
  log(`Zip contains ${directory.files.length} entries.`);

  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    entryNames.push(`${entry.path} (${(entry.uncompressedSize / 1024 / 1024).toFixed(0)} MB)`);
    log(`  Reading ${entry.path}...`);
    const rl = readline.createInterface({ input: entry.stream(), crlfDelay: Infinity });
    for await (const rawLine of rl) {
      const rec = rawLine.replace(/\r$/, '');
      if (!rec.trim()) continue;
      totalRecords++;
      if (rec.length < RECORD_LEN - 10) { shortRecords++; if (shortRecords <= 3) sampleRecords.push(rec.slice(0, 220)); continue; }
      const name = cut(rec, FIELD.entityName);
      const key = normalizeMatchKey(name);
      if (!key || !byKey.has(key)) continue;
      const parsed = parseRecord(rec);
      parsed.match_key = key;
      if (!keyHits.has(key)) keyHits.set(key, []);
      keyHits.get(key).push(parsed);
      matchedEntities.push(parsed);
      if (sampleRecords.length < 3 && DISCOVERY) sampleRecords.push(JSON.stringify(parsed).slice(0, 600));
    }
  }
  fs.unlinkSync(tmpZip);

  const matchedKeys = keyHits.size;
  const ambiguousKeys = [...keyHits.entries()].filter(([, v]) => v.length > 1);
  log(`\nScanned ${totalRecords} corporate records.`);
  log(`Matched ${matchedEntities.length} entity records across ${matchedKeys} distinct contractor names.`);
  log(`Contractors with no corporate match: ${byKey.size - matchedKeys} of ${byKey.size} names.`);
  log(`Ambiguous names (2+ corporations): ${ambiguousKeys.length}`);
  if (shortRecords) log(`WARNING: ${shortRecords} records shorter than expected ${RECORD_LEN} chars.`);

  if (DISCOVERY) {
    log('\n===== ZIP ENTRIES =====');
    entryNames.forEach(n => log('  ' + n));
    log('\n===== SAMPLE MATCHED RECORDS =====');
    sampleRecords.forEach((s, i) => log(`  [${i}] ${s}`));
    log('\n===== SAMPLE MATCHES =====');
    [...keyHits.entries()].slice(0, 10).forEach(([k, v]) => {
      const e = v[0];
      log(`  ${k} -> ${e.entityName} | doc ${e.documentNo} | status ${e.status} | filed ${e.fileDate} | ${e.officers.length} officers`);
      e.officers.forEach(o => log(`      ${o.slot}. ${o.title.padEnd(4)} ${o.name}`));
    });
    log('\nDiscovery only. No writes. Re-run with DRY_RUN=1 or live.');
    return;
  }

  // ---- 4. Build rows ----
  const quarter = currentQuarter();
  const entityRows = [];
  const principalRows = [];
  const reviewRows = [];
  const signals = [];

  for (const [key, list] of keyHits.entries()) {
    const cands = byKey.get(key) || [];
    // One contractor row per county; a single corporation legitimately serves
    // all of them. Ambiguity is on the CORPORATION side (2+ corps, one name).
    if (list.length > 1) {
      for (const c of cands) {
        reviewRows.push({
          contractor_id: c.id, match_key: key, reason: 'ambiguous',
          candidates: list.map(e => ({ document_no: e.documentNo, entity_name: e.entityName, status: e.status, file_date: e.fileDate, city: e.city }))
        });
      }
      continue; // never auto-resolve
    }
    const e = list[0];
    const primary = cands[0] || null;
    entityRows.push({
      document_no: e.documentNo,
      entity_name: e.entityName,
      match_key: key,
      status: e.status || null,
      filing_type: e.filingType || null,
      file_date: toISO(e.fileDate),
      fei_number: e.feiNumber || null,
      address: e.address1 || null,
      city: e.city || null,
      state: e.state || null,
      zip: e.zip || null,
      registered_agent: e.agentName || null,
      agent_type: e.agentType || null,
      report_year_1: /^\d{4}$/.test(e.reportYear1) ? Number(e.reportYear1) : null,
      report_date_1: toISO(e.reportDate1),
      report_year_2: /^\d{4}$/.test(e.reportYear2) ? Number(e.reportYear2) : null,
      report_date_2: toISO(e.reportDate2),
      report_year_3: /^\d{4}$/.test(e.reportYear3) ? Number(e.reportYear3) : null,
      report_date_3: toISO(e.reportDate3),
      officer_count: e.officers.length,
      more_than_six_flag: e.moreThanSix || null,
      contractor_id: primary ? primary.id : null,
      source_quarter: quarter,
      updated_at: new Date().toISOString()
    });

    for (const o of e.officers) {
      principalRows.push({
        document_no: e.documentNo,
        slot: o.slot,
        name: o.name,
        name_norm: o.name.toUpperCase().replace(/\s+/g, ' ').trim(),
        surname_norm: surnameOf(o.name),
        title: o.title || null,
        person_type: o.type || null,
        city: o.city || null,
        state: o.state || null,
        contractor_id: primary ? primary.id : null,
        source_quarter: quarter,
        updated_at: new Date().toISOString()
      });
    }

    // ---- Succession signals ----
    const people = e.officers.filter(o => o.type !== 'C');
    const cid = primary ? primary.id : null;

    if (people.length === 1) {
      signals.push({
        contractor_id: cid, license_no: null, signal_type: 'sole_officer',
        strategy_ids: [1], source: 'AWF-2',
        payload: { document_no: e.documentNo, officer: people[0].name, title: people[0].title }
      });
    }

    // Two-generation pattern: 2+ people sharing a surname, different titles.
    const bySurname = {};
    for (const p of people) {
      const sn = surnameOf(p.name);
      if (!sn) continue;
      (bySurname[sn] = bySurname[sn] || []).push(p);
    }
    for (const [sn, group] of Object.entries(bySurname)) {
      if (group.length >= 2 && new Set(group.map(g => g.title)).size > 1) {
        signals.push({
          contractor_id: cid, license_no: null, signal_type: 'two_generation_pattern',
          strategy_ids: [11], source: 'AWF-2',
          payload: { document_no: e.documentNo, surname: sn, officers: group.map(g => ({ name: g.name, title: g.title })) }
        });
      }
    }

    if (e.status === 'I') {
      signals.push({
        contractor_id: cid, license_no: null, signal_type: 'entity_inactive',
        strategy_ids: [4, 10], source: 'AWF-2',
        payload: { document_no: e.documentNo, entity_name: e.entityName }
      });
    }

    // Annual report lapse: most recent report year is 2+ years stale.
    const ry = Number(e.reportYear1);
    const thisYear = new Date().getUTCFullYear();
    if (ry && thisYear - ry >= 2) {
      signals.push({
        contractor_id: cid, license_no: null, signal_type: 'annual_report_lapsed',
        strategy_ids: [4, 10], source: 'AWF-2',
        payload: { document_no: e.documentNo, last_report_year: ry }
      });
    }

    // Entity 25+ years old: corroborates long-tenure ownership.
    const fd = toISO(e.fileDate);
    if (fd && thisYear - Number(fd.slice(0, 4)) >= 25) {
      signals.push({
        contractor_id: cid, license_no: null, signal_type: 'entity_age_25yr',
        strategy_ids: [1, 2], source: 'AWF-2',
        payload: { document_no: e.documentNo, file_date: fd }
      });
    }
  }

  // Contractors whose name matched nothing at all.
  for (const [key, cands] of byKey.entries()) {
    if (keyHits.has(key)) continue;
    for (const c of cands) {
      reviewRows.push({ contractor_id: c.id, match_key: key, reason: 'no_match', candidates: [] });
    }
  }

  log(`\nEntities to write:   ${entityRows.length}`);
  log(`Principals to write: ${principalRows.length}`);
  log(`Review queue:        ${reviewRows.length} (${reviewRows.filter(r => r.reason === 'ambiguous').length} ambiguous, ${reviewRows.filter(r => r.reason === 'no_match').length} no match)`);
  log(`Signals:             ${signals.length}`);
  const counts = {};
  signals.forEach(s => counts[s.signal_type] = (counts[s.signal_type] || 0) + 1);
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => log(`    ${k}: ${v}`));

  if (DRY_RUN) {
    log('\nDRY_RUN=1 -> nothing written.');
    if (entityRows[0]) log('Sample entity: ' + JSON.stringify(entityRows[0]));
    if (principalRows[0]) log('Sample principal: ' + JSON.stringify(principalRows[0]));
    return;
  }

  // ---- 5. Write ----
  log('\nUpserting entities...');
  for (let i = 0; i < entityRows.length; i += CHUNK) {
    await sb('POST', 'acq_entities?on_conflict=document_no', entityRows.slice(i, i + CHUNK),
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }

  log('Upserting principals...');
  for (let i = 0; i < principalRows.length; i += CHUNK) {
    await sb('POST', 'acq_principals?on_conflict=document_no,slot', principalRows.slice(i, i + CHUNK),
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }

  if (reviewRows.length) {
    log('Writing review queue...');
    for (let i = 0; i < reviewRows.length; i += CHUNK) {
      await sb('POST', 'acq_match_review?on_conflict=contractor_id', reviewRows.slice(i, i + CHUNK),
        { Prefer: 'resolution=merge-duplicates,return=minimal' });
    }
  }

  if (signals.length) {
    log('Inserting signals...');
    for (let i = 0; i < signals.length; i += CHUNK) {
      await sb('POST', 'acq_signals', signals.slice(i, i + CHUNK),
        { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    }
  }

  log('\n===== RUN SUMMARY =====');
  log(`  quarter:            ${quarter}`);
  log(`  recordsScanned:     ${totalRecords}`);
  log(`  entitiesWritten:    ${entityRows.length}`);
  log(`  principalsWritten:  ${principalRows.length}`);
  log(`  reviewQueue:        ${reviewRows.length}`);
  log(`  signalsWritten:     ${signals.length}`);
  const matchPct = byKey.size ? (matchedKeys / byKey.size * 100).toFixed(1) : '0';
  log(`  nameMatchRate:      ${matchPct}%`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
