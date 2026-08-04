#!/usr/bin/env node
/**
 * AWF-4 Explorer (Miami-Dade pilot): resolve the real ArcGIS FeatureServer
 * behind Miami-Dade's Open Data Hub permit datasets, and report the actual
 * field schema, record count, and sample rows. No writes.
 *
 * Same discipline as sftp-explore.js and the DBPR/Sunbiz discovery runs:
 * the ArcGIS Hub website is a JavaScript-rendered SPA that can't be read by
 * a simple fetch, so this resolves the underlying REST service the way the
 * browser does — via the public, unauthenticated Item Info API — and then
 * queries that service directly. Nothing here is guessed from documentation;
 * every field name gets confirmed against a live response before AWF-4
 * proper is built on top of it.
 *
 * Scope note: this pilots ONE county (Miami-Dade) before generalizing to the
 * other seven, per the tech spec's own build order — permit portals are not
 * a single integration, they're eight different ones, and Miami-Dade is the
 * largest single market to prove the pattern against first.
 */

// Known ArcGIS item IDs for Miami-Dade permit-related datasets, gathered from
// public search — CONFIRM, don't trust, which is the point of this script.
const CANDIDATE_ITEMS = [
  { id: '6db5f56e886446df88313ca279e59120', label: 'Building Permits Issued (2yr to present)' },
  { id: '31cd319f45544648b59f0418aea60091', label: 'Building Permit (point layer, last 3 years)' }
];

const log = (...a) => console.log(...a);

async function getItemInfo(itemId) {
  const url = `https://www.arcgis.com/sharing/rest/content/items/${itemId}?f=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`item info ${res.status}`);
  return res.json();
}

async function getLayerMetadata(serviceUrl) {
  const url = `${serviceUrl}?f=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`layer metadata ${res.status}`);
  return res.json();
}

async function queryLayer(serviceUrl, params) {
  const qs = new URLSearchParams(Object.assign({ f: 'json' }, params));
  const url = `${serviceUrl}/query?${qs.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`query ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function main() {
  for (const item of CANDIDATE_ITEMS) {
    log(`\n===== ${item.label} (item ${item.id}) =====`);
    let info;
    try {
      info = await getItemInfo(item.id);
    } catch (e) {
      log(`  FAILED to resolve item info: ${e.message}`);
      continue;
    }
    if (info.error) {
      log(`  Item API error: ${JSON.stringify(info.error)}`);
      continue;
    }
    log(`  title: ${info.title}`);
    log(`  type: ${info.type}`);
    log(`  url: ${info.url || '(none — not a hosted feature layer)'}`);
    log(`  modified: ${info.modified ? new Date(info.modified).toISOString() : '?'}`);

    if (!info.url) continue;

    let meta;
    try {
      meta = await getLayerMetadata(info.url);
    } catch (e) {
      log(`  FAILED to fetch layer metadata: ${e.message}`);
      continue;
    }
    if (meta.error) {
      log(`  Layer metadata error: ${JSON.stringify(meta.error)}`);
      continue;
    }
    log(`  layer name: ${meta.name}`);
    log(`  geometry type: ${meta.geometryType || '(table, no geometry)'}`);
    log(`  fields (${(meta.fields || []).length}):`);
    (meta.fields || []).forEach(f => log(`    ${f.name.padEnd(28)} ${f.type}${f.alias && f.alias !== f.name ? '  ("' + f.alias + '")' : ''}`));

    // Record count
    try {
      const countRes = await queryLayer(info.url, { where: '1=1', returnCountOnly: 'true' });
      log(`  total records: ${countRes.count ?? '(unknown)'}`);
    } catch (e) {
      log(`  FAILED to get record count: ${e.message}`);
    }

    // Date range, if there's an obvious date field
    const dateField = (meta.fields || []).find(f => /issue.*date|date.*issue/i.test(f.name))
      || (meta.fields || []).find(f => /^date/i.test(f.name) || /date$/i.test(f.name));
    if (dateField) {
      try {
        const oldest = await queryLayer(info.url, {
          where: '1=1', outFields: dateField.name, orderByFields: `${dateField.name} ASC`,
          resultRecordCount: '1'
        });
        const newest = await queryLayer(info.url, {
          where: '1=1', outFields: dateField.name, orderByFields: `${dateField.name} DESC`,
          resultRecordCount: '1'
        });
        const fmt = (r) => {
          const v = r?.features?.[0]?.attributes?.[dateField.name];
          return v ? new Date(v).toISOString().slice(0, 10) : '(none)';
        };
        log(`  date field "${dateField.name}" range: ${fmt(oldest)} to ${fmt(newest)}`);
      } catch (e) {
        log(`  FAILED to get date range: ${e.message}`);
      }
    }

    // Sample rows — full attribute set, so we can eyeball contractor/company
    // name fields, permit type/classification, and address fields for real.
    try {
      const sample = await queryLayer(info.url, {
        where: '1=1', outFields: '*', resultRecordCount: '3'
      });
      log(`  sample records:`);
      (sample.features || []).forEach((f, i) => {
        log(`    [${i}] ${JSON.stringify(f.attributes)}`);
      });
    } catch (e) {
      log(`  FAILED to fetch sample rows: ${e.message}`);
    }

    // Quick check: does any field look like it holds a contractor/company name?
    const nameFields = (meta.fields || []).filter(f =>
      /contractor|company|business|owner|applicant|permittee/i.test(f.name) ||
      (f.alias && /contractor|company|business|owner|applicant|permittee/i.test(f.alias))
    );
    log(`  candidate contractor/owner-name fields: ${nameFields.length ? nameFields.map(f => f.name).join(', ') : '(none obviously named — inspect sample records above)'}`);
  }

  log('\n===== NEXT STEPS =====');
  log('Read the field lists and sample records above. We need, at minimum:');
  log('  - a contractor/company name field to match against acq_contractors');
  log('  - a permit type or work-description field (to filter to mechanical/kitchen work)');
  log('  - an address field (for Strategy 3/7/9 clustering and overlap matching)');
  log('  - an issue date field (for recency and volume-trend signals)');
  log('If a usable service was found, tell me which item and field names look right');
  log('and I will build the real AWF-4 puller against it. If neither item resolved,');
  log('the dataset may require a different query pattern or the item IDs have changed —');
  log('send me this full output and we will search again from there.');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
