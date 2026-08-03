#!/usr/bin/env node
/**
 * AWF-2 helper: explore the Florida DOS SFTP server and locate the corporate
 * quarterly file. Run this once; put the path it reports into awf2.js.
 * Read-only. Downloads nothing.
 */
const SftpClient = require('ssh2-sftp-client');

const HOST = 'sftp.floridados.gov';
const USER = 'Public';
const PASS = 'PubAccess1845!';
const MAX_DEPTH = 4;

const log = (...a) => console.log(...a);

async function walk(sftp, dir, depth, found) {
  let items;
  try {
    items = await sftp.list(dir);
  } catch (e) {
    log(`${'  '.repeat(depth)}[cannot list ${dir}: ${e.message}]`);
    return;
  }
  const dirs = items.filter(i => i.type === 'd');
  const files = items.filter(i => i.type === '-');

  log(`${'  '.repeat(depth)}${dir}/  (${dirs.length} dirs, ${files.length} files)`);

  for (const f of files) {
    const mb = (f.size / 1024 / 1024).toFixed(1);
    const when = f.modifyTime ? new Date(f.modifyTime).toISOString().slice(0, 10) : '?';
    log(`${'  '.repeat(depth + 1)}- ${f.name}  ${mb} MB  ${when}`);
    if (/^(cordata|corevent)\.zip$/i.test(f.name)) {
      found.push({ path: `${dir}/${f.name}`.replace('//', '/'), size: f.size, modified: when });
    }
  }

  if (depth >= MAX_DEPTH) return;
  for (const d of dirs) {
    const next = `${dir}/${d.name}`.replace('//', '/');
    await walk(sftp, next, depth + 1, found);
  }
}

(async () => {
  const sftp = new SftpClient();
  log(`Connecting to ${HOST}...`);
  await sftp.connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 60000 });
  log('Connected.\n');

  try {
    const cwd = await sftp.cwd();
    log(`Server working directory: ${cwd}\n`);
  } catch (e) {
    log(`(could not read cwd: ${e.message})\n`);
  }

  const found = [];
  // Try the likely roots in order; walk whichever one lists successfully.
  const roots = ['.', '/', '/Public', '/public'];
  const seen = new Set();
  for (const r of roots) {
    try {
      await sftp.list(r);
    } catch {
      continue;
    }
    if (seen.has(r)) continue;
    seen.add(r);
    log(`===== Walking from ${r} =====`);
    await walk(sftp, r === '/' ? '' : r, 0, found);
    log('');
    if (found.length) break;
  }

  await sftp.end();

  log('===== RESULT =====');
  if (found.length) {
    found.forEach(f => log(`  FOUND: ${f.path}  (${(f.size / 1024 / 1024).toFixed(1)} MB, modified ${f.modified})`));
    log('\nPut the directory portion of the cordata.zip path into SFTP_DIR in scripts/awf2.js.');
  } else {
    log('  cordata.zip not located within depth ' + MAX_DEPTH + '.');
    log('  Review the tree above and set SFTP_DIR manually.');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
