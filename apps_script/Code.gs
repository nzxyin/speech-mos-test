/**
 * Listening-test backend (Google Apps Script web app bound to the results Sheet).
 *
 * Setup (once): open the Sheet -> Extensions -> Apps Script, paste this file,
 * run setupSheet() and authorize, put the token in the `config` tab, run selfTest(),
 * then Deploy -> New deployment -> Web app, Execute as: Me, Who has access: Anyone.
 * See README.md, section "Backend".
 *
 * The script is bound to its Sheet, so no Sheet ID is stored here. The token is
 * read from the `config` tab. It ships in the public page, so it only filters
 * stray traffic; validation and size limits below are the real protection.
 */

const RESPONSE_COLS = ['server_ts', 'submission_id', 'rater_id', 'test', 'group', 'trial_idx',
  'trial_id', 'stimulus_id', 'reference_id', 'target_id', 'is_check', 'check_expected',
  'rating', 'plays_ref', 'plays_stim', 'listen_ms', 'client_ts', 'user_agent'];
const RATER_COLS = ['rater_id', 'first_seen', 'source', 'consent', 'headphone_check_passed',
  'native_english', 'device', 'finished', 'completion_code', 'lang_tech_years',
  'hearing_issues', 'helped_build', 'blocks_done', 'last_seen'];
const ASSIGN_COLS = ['test', 'group', 'assigned_count', 'completed_count'];
const CONFIG_COLS = ['key', 'value'];
const GROUPS = {emos: 5, nmos: 7};
const MAX_ROWS_PER_POST = 60;
const ID_RE = /^[A-Za-z0-9_\-#.]{1,64}$/;
const ALIAS_RE = /^[A-Za-z0-9_\-]{1,64}$/;

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function config_() {
  const rows = sheet_('config').getDataRange().getValues();
  const cfg = {};
  for (let i = 1; i < rows.length; i++) cfg[String(rows[i][0])] = String(rows[i][1]);
  return cfg;
}

/** Creates the four tabs with headers, one assignments row per (test, group) and the config rows. */
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const make = function (name, cols) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols]);
      sh.setFrozenRows(1);
    }
    return sh;
  };
  make('responses', RESPONSE_COLS);
  make('raters', RATER_COLS);
  const asg = make('assignments', ASSIGN_COLS);
  if (asg.getLastRow() === 1) {
    const rows = [];
    Object.keys(GROUPS).forEach(function (t) {
      for (let g = 0; g < GROUPS[t]; g++) rows.push([t, g, 0, 0]);
    });
    asg.getRange(2, 1, rows.length, 4).setValues(rows);
  }
  const cfg = make('config', CONFIG_COLS);
  if (cfg.getLastRow() === 1) {
    cfg.getRange(2, 1, 4, 2).setValues([
      ['token', 'PASTE_TOKEN_FROM_config.js'],
      ['emos_groups', GROUPS.emos],
      ['nmos_groups', GROUPS.nmos],
      ['open', 'true'],
    ]);
  }
  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  const cfg = config_();
  if (p.token !== cfg.token) return json_({ok: false, error: 'auth'});
  if (p.action === 'ping') return json_({ok: true, open: cfg.open === 'true'});
  if (p.action === 'assign') {
    if (cfg.open !== 'true') return json_({ok: false, error: 'closed'});
    return assign_(p.test, p.rater_id, p.exclude);
  }
  if (p.action === 'status') return status_(p.submission_id);
  return json_({ok: false, error: 'unknown action'});
}

/** Parses "emos:2;nmos:5" into [{test, group}]. */
function parseBlocks_(s) {
  return String(s || '').split(';').filter(String).map(function (x) {
    const parts = x.split(':');
    return {test: parts[0], group: Number(parts[1])};
  });
}

/**
 * Picks the group with the fewest completed blocks (counted from the raters tab), breaking ties by
 * the fewest assignments, then the lowest group number. Groups the rater already completed and
 * groups in `exclude` (comma-separated) are skipped when another group is available.
 */
