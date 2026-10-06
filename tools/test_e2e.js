// End-to-end browser test with Playwright (Chromium) against tools/dev_server.js.
//   NODE_PATH=<dir with playwright> node tools/test_e2e.js [--shots DIR]
// Playback is stubbed (play() fires `ended` after 30 ms) except in the decode check, which loads
// every audio file referenced by data/*.json in the real browser and checks its duration.
'use strict';
const {spawn} = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const {chromium} = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const sheet = () => fetch(`${BASE}/__sheet`).then((r) => r.json());
const fail = (on) => fetch(`${BASE}/__fail?on=${on ? 1 : 0}`);
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const STUB = () => {
  HTMLMediaElement.prototype.play = function () {
    setTimeout(() => this.dispatchEvent(new Event('ended')), 30);
    return Promise.resolve();
  };
};

async function shot(page, name) {
  if (SHOTS) await page.screenshot({path: path.join(SHOTS, name + '.png'), fullPage: true});
}

async function clickText(page, text) {
  await page.getByRole('button', {name: text, exact: false}).first().click();
}

async function startToTrials(page, alias, checks) {
  await page.goto(`${BASE}/?rater=${alias}`);
  await page.check('#agree');
  await shot(page, '01_consent');
  await page.click('#go');
  assert.strictEqual(await page.inputValue('#alias'), alias);
  await page.check('input[name=device][value=headphones]');
  await page.check('input[name=helped_build][value=no]');
  await shot(page, '02_setup');
  await page.click('#go');
  // sound check: one wrong answer, then the right one for the second sequence
  await page.click('#tone');
  await page.click('#digits');
  await page.fill('#answer', '0000');
  await page.click('#go');
  await page.waitForSelector('.warn');
  await page.click('#digits');
  await page.fill('#answer', checks.headphone.digits[1].answer);
  await shot(page, '03_soundcheck');
  await page.click('#go');
}

// Completes the current page (practice or trial) and returns what was shown.
async function doTrial(page, rating) {
  const hasRef = await page.$('#pref');
  if (hasRef) {
    assert.ok(await page.isDisabled('#pstim'), 'second clip enabled before reference');
    await page.click('#pref');
    await page.waitForFunction(() => !document.querySelector('#pstim').disabled);
  }
  assert.ok(await page.isDisabled('.rate[data-v="1"]'), 'rating enabled before playback');
  await page.click('#pstim');
  await page.waitForFunction(() => !document.querySelector('.rate').disabled);
  await page.keyboard.press(String(rating));
  await page.keyboard.press('Enter');
}

async function runBlock(page, label, onTrial) {
  await page.waitForSelector('h1');
  let h = await page.textContent('h1');
  assert.ok(/^Part \d of 3/.test(h), `expected intro, got ${h}`);
  await clickText(page, 'Start');
  await page.waitForFunction(() => !/^Part \d of/.test(document.querySelector('h1').textContent));
  let n = 0;
  for (;;) {
    await page.waitForSelector('h1');
    h = await page.textContent('h1');
    if (h.startsWith('Practice')) {
      await doTrial(page, 3);
      await page.waitForSelector('.note');
      if (n === 0) await shot(page, `04_practice_${label}`);
      await page.click('#next');
      continue;
    }
    if (!/: \d+ of \d+$/.test(h)) break;
    const m = h.match(/: (\d+) of (\d+)$/);
    if (n === 3) await shot(page, `05_trial_${label}`);
    if (onTrial) await onTrial(Number(m[1]), Number(m[2]));
    await doTrial(page, 1 + (n % 5));
    n++;
    await page.waitForFunction((prev) => document.querySelector('h1').textContent !== prev, h);
  }
  return n;
}

async function decodeAll(browser) {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  const emos = readJson('data/emos_trials.json');
  const nmos = readJson('data/nmos_trials.json');
  const checks = readJson('data/checks.json');
  const urls = new Set();
  for (const t of [...emos.trials, ...nmos.trials]) { urls.add(t.stimulus); if (t.reference) urls.add(t.reference); }
  for (const k of ['emos', 'nmos']) {
    for (const c of [...checks[k].checks, ...checks[k].practice]) {
      urls.add(c.stimulus); if (c.reference) urls.add(c.reference);
    }
  }
  urls.add(checks.headphone.tone);
  checks.headphone.digits.forEach((d) => urls.add(d.audio));
  const res = await page.evaluate(async (list) => {
    const out = [];
    for (const u of list) {
      out.push(await new Promise((resolve) => {
        const a = new Audio();
        a.preload = 'auto';
        a.onloadedmetadata = () => resolve([u, a.duration]);
        a.onerror = () => resolve([u, -1]);
        a.src = u;
      }));
    }
    return out;
  }, [...urls]);
  await page.close();
  const bad = res.filter(([, d]) => !(d > 0.5 && d < 20));
  assert.deepStrictEqual(bad, [], 'audio that failed to decode or has odd duration');
  const durs = res.map(([, d]) => d);
  return {n: res.length, min: Math.min(...durs), max: Math.max(...durs)};
}

