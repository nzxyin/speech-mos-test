// Backend tests: starts tools/dev_server.js (Code.gs on an in-memory Sheet) and checks the API.
//   node tools/test_backend.js
'use strict';
const {spawn} = require('child_process');
const path = require('path');
const assert = require('assert');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const TOKEN = 'devtoken';

const get = (q) => fetch(`${BASE}/exec?${new URLSearchParams(Object.assign({token: TOKEN}, q))}`).then((r) => r.json());
const post = (b) => fetch(`${BASE}/exec`, {method: 'POST', headers: {'Content-Type': 'text/plain'},
  body: JSON.stringify(Object.assign({token: TOKEN}, b))}).then((r) => r.json());
const row = (sid, tid, extra) => Object.assign({submission_id: sid, rater_id: 'alice', test: 'emos',
  group: 0, trial_idx: 0, trial_id: tid, stimulus_id: tid, target_id: '3', rating: 4}, extra);

async function main() {
  const srv = spawn('node', [path.join(__dirname, 'dev_server.js'), String(PORT)], {stdio: 'pipe'});
  await new Promise((res) => srv.stdout.on('data', res));
  try {
    let r = await fetch(`${BASE}/exec?token=wrong&action=ping`).then((x) => x.json());
    assert.deepStrictEqual(r, {ok: false, error: 'auth'});

    // Round robin while nothing is completed.
    const groups = [];
    for (let i = 0; i < 5; i++) groups.push((await get({action: 'assign', test: 'emos'})).group);
    assert.deepStrictEqual(groups.sort(), [0, 1, 2, 3, 4]);
    assert.strictEqual((await get({action: 'assign', test: 'bogus'})).error, 'test');

    // Store, deduplicate, validate.
    r = await post({rows: [row('sub_A', 's001'), row('sub_A', 's002'), row('sub_A', 's002#r')]});
    assert.deepStrictEqual(r, {ok: true, stored: 3, duplicates: 0, rejected: 0});
    r = await post({rows: [row('sub_A', 's001'), row('sub_A', 's003', {rating: 6}),
      row('sub_A', 's004', {rating: 2.5}), row('sub_A', 's005', {rater_id: 'bad name'}),
      row('sub_A', 's006', {test: 'xx'})]});
    assert.deepStrictEqual(r, {ok: true, stored: 0, duplicates: 1, rejected: 4});
    r = await get({action: 'status', submission_id: 'sub_A'});
    assert.deepStrictEqual(r.trial_ids.sort(), ['s001', 's002', 's002#r']);
    r = await post({rows: Array.from({length: 61}, (_, i) => row('sub_B', 't' + i))});
    assert.strictEqual(r.error, 'size');

    // Completion-aware assignment: alice completes emos group 0 and 1, bob completes group 2.
    await post({rater: {rater_id: 'alice', consent: true, blocks_done: 'emos:0;emos:1;nmos:3'}});
    await post({rater: {rater_id: 'bob', consent: true, blocks_done: 'emos:2'}});
    const sheet = await fetch(`${BASE}/__sheet`).then((x) => x.json());
    assert.strictEqual(sheet.raters.length, 3);
    // groups 3 and 4 have 0 completions; each has 1 assignment, so the lower number wins.
    assert.strictEqual((await get({action: 'assign', test: 'emos'})).group, 3);
    assert.strictEqual((await get({action: 'assign', test: 'emos'})).group, 4);
    // alice must not get 0 or 1 again; 3 and 4 now have 2 assignments, 2 has 1 completion.
    r = await get({action: 'assign', test: 'emos', rater_id: 'alice', exclude: '3'});
    assert.ok(![0, 1, 3].includes(r.group), 'alice got ' + r.group);
    // Rater upsert keeps first_seen and updates the row in place.
    const first = sheet.raters[1][1];
    await post({rater: {rater_id: 'alice', consent: true, finished: true, blocks_done: 'emos:0'}});
    const sheet2 = await fetch(`${BASE}/__sheet`).then((x) => x.json());
    assert.strictEqual(sheet2.raters.length, 3);
    assert.strictEqual(sheet2.raters[1][1], first);
    assert.strictEqual(sheet2.raters[1][7], 1);
    assert.strictEqual(sheet2.responses[0].length, 18);

    // The editor selfTest() posts, reads back and cleans up after itself.
    r = await fetch(`${BASE}/__selftest`).then((x) => x.json());
    assert.strictEqual(r.ok, true);
    const sheet3 = await fetch(`${BASE}/__sheet`).then((x) => x.json());
    assert.strictEqual(sheet3.responses.length, 4, 'selfTest left rows behind');
    console.log('backend tests passed');
  } finally {
    srv.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