function assign_(test, raterId, exclude) {
  if (!GROUPS.hasOwnProperty(test)) return json_({ok: false, error: 'test'});
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_('assignments');
    const rows = sh.getDataRange().getValues();
    const completed = {};
    const skip = {};
    String(exclude || '').split(',').filter(String).forEach(function (g) { skip[Number(g)] = true; });
    const rr = sheet_('raters').getDataRange().getValues();
    const bdCol = RATER_COLS.indexOf('blocks_done');
    for (let i = 1; i < rr.length; i++) {
      parseBlocks_(rr[i][bdCol]).forEach(function (b) {
        if (b.test !== test) return;
        completed[b.group] = (completed[b.group] || 0) + 1;
        if (raterId && rr[i][0] === raterId) skip[b.group] = true;
      });
    }
    let best = null;
    let bestAny = null;
    const better = function (i, j) {
      if (j === null) return true;
      const ci = completed[rows[i][1]] || 0, cj = completed[rows[j][1]] || 0;
      if (ci !== cj) return ci < cj;
      if (rows[i][2] !== rows[j][2]) return rows[i][2] < rows[j][2];
      return rows[i][1] < rows[j][1];
    };
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] !== test) continue;
      sh.getRange(i + 1, 4).setValue(completed[rows[i][1]] || 0);
      if (better(i, bestAny)) bestAny = i;
      if (!skip[rows[i][1]] && better(i, best)) best = i;
    }
    if (best === null) best = bestAny;
    if (best === null) return json_({ok: false, error: 'no groups configured'});
    sh.getRange(best + 1, 3).setValue(rows[best][2] + 1);
    return json_({ok: true, test: test, group: rows[best][1]});
  } finally {
    lock.releaseLock();
  }
}

/** Returns the trial ids already stored for a submission, so the client can confirm delivery. */
function status_(submissionId) {
  if (!ID_RE.test(submissionId || '')) return json_({ok: false, error: 'id'});
  const sh = sheet_('responses');
  const last = sh.getLastRow();
  const ids = [];
  if (last > 1) {
    const sub = sh.getRange(2, 2, last - 1, 1).getValues();
    const tid = sh.getRange(2, 7, last - 1, 1).getValues();
    for (let i = 0; i < sub.length; i++) if (sub[i][0] === submissionId) ids.push(String(tid[i][0]));
  }
  return json_({ok: true, stored: ids.length, trial_ids: ids});
}

function num_(v, lo, hi) {
  const x = Number(v);
  if (!isFinite(x)) return '';
  return Math.min(Math.max(Math.round(x), lo), hi);
}

function str_(v, re) {
  const s = String(v === undefined || v === null ? '' : v);
  return re.test(s) ? s : '';
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ok: false, error: 'bad json'}); }
  const cfg = config_();
  if (body.token !== cfg.token) return json_({ok: false, error: 'auth'});
  const rows = body.rows || [];
  if (rows.length > MAX_ROWS_PER_POST) return json_({ok: false, error: 'size'});
  if (!rows.length && !body.rater) return json_({ok: false, error: 'empty'});

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = sheet_('responses');
    const last = sh.getLastRow();
    const existing = new Set();
    if (last > 1 && rows.length) {
      const sub = sh.getRange(2, 2, last - 1, 1).getValues();
      const tid = sh.getRange(2, 7, last - 1, 1).getValues();
      for (let i = 0; i < sub.length; i++) existing.add(sub[i][0] + '|' + tid[i][0]);
    }
    const out = [];
    let dup = 0, bad = 0;
    const now = new Date();
    for (const r of rows) {
      const rating = Number(r.rating);
      if (!(rating >= 1 && rating <= 5) || Math.floor(rating) !== rating ||
          !ALIAS_RE.test(r.rater_id || '') || !ID_RE.test(r.submission_id || '') ||
          !ID_RE.test(r.trial_id || '') || !GROUPS.hasOwnProperty(r.test)) { bad++; continue; }
      const key = r.submission_id + '|' + r.trial_id;
      if (existing.has(key)) { dup++; continue; }
      existing.add(key);
      out.push([now, r.submission_id, r.rater_id, r.test, num_(r.group, 0, 99),
        num_(r.trial_idx, 0, 9999), r.trial_id, str_(r.stimulus_id, ID_RE),
        str_(r.reference_id, ID_RE), str_(r.target_id, ID_RE), r.is_check ? 1 : 0,
        str_(r.check_expected, /^[0-9\-]{0,5}$/), rating, num_(r.plays_ref, 0, 99),
        num_(r.plays_stim, 0, 99), num_(r.listen_ms, 0, 36e5),
        String(r.client_ts || '').slice(0, 40), String(r.user_agent || '').slice(0, 200)]);
    }
    if (out.length) {
      sh.getRange(sh.getLastRow() + 1, 1, out.length, RESPONSE_COLS.length).setValues(out);
    }
    if (body.rater && ALIAS_RE.test(body.rater.rater_id || '')) upsertRater_(body.rater);
    return json_({ok: true, stored: out.length, duplicates: dup, rejected: bad});
  } finally {
    lock.releaseLock();
  }
}