async function main() {
  const srv = spawn('node', [path.join(__dirname, 'dev_server.js'), String(PORT)], {stdio: 'pipe'});
  await new Promise((res) => srv.stdout.on('data', res));
  const browser = await chromium.launch({args: ['--autoplay-policy=no-user-gesture-required']});
  try {
    const dec = await decodeAll(browser);
    console.log(`decoded ${dec.n} audio files in Chromium, durations ${dec.min.toFixed(2)}-${dec.max.toFixed(2)} s`);

    const checks = readJson('data/checks.json');
    const emos = readJson('data/emos_trials.json');
    const nmos = readJson('data/nmos_trials.json');
    const ctx = await browser.newContext({viewport: {width: 1100, height: 900}});
    await ctx.addInitScript(STUB);
    let page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await startToTrials(page, 'e2e_alice', checks);

    // Block 1 (E-MOS): reload in the middle and check that it resumes at the same trial.
    let reloaded = false;
    const n1 = await runBlock(page, 'emos', async (i) => {
      if (i === 12 && !reloaded) {
        reloaded = true;
        await page.reload();
        await page.waitForSelector('h1');
        const h = await page.textContent('h1');
        assert.ok(h.endsWith(': 12 of 33'), 'resume went to ' + h);
      }
    });
    // Block 2 (NMOS): the server fails for trials 5 to 25; rows must arrive later anyway.
    const n2 = await runBlock(page, 'nmos', async (i) => {
      if (i === 5) await fail(true);
      if (i === 25) {
        await page.waitForSelector('#netstatus:not([hidden])', {timeout: 70000});
        await fail(false);
      }
    });
    const n3 = await runBlock(page, 'emos2');
    await page.waitForFunction(() => /All your answers have been saved/.test(document.body.textContent),
      null, {timeout: 120000});
    await shot(page, '06_done');
    const code = await page.textContent('.code');

    const sh = await sheet();
    const rows = sh.responses.slice(1);
    const C = Object.fromEntries(sh.responses[0].map((c, i) => [c, i]));
    const keys = rows.map((r) => r[C.submission_id] + '|' + r[C.trial_id]);
    assert.strictEqual(new Set(keys).size, keys.length, 'duplicate rows');
    assert.strictEqual(rows.length, n1 + n2 + n3);
    assert.strictEqual(n1, 33); assert.strictEqual(n2, 40); assert.strictEqual(n3, 33);
    // Each E-MOS block: every target once among non-check, non-repeat trials; groups differ.
    const groups = {};
    for (const test of ['emos', 'nmos']) {
      const T = test === 'emos' ? emos : nmos;
      const byGroup = {};
      rows.filter((r) => r[C.test] === test).forEach((r) => {
        (byGroup[r[C.group]] = byGroup[r[C.group]] || []).push(r);
      });
      groups[test] = Object.keys(byGroup).map(Number);
      for (const [g, rs] of Object.entries(byGroup)) {
        const main = rs.filter((r) => !r[C.is_check] && !String(r[C.trial_id]).endsWith('#r'));
        const tg = main.map((r) => String(r[C.target_id]));
        assert.strictEqual(new Set(tg).size, tg.length, `${test} group ${g}: a target repeats`);
        assert.strictEqual(tg.length, Object.keys(T.trials).length / T.n_groups);
        const expected = T.groups[g].orders[0].filter((x) => !x.endsWith('#r')).sort();
        assert.deepStrictEqual(main.map((r) => r[C.trial_id]).sort(), expected, `${test} group ${g} stimuli`);
        assert.strictEqual(rs.filter((r) => r[C.is_check]).length, test === 'emos' ? 2 : 4);
        assert.strictEqual(rs.filter((r) => String(r[C.trial_id]).endsWith('#r')).length, 1);
      }
    }
    assert.strictEqual(groups.emos.length, 2, 'second E-MOS block reused the group');
    const rater = sh.raters.find((r) => r[0] === 'e2e_alice');
    assert.strictEqual(rater[7], 1);
    assert.strictEqual(rater[8], code);
    assert.strictEqual(rater[4], 1);
    assert.strictEqual(rater[12].split(';').length, 3);
    assert.ok(rows.every((r) => r[C.listen_ms] > 0 && r[C.plays_stim] >= 1));
    assert.ok(rows.filter((r) => r[C.test] === 'emos').every((r) => r[C.plays_ref] >= 1));
    assert.deepStrictEqual(errors, [], 'page errors');
    console.log(`listener 1: ${rows.length} rows, groups emos ${groups.emos} nmos ${groups.nmos}, ` +
      'no duplicates after reload and outage');

    // A second listener gets different groups.
    const ctx2 = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
    await ctx2.addInitScript(STUB);
    page = await ctx2.newPage();
    await startToTrials(page, 'e2e_bob', checks);
    await clickText(page, 'Start');
    await page.waitForSelector('text=Practice 1');
    await shot(page, '07_mobile_practice');
    const asg = (await sheet()).assignments.slice(1).filter((r) => r[0] === 'emos');
    assert.ok(asg.filter((r) => r[2] > 0).length === 3, 'bob should get a third, unused E-MOS group');
    // Layout: no horizontal scroll on a phone.
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.ok(!wide, 'horizontal scroll on mobile');

    // Failing the sound check twice ends the test.
    const ctx3 = await browser.newContext();
    await ctx3.addInitScript(STUB);
    page = await ctx3.newPage();
    await page.goto(`${BASE}/?rater=e2e_carol`);
    await page.check('#agree'); await page.click('#go'); await page.click('#go');
    for (let k = 0; k < 2; k++) {
      await page.fill('#answer', '1'); await page.click('#go');
    }
    await page.waitForSelector('text=sound check did not succeed');
    await page.reload();
    await page.waitForSelector('text=sound check did not succeed');
    await shot(page, '08_excluded');
    console.log('second listener assignment, mobile layout and sound-check exclusion OK');
    console.log('e2e tests passed');
  } finally {
    await browser.close();
    srv.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
