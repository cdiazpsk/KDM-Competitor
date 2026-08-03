#!/usr/bin/env node
/**
 * AWF-2b: Sunbiz Corporate Event Enrichment
 *
 * Fixes a false-positive class in AWF-2. The corporate data file says an entity
 * is INACTIVE but not WHY. Voluntary dissolution (owner restructured INC -> LLC)
 * is routine housekeeping; administrative dissolution (state killed it for
 * unfiled annual reports) is genuine distress. AWF-2 fired entity_inactive on
 * both, producing 237 signals that were almost entirely noise.
 *
 * This reads corevent.zip, matches events to the entities AWF-2 already wrote,
 * and emits precise signals in place of the blunt one.
 *
 * Source: sftp.floridados.gov  doc/Quarterly/Cor/corevent.zip  (~180 MB)
 *
 * The event file layout is not published anywhere reachable, so DISCOVERY mode
 * locates the fields from real data: it finds where our known 12-char document
 * numbers sit, then dumps raw records so the layout can be read off directly.
 *
 * Modes:
 *   DISCOVERY=1 -> locate fields, dump samples, census event codes. No writes.
 *   DRY_RUN=1   -> full parse + signal generation, counts only. No writes.
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
const SFTP_DIR_CANDIDATES = process.env.SFTP_DIR
  ? [process.env.SFTP_DIR]
  : ['doc/Quarterly/Cor', './doc/Quarterly/Cor', 'doc/quarterly/cor'];
const SFTP_FILE = 'corevent.zip';

// Field positions are set after a DISCOVERY run. 0-based [start, end).
// Leave null to force discovery.
const LAYOUT = process.env.EVENT_LAYOUT ? JSON.parse(process.env.EVENT_LAYOUT) : {
  documentNo: [0, 12],
  // eventCode / eventDesc / eventDate positions get confirmed by discovery.
  eventCode: null,
  eventDesc: null,
  eventDate: null
};

// Event codes observed in the real file (positions 17-27). Classification is
// by CODE, not free text — the codes are stable, the descriptions vary.
// CRITICAL: the event file is a full lifecycle log going back decades. An
// entity can be admin-dissolved in 1983 and reinstated in 1983 and be perfectly
// healthy today (AMI Air Conditioning does exactly this twice). Only the LATEST
// event per entity is used, and only when recent.
const EVENT_CLASS = {
  // ---- distress ----
  CORAMADMAR: { signal: 'admin_dissolution',      strategies: [4, 10], distress: true },
  CORAMREVAR: { signal: 'entity_revoked',          strategies: [4, 10], distress: true },
  CORAMINVOL: { signal: 'involuntarily_dissolved', strategies: [4, 10], distress: true },
  CORAMDSPRC: { signal: 'dissolved_proclamation',  strategies: [4, 10], distress: true },
  CORAMCANNP: { signal: 'cancelled_nonpayment',    strategies: [4, 10], distress: true },
  // ---- recovery: cancels a prior distress event ----
  CORAPREIN:  { signal: 'entity_reinstated',       strategies: [], recovery: true },
  CORAPREIWP: { signal: 'admin_diss_cancelled',    strategies: [], recovery: true },
  CORAPREVDS: { signal: 'voluntary_diss_revoked',  strategies: [], recovery: true },
  CORLCREVDS: { signal: 'voluntary_diss_revoked',  strategies: [], recovery: true },
  // ---- benign / informational ----
  CORAPVOLDS: { signal: 'voluntary_dissolution',   strategies: [] },
  CORLCVOLDS: { signal: 'voluntary_dissolution',   strategies: [] },
  CORAPVLDSI: { signal: 'voluntary_dissolution',   strategies: [] },
  CORAPMER:   { signal: 'entity_merged',           strategies: [2] },
  CORAPCONV:  { signal: 'entity_converted',        strategies: [] },
  CORAPNC:    { signal: 'entity_name_change',      strategies: [] },
  CORAPAMDNC: { signal: 'entity_name_change',      strategies: [] },
  CORLCAMDNC: { signal: 'entity_name_change',      strategies: [] },
  CORAPCORNC: { signal: 'entity_name_change',      strategies: [] }
};

// Positions verified against real records (662-char fixed width):
const EV = {
  documentNo: [0, 12],
  sequence:   [12, 17],
  eventCode:  [17, 27],
  description:[27, 85],
  eventDate:  [85, 93]
};

// A distress event only scores if it is the entity's most recent event AND
// happened within this window. Older ones are history, not current condition.
const DISTRESS_RECENCY_YEARS = 5;

const CHUNK = 500;
// ================================

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

function toISO(mmddyyyy) {
  // Same MMDDYYYY convention as the corporate data file.
  const s = String(mmddyyyy || '').trim();
  if (!/^\d{8}$/.test(s)) return null;
  const m = s.slice(0, 2), d = s.slice(2, 4), y = s.slice(4, 8);
  if (y === '0000' || m === '00' || d === '00') return null;
  const mi = Number(m), di = Number(d);
  if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;
  return `${y}-${m}-${d}`;
}

// Pull any 8-digit run that parses as a plausible date, rightmost-last.
function findDates(rec) {
  const out = [];
  const re = /\d{8}/g;
  let m;
  while ((m = re.exec(rec)) !== null) {
    const iso = toISO(m[0]);
    if (iso) {
      const yr = Number(iso.slice(0, 4));
      if (yr >= 1900 && yr <= 2100) out.push({ pos: m.index, raw: m[0], iso });
    }
  }
  return out;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required.');
  }

  log('Loading entities written by AWF-2...');
  const entities = await sbGetAll('acq_entities?select=document_no,entity_name,contractor_id,status');
  log(`  ${entities.length} entities.`);
  const byDoc = new Map(entities.map(e => [String(e.document_no).trim().toUpperCase(), e]));

  // ---- Download ----
  const tmpZip = path.join(os.tmpdir(), SFTP_FILE);
  const sftp = new SftpClient();
  log(`Connecting to ${SFTP_HOST}...`);
  await sftp.connect({ host: SFTP_HOST, port: 22, username: SFTP_USER, password: SFTP_PASS, readyTimeout: 60000 });
  let dir = null, target = null;
  for (const cand of SFTP_DIR_CANDIDATES) {
    try {
      const l = await sftp.list(cand);
      const t = l.find(f => f.name.toLowerCase() === SFTP_FILE.toLowerCase());
      log(`  ${cand} -> ${l.length} items${t ? ' (contains ' + SFTP_FILE + ')' : ''}`);
      if (t) { dir = cand; target = t; break; }
    } catch (e) { log(`  ${cand} -> ${e.message}`); }
  }
  if (!target) { await sftp.end(); throw new Error(`${SFTP_FILE} not found.`); }
  log(`Downloading ${SFTP_FILE} (${(target.size / 1024 / 1024).toFixed(1)} MB)...`);
  await sftp.fastGet(`${dir}/${SFTP_FILE}`.replace('//', '/'), tmpZip);
  await sftp.end();
  log('Download complete.');

  // ---- Scan ----
  const eventsByDoc = new Map();   // doc -> [{ raw, dates }]
  const codeCensus = {};
  const rawSamples = [];
  const matchedSamples = [];
  let totalRecords = 0;
  const lengths = {};

  const directory = await unzipper.Open.file(tmpZip);
  log(`Zip contains ${directory.files.length} entries.`);

  for (const entry of directory.files) {
    if (entry.type === 'Directory') continue;
    log(`  Reading ${entry.path} (${(entry.uncompressedSize / 1024 / 1024).toFixed(0)} MB)...`);
    const rl = readline.createInterface({ input: entry.stream(), crlfDelay: Infinity });
    for await (const rawLine of rl) {
      const rec = rawLine.replace(/\r$/, '');
      if (!rec.trim()) continue;
      totalRecords++;
      if (totalRecords % 1000000 === 0) log(`    ...${totalRecords} events scanned`);
      lengths[rec.length] = (lengths[rec.length] || 0) + 1;
      if (rawSamples.length < 5) rawSamples.push(rec);

      const doc = rec.slice(LAYOUT.documentNo[0], LAYOUT.documentNo[1]).trim().toUpperCase();
      if (!doc || !byDoc.has(doc)) continue;

      if (!eventsByDoc.has(doc)) eventsByDoc.set(doc, []);
      eventsByDoc.get(doc).push(rec);
      if (matchedSamples.length < 12) matchedSamples.push(rec);

      // Census the descriptive text (everything after the doc number, letters only)
      const text = rec.slice(12).replace(/[^A-Z ]/gi, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
      if (text) {
        const keyText = text.slice(0, 45);
        codeCensus[keyText] = (codeCensus[keyText] || 0) + 1;
      }
    }
  }
  fs.unlinkSync(tmpZip);

  log(`\nScanned ${totalRecords} event records.`);
  log(`Matched events for ${eventsByDoc.size} of ${byDoc.size} known entities.`);

  if (DISCOVERY) {
    log('\n===== RECORD LENGTHS =====');
    Object.entries(lengths).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .forEach(([len, n]) => log(`  ${len} chars: ${n} records`));

    log('\n===== RAW SAMPLES (first 5 records in file) =====');
    rawSamples.forEach((r, i) => {
      log(`  [${i}] len=${r.length}`);
      log(`      ${JSON.stringify(r.slice(0, 160))}`);
      const ds = findDates(r);
      log(`      dates found at: ${ds.map(d => `${d.pos}:${d.iso}`).join(', ') || 'none'}`);
    });

    log('\n===== MATCHED SAMPLES (our contractors) =====');
    matchedSamples.forEach((r, i) => {
      const doc = r.slice(0, 12).trim();
      const ent = byDoc.get(doc.toUpperCase());
      log(`  [${i}] ${doc} -> ${ent ? ent.entity_name : '?'} (corp status ${ent ? ent.status : '?'})`);
      log(`      ${JSON.stringify(r.slice(0, 160))}`);
    });

    log('\n===== EVENT TEXT CENSUS (our contractors only, top 40) =====');
    Object.entries(codeCensus).sort((a, b) => b[1] - a[1]).slice(0, 40)
      .forEach(([t, n]) => log(`  ${String(n).padStart(5)}  ${t}`));

    log('\n===== PATTERN PREVIEW (latest event per entity) =====');
    const thisYear = new Date().getUTCFullYear();
    let dCurrent = 0, dStale = 0, benign = 0, unclass = 0, recovered = 0;
    const unknownCodes = {};
    for (const [, recs] of eventsByDoc) {
      const parsed = recs.map(r => ({
        seq: Number(r.slice(EV.sequence[0], EV.sequence[1]).trim()) || 0,
        code: r.slice(EV.eventCode[0], EV.eventCode[1]).trim().toUpperCase(),
        date: toISO(r.slice(EV.eventDate[0], EV.eventDate[1]).trim())
      })).sort((a, b) => (a.seq - b.seq) || String(a.date).localeCompare(String(b.date)));
      const latest = parsed[parsed.length - 1];
      const cls = EVENT_CLASS[latest.code];
      if (!cls) { unclass++; unknownCodes[latest.code] = (unknownCodes[latest.code] || 0) + 1; continue; }
      if (cls.distress) {
        const y = latest.date ? Number(latest.date.slice(0, 4)) : null;
        if (y && thisYear - y <= DISTRESS_RECENCY_YEARS) dCurrent++; else dStale++;
      } else {
        benign++;
        if (parsed.some(p => (EVENT_CLASS[p.code] || {}).distress)) recovered++;
      }
    }
    log(`  CURRENT distress (latest event, within ${DISTRESS_RECENCY_YEARS}yr): ${dCurrent}  <-- real targets`);
    log(`  stale distress (latest event but old):                ${dStale}`);
    log(`  benign latest event:                                  ${benign}`);
    log(`    ...of which had distress earlier then recovered:    ${recovered}`);
    log(`  unclassified latest-event codes:                      ${unclass}`);
    if (Object.keys(unknownCodes).length) {
      log('\n  Unclassified codes seen as a latest event:');
      Object.entries(unknownCodes).sort((a, b) => b[1] - a[1]).slice(0, 20)
        .forEach(([c, n]) => log(`    ${String(n).padStart(5)}  ${c}`));
    }
    log('\nAdd any missing distress codes to EVENT_CLASS, then run DRY_RUN=1.');
    return;
  }

  // ---- Build signals from the LATEST event per entity only ----
  const signals = [];
  const thisYear = new Date().getUTCFullYear();
  let historicalDistressSuppressed = 0;
  let staleDistressSuppressed = 0;

  for (const [doc, recs] of eventsByDoc) {
    const ent = byDoc.get(doc);
    if (!ent) continue;

    // Order events by sequence number, then by date as a tiebreaker.
    const parsed = recs.map(r => {
      const seq = Number(r.slice(EV.sequence[0], EV.sequence[1]).trim()) || 0;
      const code = r.slice(EV.eventCode[0], EV.eventCode[1]).trim().toUpperCase();
      const desc = r.slice(EV.description[0], EV.description[1]).replace(/\s+/g, ' ').trim();
      const date = toISO(r.slice(EV.eventDate[0], EV.eventDate[1]).trim());
      return { seq, code, desc, date };
    }).sort((a, b) => (a.seq - b.seq) || String(a.date).localeCompare(String(b.date)));

    const latest = parsed[parsed.length - 1];
    if (!latest) continue;
    const cls = EVENT_CLASS[latest.code];
    if (!cls) continue;

    // A distress event only counts as current condition if it is the latest
    // event and recent. Anything older is history: the entity was dissolved
    // in 1985, reinstated, and has been trading ever since.
    if (cls.distress) {
      const evYear = latest.date ? Number(latest.date.slice(0, 4)) : null;
      if (!evYear || thisYear - evYear > DISTRESS_RECENCY_YEARS) {
        staleDistressSuppressed++;
        continue;
      }
    }

    signals.push({
      contractor_id: ent.contractor_id,
      license_no: null,
      signal_type: cls.signal,
      strategy_ids: cls.strategies,
      payload: {
        document_no: doc,
        entity_name: ent.entity_name,
        event_code: latest.code,
        event_description: latest.desc,
        event_date: latest.date,
        total_events_on_record: parsed.length
      },
      source: 'AWF-2b'
    });

    // Count how many entities had distress somewhere in their history but
    // recovered afterwards; useful context, not a signal.
    if (!cls.distress && parsed.some(p => (EVENT_CLASS[p.code] || {}).distress)) {
      historicalDistressSuppressed++;
    }
  }

  const counts = {};
  signals.forEach(s => counts[s.signal_type] = (counts[s.signal_type] || 0) + 1);
  log('\nSignals to write (latest event per entity only):');
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => log(`    ${k}: ${v}`));
  log(`\n  suppressed as stale distress (>${DISTRESS_RECENCY_YEARS}yr or undated): ${staleDistressSuppressed}`);
  log(`  entities with distress in history but recovered since:  ${historicalDistressSuppressed}`);

  if (DRY_RUN) {
    log('\nDRY_RUN=1 -> nothing written.');
    if (signals[0]) log('Sample: ' + JSON.stringify(signals[0]));
    return;
  }

  if (signals.length) {
    log('\nInserting signals...');
    for (let i = 0; i < signals.length; i += CHUNK) {
      await sb('POST', 'acq_signals', signals.slice(i, i + CHUNK),
        { Prefer: 'resolution=ignore-duplicates,return=minimal' });
    }
  }

  // Retire the blunt AWF-2 entity_inactive signal now that precise ones exist.
  log('Retiring imprecise entity_inactive signals from AWF-2...');
  await sb('DELETE', "acq_signals?signal_type=eq.entity_inactive&source=eq.AWF-2", null,
    { Prefer: 'return=minimal' });

  log('\n===== RUN SUMMARY =====');
  log(`  eventsScanned:    ${totalRecords}`);
  log(`  entitiesWithEvents: ${eventsByDoc.size}`);
  log(`  signalsWritten:   ${signals.length}`);
  log(`  entity_inactive (AWF-2) removed; replaced by precise classifications.`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