function upsertRater_(r) {
  const sh = sheet_('raters');
  const n = sh.getLastRow() - 1;
  const ids = n > 0 ? sh.getRange(2, 1, n, 1).getValues().flat() : [];
  const idx = ids.indexOf(r.rater_id);
  const now = new Date();
  const firstSeen = idx === -1 ? now : sh.getRange(idx + 2, 2).getValue();
  const blocks = String(r.blocks_done || '').split(';')
    .filter(function (b) { return /^(emos|nmos):[0-9]{1,2}$/.test(b); }).join(';');
  const clip = function (v, k) { return String(v === undefined || v === null ? '' : v).slice(0, k); };
  const row = [r.rater_id, firstSeen, clip(r.source, 20), r.consent ? 1 : 0,
    r.headphone_check_passed ? 1 : 0, clip(r.native_english, 10), clip(r.device, 20),
    r.finished ? 1 : 0, clip(r.completion_code, 20), clip(r.lang_tech_years, 10),
    clip(r.hearing_issues, 10), clip(r.helped_build, 10), blocks, now];
  if (idx === -1) sh.appendRow(row);
  else sh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
}

/**
 * Editor test: posts a fake batch twice (the second post must be all duplicates), reads it back
 * through status_, then deletes the fake rows and the fake rater. Run it from the editor and read
 * the execution log. It does not touch the assignments counters.
 */
function selfTest() {
  const token = config_().token;
  const sid = 'selftest_' + Date.now();
  const mk = function (i) {
    return {submission_id: sid, rater_id: 'selftest', test: 'nmos', group: 0, trial_idx: i,
      trial_id: 'n00' + i, stimulus_id: 'n00' + i, target_id: '1', rating: 3, plays_stim: 1,
      listen_ms: 1000, client_ts: new Date().toISOString(), user_agent: 'selfTest'};
  };
  const body = {token: token, rows: [mk(1), mk(2)],
    rater: {rater_id: 'selftest', consent: true, blocks_done: ''}};
  const post = function () {
    return JSON.parse(doPost({postData: {contents: JSON.stringify(body)}}).getContent());
  };
  const r1 = post();
  const r2 = post();
  const st = JSON.parse(status_(sid).getContent());
  Logger.log(JSON.stringify({first: r1, second: r2, status: st}));
  const ok = r1.stored === 2 && r2.stored === 0 && r2.duplicates === 2 && st.stored === 2;
  // Clean up: delete the fake rows from the bottom up.
  [['responses', 2, sid], ['raters', 1, 'selftest']].forEach(function (x) {
    const sh = sheet_(x[0]);
    const n = sh.getLastRow() - 1;
    if (n <= 0) return;
    const col = sh.getRange(2, x[1], n, 1).getValues().flat();
    for (let i = col.length - 1; i >= 0; i--) if (col[i] === x[2]) sh.deleteRow(i + 2);
  });
  Logger.log(ok ? 'selfTest PASSED' : 'selfTest FAILED');
  return ok;
}
