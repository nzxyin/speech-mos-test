'use strict';
// Listening test: consent -> setup -> headphone check -> blocks (instructions, practice, trials) -> done.
// State lives in localStorage after every step, so a reload resumes at the current trial.

/* ---------- small utilities ---------- */

const $ = (sel) => document.querySelector(sel);
const app = () => $('#app');

function hashStr(s) { // cyrb53, returns a non-negative integer
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function rng(seedStr) { // mulberry32
  let a = hashStr(seedStr) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomId(n) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(n);
  (window.crypto || window.msCrypto).getRandomValues(buf);
  return Array.from(buf, (x) => chars[x % chars.length]).join('');
}

const store = {
  load() {
    try { return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || 'null'); } catch (e) { return null; }
  },
  save(s) {
    try { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  },
  clear() {
    try { localStorage.removeItem(CONFIG.STORAGE_KEY); } catch (e) { /* ignore */ }
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- global state ---------- */

let S = null;          // persisted state
let DATA = null;       // {emos, nmos, checks}
const audioCache = new Map();

function save() { store.save(S); }

function newState(alias) {
  return {
    version: 1,
    rater_id: alias || '',
    submission_id: 'sub_' + randomId(12),
    screen: 'consent',
    consent: false,
    setup: {},
    headphone: {attempt: 0, passed: false},
    blocks: CONFIG.BLOCKS.map((b) => ({test: b.test, checks: b.checks, group: null,
      group_source: null, items: null, done: false})),
    block_idx: 0,
    item_idx: 0,
    practice_idx: 0,
    trial_counter: 0,
    queue: [],
    finished: false,
    completion_code: '',
    started_at: new Date().toISOString(),
  };
}

/* ---------- networking ---------- */

const net = {
  backoff: 0,
  timer: null,
  busy: false,
  configured() { return !!CONFIG.APPS_SCRIPT_URL; },

  async get(params) {
    const qs = new URLSearchParams(Object.assign({token: CONFIG.TOKEN}, params)).toString();
    const res = await fetch(CONFIG.APPS_SCRIPT_URL + '?' + qs, {redirect: 'follow'});
    return res.json();
  },

  // POST as text/plain so the request is "simple" and needs no CORS preflight.
  async post(payload) {
    const body = JSON.stringify(payload);
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {method: 'POST', redirect: 'follow',
        headers: {'Content-Type': 'text/plain;charset=utf-8'}, body});
      return await res.json();
    } catch (err) {
      // The response could not be read (redirect or CORS). Send blind, then confirm via status.
      await fetch(CONFIG.APPS_SCRIPT_URL, {method: 'POST', mode: 'no-cors',
        headers: {'Content-Type': 'text/plain;charset=utf-8'}, body});
      return {ok: true, unconfirmed: true};
    }
  },

  raterPayload() {
    const st = S.setup || {};
    return {
      rater_id: S.rater_id, source: 'direct', consent: S.consent,
      headphone_check_passed: S.headphone.passed, native_english: st.native_english || '',
      device: st.device || '', finished: S.finished, completion_code: S.completion_code,
      lang_tech_years: st.lang_tech_years || '', hearing_issues: st.hearing_issues || '',
      helped_build: st.helped_build || '',
      blocks_done: S.blocks.filter((b) => b.done && b.group_source === 'server')
        .map((b) => b.test + ':' + b.group).join(';'),
    };
  },

  // Sends queued rows (and the rater record) until the queue is empty. Rows leave the queue only
  // after the server confirms them, either in the POST response or through ?action=status.
  async flush(force) {
    if (!this.configured() || this.busy) return;
    if (!S.queue.length && !force && !S.raterDirty) return;
    this.busy = true;
    clearTimeout(this.timer);
    try {
      do {
        const rows = S.queue.slice(0, 50);
        const resp = await this.post({token: CONFIG.TOKEN, rows, rater: this.raterPayload()});
        if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'post failed');
        if (resp.unconfirmed) {
          const st = await this.get({action: 'status', submission_id: S.submission_id});
          if (!st.ok) throw new Error('status failed');
          const have = new Set(st.trial_ids);
          const before = S.queue.length;
          S.queue = S.queue.filter((r) => !have.has(r.trial_id));
          if (rows.length && S.queue.length === before) throw new Error('not confirmed');
        } else {
          const sent = new Set(rows.map((r) => r.trial_id));
          S.queue = S.queue.filter((r) => !sent.has(r.trial_id));
        }
        S.raterDirty = false;
        save();
      } while (S.queue.length);
      this.backoff = 0;
      setNetStatus('');
    } catch (err) {
      this.backoff = Math.min(this.backoff ? this.backoff * 2 : 2000, 60000);
      setNetStatus('Saving your answers is delayed (' + (navigator.onLine ? 'server' : 'offline') +
        '). They are kept on this device and will be retried automatically.');
      this.timer = setTimeout(() => this.flush(true), this.backoff);
    } finally {
      this.busy = false;
      if (S.screen === 'done') render();
    }
  },

  async assign(test, exclude) {
    if (this.configured()) {
      for (let i = 0; i < 4; i++) {
        try {
          const r = await this.get({action: 'assign', test, rater_id: S.rater_id,
            exclude: exclude.join(',')});
          if (r.ok) return {group: Number(r.group), source: 'server'};
          if (r.error === 'closed') return {closed: true};
        } catch (e) { /* retry */ }
        await sleep(1000 * (i + 1));
      }
    }
    // Fallback: a deterministic group from the alias, avoiding excluded groups.
    const G = CONFIG.TESTS[test].groups;
    let g = hashStr(S.rater_id + '|' + test + '|' + exclude.join(',')) % G;
    for (let k = 0; k < G && exclude.includes(g); k++) g = (g + 1) % G;
    return {group: g, source: 'local'};
  },
};

function setNetStatus(msg) {
  const el = $('#netstatus');
  if (el) { el.textContent = msg; el.hidden = !msg; }
}

window.addEventListener('online', () => { if (S) net.flush(true); });

/* ---------- data and block construction ---------- */

async function loadData() {
  const get = (u) => fetch(u, {cache: 'no-cache'}).then((r) => {
    if (!r.ok) throw new Error(u + ': ' + r.status);
    return r.json();
  });
  const [emos, nmos, checks] = await Promise.all([get(CONFIG.TESTS.emos.data),
    get(CONFIG.TESTS.nmos.data), get('data/checks.json')]);
  return {emos, nmos, checks};
}

function trialItem(test, t, trialId) {
  return {test, trial_id: trialId, stimulus_id: t.trial_id, reference_id: t.reference_id || '',
    target_id: String(t.target_id), stimulus: t.stimulus, reference: t.reference || '',
    is_check: false, check_expected: ''};
}

// Builds the ordered item list for one block: a precomputed order for the group (chosen by the
// rater seed; it already contains the repeat trial and avoids the same system twice in a row),
// with the attention checks inserted at seeded positions that are not adjacent to each other.
function buildItems(blockIdx) {
  const b = S.blocks[blockIdx];
  const d = DATA[b.test];
  const byId = new Map(d.trials.map((t) => [t.trial_id, t]));
  const orders = d.groups[b.group].orders;
  const r = rng(S.rater_id + '|' + S.submission_id + '|' + blockIdx);
  const order = orders[Math.floor(r() * orders.length)];
  const items = order.map((id) => {
    const base = id.replace(/#r$/, '');
    return trialItem(b.test, byId.get(base), id);
  });
  const checks = b.checks.map((k) => DATA.checks[b.test].checks[k]);
  const n = items.length;
  const seg = n / checks.length;
  const pos = checks.map((_, i) => Math.floor(i * seg + 2 + r() * Math.max(seg - 3, 1)));
  for (let i = checks.length - 1; i >= 0; i--) {
    const c = checks[i];
    items.splice(Math.min(pos[i], items.length), 0, {test: b.test, trial_id: c.trial_id,
      stimulus_id: c.trial_id, reference_id: c.reference ? c.trial_id + 'ref' : '', target_id: '',
      stimulus: c.stimulus, reference: c.reference || '', is_check: true,
      check_expected: c.expected});
  }
  return items;
}

function totalTrials() {
  return S.blocks.reduce((acc, b) => {
    const d = DATA[b.test];
    return acc + (b.items ? b.items.length : d.groups[0].orders[0].length + b.checks.length);
  }, 0);
}

function doneTrials() {
  let n = 0;
  for (let i = 0; i < S.blocks.length; i++) {
    const b = S.blocks[i];
    if (b.done) n += b.items.length;
    else if (i === S.block_idx && b.items && S.screen === 'trial') n += S.item_idx;
  }
  return n;
}

/* ---------- audio ---------- */

function getAudio(url) {
  if (!audioCache.has(url)) {
    const a = new Audio();
    a.preload = 'auto';
    a.src = url;
    audioCache.set(url, a);
  }
  return audioCache.get(url);
}

function stopAll() {
  audioCache.forEach((a) => { try { a.pause(); a.currentTime = 0; } catch (e) { /* ignore */ } });
}

function pruneAudio(keep) {
  audioCache.forEach((a, url) => {
    if (!keep.includes(url)) { a.pause(); a.removeAttribute('src'); a.load(); audioCache.delete(url); }
  });
}

/* ---------- rendering ---------- */

function render() {
  stopAll();
  window.onkeydown = null;
  const screens = {consent: renderConsent, setup: renderSetup, headphone: renderHeadphone,
    intro: renderIntro, practice: renderPractice, trial: renderTrial, done: renderDone,
    excluded: renderExcluded, closed: renderClosed};
  (screens[S.screen] || renderConsent)();
  window.scrollTo(0, 0);
}

function progressBar() {
  const total = totalTrials(), done = doneTrials();
  const pct = total ? Math.round(100 * done / total) : 0;
  return `<div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0"
    aria-valuemax="100"><div style="width:${pct}%"></div></div>
    <p class="muted small">${done} of ${total} ratings done</p>`;
}

function isTouch() {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
}

function renderConsent() {
  const mins = 20;
  app().innerHTML = `
    <h1>Speech listening test</h1>
    ${isTouch() ? '<p class="warn">You seem to be on a phone or tablet. If possible, please use a computer with headphones.</p>' : ''}
    <h2>Information</h2>
    <p><b>Purpose.</b> We are evaluating speech produced by several speech-generation systems and by real speakers.
      You will rate short audio clips for <b>emotion similarity</b> and for <b>naturalness</b>.</p>
    <p><b>Duration.</b> About ${mins} minutes. Please do it in one sitting in a quiet place, with headphones if you have them.
      If you have to stop, you can reload this page on the same device and browser to continue where you left off.</p>
    <p><b>Anonymity.</b> We record your ratings, the alias you choose, a few optional answers about your
      listening setup, and timing information. We do not collect names, email addresses or IP addresses.
      Please use an alias that is not your full name.</p>
    <p><b>Voluntary.</b> Taking part is voluntary. You may stop at any time without giving a reason.</p>
    <p><b>Exemption.</b> This study was determined to be exempt from IRB review. It is a small in-lab evaluation.</p>
    <p><b>Contact.</b> Questions: <a href="mailto:${CONFIG.CONTACT}">${CONFIG.CONTACT}</a>.</p>
    <label class="check"><input type="checkbox" id="agree"> I have read this information, I am 18 or older, and I agree to take part.</label>
    <div class="actions"><button id="go" class="primary" disabled>Continue</button></div>`;
  $('#agree').onchange = (e) => { $('#go').disabled = !e.target.checked; };
  $('#go').onclick = () => { S.consent = true; S.screen = 'setup'; save(); render(); };
}

function renderSetup() {
  const st = S.setup;
  const opt = (name, vals, cur) => vals.map(([v, l]) =>
    `<label class="radio"><input type="radio" name="${name}" value="${v}" ${cur === v ? 'checked' : ''}> ${l}</label>`).join('');
  app().innerHTML = `
    <h1>About you</h1>
    <label class="field">Alias (letters, digits, - or _; used only to avoid repeating a test)
      <input id="alias" maxlength="32" autocomplete="off" value="${S.rater_id}"></label>
    <p id="aliaserr" class="error" hidden>Please enter an alias using only letters, digits, - or _.</p>
    <p class="muted">The questions below are optional.</p>
    <fieldset><legend>How will you listen?</legend>${opt('device', [['headphones', 'Headphones or earphones'],
      ['speakers', 'Loudspeakers'], ['other', 'Other']], st.device)}</fieldset>
    <fieldset><legend>Are you a native speaker of English?</legend>${opt('native_english',
      [['yes', 'Yes'], ['no', 'No']], st.native_english)}</fieldset>
    <fieldset><legend>Years of experience with speech or language technology</legend>${opt('lang_tech_years',
      [['0', 'None'], ['<1', 'Less than 1'], ['1-3', '1 to 3'], ['3+', 'More than 3']], st.lang_tech_years)}</fieldset>
    <fieldset><legend>Did you help build any of the speech systems that may appear in this test?</legend>${opt('helped_build',
      [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']], st.helped_build)}</fieldset>
    <label class="check"><input type="checkbox" id="hearing" ${st.hearing_issues === 'yes' ? 'checked' : ''}> I have a known hearing issue.</label>
    <div class="actions"><button id="go" class="primary">Continue</button></div>`;
  $('#go').onclick = () => {
    const alias = $('#alias').value.trim();
    if (!/^[A-Za-z0-9_\-]{1,32}$/.test(alias)) { $('#aliaserr').hidden = false; return; }
    const val = (n) => { const x = document.querySelector(`input[name=${n}]:checked`); return x ? x.value : ''; };
    S.rater_id = alias;
    S.setup = {device: val('device'), native_english: val('native_english'),
      lang_tech_years: val('lang_tech_years'), helped_build: val('helped_build'),
      hearing_issues: $('#hearing').checked ? 'yes' : 'no'};
    S.screen = 'headphone';
    save();
    render();
  };
}

function renderHeadphone() {
  const hp = DATA.checks.headphone;
  const seq = hp.digits[S.headphone.attempt % hp.digits.length];
  let plays = 0;
  app().innerHTML = `
    <h1>Sound check</h1>
    <p>1. Play the tone and set your volume to a comfortable level. Keep it there for the rest of the test.</p>
    <div class="actions left"><button id="tone">Play tone</button></div>
    <p>2. Play the spoken digits (at most 2 plays) and type them below, without spaces.</p>
    ${S.headphone.attempt ? '<p class="warn">That was not quite right. Please check your volume and try a new sequence.</p>' : ''}
    <div class="actions left"><button id="digits">Play digits</button>
      <input id="answer" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="digits"></div>
    <div class="actions"><button id="go" class="primary" disabled>Check</button></div>`;
  const tone = getAudio(hp.tone), dig = getAudio(seq.audio);
  $('#tone').onclick = () => { stopAll(); tone.play(); };
  $('#digits').onclick = () => {
    if (plays >= 2) return;
    stopAll(); plays++; dig.play();
    if (plays >= 2) $('#digits').disabled = true;
  };
  $('#answer').oninput = (e) => { $('#go').disabled = !/\d/.test(e.target.value); };
  $('#go').onclick = () => {
    const ans = $('#answer').value.replace(/\D/g, '');
    if (ans === seq.answer) {
      S.headphone.passed = true;
      S.screen = 'intro';
    } else {
      S.headphone.attempt++;
      if (S.headphone.attempt >= 2) { S.screen = 'excluded'; S.raterDirty = true; net.flush(true); }
    }
    save();
    render();
  };
}

function firstBlockOfTest(i) {
  return S.blocks.findIndex((b) => b.test === S.blocks[i].test) === i;
}

function renderIntro() {
  const b = S.blocks[S.block_idx];
  const T = CONFIG.TESTS[b.test];
  const first = firstBlockOfTest(S.block_idx);
  const nPractice = first ? DATA.checks[b.test].practice.length : 0;
  app().innerHTML = `
    ${progressBar()}
    <h1>Part ${S.block_idx + 1} of ${S.blocks.length}: ${T.name}</h1>
    ${first ? '' : '<p>You did this kind of rating before. As a reminder:</p>'}
    <ul>${T.instructions.map((x) => `<li>${x}</li>`).join('')}</ul>
    <p><b>Question:</b> ${T.question}</p>
    <ol class="scale-list">${T.scale.map((s, i) => `<li><b>${i + 1}</b> = ${s}</li>`).join('')}</ol>
    <p>You can also press the keys <kbd>1</kbd> to <kbd>5</kbd> to rate and <kbd>Enter</kbd> to continue.</p>
    ${nPractice ? `<p>First you will do ${nPractice} practice trials. They are not recorded.</p>` : ''}
    <div class="actions"><button id="go" class="primary">${nPractice ? 'Start practice' : 'Start'}</button></div>
    <p id="status" class="muted"></p>`;
  $('#go').onclick = async () => {
    $('#go').disabled = true;
    $('#status').textContent = 'Preparing...';
    await ensureAssigned(S.block_idx);
    if (S.screen === 'closed') return render();
    S.practice_idx = 0;
    S.item_idx = 0;
    S.screen = nPractice ? 'practice' : 'trial';
    save();
    render();
  };
}

async function ensureAssigned(i) {
  const b = S.blocks[i];
  if (b.items) return;
  const exclude = S.blocks.filter((x, j) => j !== i && x.test === b.test && x.group !== null)
    .map((x) => x.group);
  const a = await net.assign(b.test, exclude);
  if (a.closed) { S.screen = 'closed'; save(); return; }
  b.group = a.group;
  b.group_source = a.source;
  b.items = buildItems(i);
  save();
}

// Shared trial page for practice and real trials. `item` has stimulus and optional reference.
function trialPage(item, opts) {
  const T = CONFIG.TESTS[item.test];
  const hasRef = !!item.reference;
  const st = {plays_ref: 0, plays_stim: 0, refDone: !hasRef, stimDone: false, rating: 0,
    firstPlay: 0, playing: null};
  const max = CONFIG.REPLAY_LIMIT;
  app().innerHTML = `
    ${opts.header}
    <p class="question">${T.question}</p>
    <div class="players">
      ${hasRef ? `<button id="pref" class="player"><span class="lbl">Reference</span><span class="sub"></span></button>` : ''}
      <button id="pstim" class="player"><span class="lbl">${hasRef ? 'Second clip' : 'Play clip'}</span><span class="sub"></span></button>
    </div>
    <div class="ratings" role="radiogroup" aria-label="rating">
      ${T.scale.map((s, i) => `<button class="rate" data-v="${i + 1}" role="radio" aria-checked="false" disabled>
        <span class="num">${i + 1}</span><span class="txt">${s}</span></button>`).join('')}
    </div>
    <p id="hint" class="muted small">${hasRef ? 'Play the reference first, then the second clip.' : 'Play the clip to unlock the rating.'}</p>
    <div id="feedback"></div>
    <div class="actions"><button id="next" class="primary" disabled>Next</button></div>`;
  const ref = hasRef ? getAudio(item.reference) : null;
  const stim = getAudio(item.stimulus);
  const bRef = $('#pref'), bStim = $('#pstim');

  function update() {
    const canRate = st.refDone && st.stimDone;
    if (bRef) {
      bRef.disabled = !!st.playing || st.plays_ref >= max;
      bRef.querySelector('.sub').textContent = st.playing === 'ref' ? 'playing...' :
        `${max - st.plays_ref} play${max - st.plays_ref === 1 ? '' : 's'} left`;
      bRef.classList.toggle('active', st.playing === 'ref');
    }
    bStim.disabled = !!st.playing || st.plays_stim >= max || !st.refDone;
    bStim.querySelector('.sub').textContent = st.playing === 'stim' ? 'playing...' :
      (!st.refDone ? 'after the reference' : `${max - st.plays_stim} play${max - st.plays_stim === 1 ? '' : 's'} left`);
    bStim.classList.toggle('active', st.playing === 'stim');
    document.querySelectorAll('.rate').forEach((b) => {
      b.disabled = !canRate;
      const on = Number(b.dataset.v) === st.rating;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    if (canRate) $('#hint').textContent = st.rating ? '' : 'Choose a rating.';
    $('#next').disabled = !st.rating;
  }

  function play(which) {
    const a = which === 'ref' ? ref : stim;
    stopAll();
    if (!st.firstPlay) st.firstPlay = performance.now();
    st[which === 'ref' ? 'plays_ref' : 'plays_stim']++;
    st.playing = which;
    a.onended = () => {
      st.playing = null;
      if (which === 'ref') st.refDone = true; else st.stimDone = true;
      update();
    };
    a.onerror = () => {
      st.playing = null;
      st[which === 'ref' ? 'plays_ref' : 'plays_stim']--;
      $('#hint').textContent = 'The audio failed to load. Please check your connection and press play again.';
      a.load();
      update();
    };
    const p = a.play();
    if (p && p.catch) p.catch(() => a.onerror());
    update();
  }

  if (bRef) bRef.onclick = () => play('ref');
  bStim.onclick = () => play('stim');
  document.querySelectorAll('.rate').forEach((b) => {
    b.onclick = () => { st.rating = Number(b.dataset.v); update(); };
  });
  const next = () => {
    if (!st.rating) return;
    stopAll();
    opts.onDone({rating: st.rating, plays_ref: st.plays_ref, plays_stim: st.plays_stim,
      listen_ms: Math.round(performance.now() - st.firstPlay)});
  };
  $('#next').onclick = next;
  window.onkeydown = (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (/^[1-5]$/.test(e.key) && st.refDone && st.stimDone) { st.rating = Number(e.key); update(); }
    else if (e.key === 'Enter' && st.rating) { e.preventDefault(); next(); }
  };
  update();
}

function renderPractice() {
  const b = S.blocks[S.block_idx];
  const pr = DATA.checks[b.test].practice;
  const p = pr[S.practice_idx];
  const item = {test: b.test, stimulus: p.stimulus, reference: p.reference || ''};
  getAudio(b.items[0].stimulus);
  trialPage(item, {
    header: `<h1>Practice ${S.practice_idx + 1} of ${pr.length}</h1><p class="muted">Not recorded.</p>`,
    onDone: () => {
      $('#feedback').innerHTML = `<p class="note">${p.note}</p>`;
      const btn = $('#next');
      btn.disabled = false;
      btn.textContent = S.practice_idx + 1 < pr.length ? 'Next practice' : 'Start the test';
      document.querySelectorAll('.rate, .player').forEach((x) => { x.disabled = true; });
      window.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); btn.onclick(); } };
      btn.onclick = () => {
        S.practice_idx++;
        if (S.practice_idx >= pr.length) { S.screen = 'trial'; S.item_idx = 0; }
        save();
        render();
      };
    },
  });
}

function renderTrial() {
  const b = S.blocks[S.block_idx];
  const item = b.items[S.item_idx];
  const nxt = b.items[S.item_idx + 1];
  const keep = [item.stimulus, item.reference];
  if (nxt) { keep.push(nxt.stimulus, nxt.reference); getAudio(nxt.stimulus); if (nxt.reference) getAudio(nxt.reference); }
  pruneAudio(keep.filter(Boolean));
  trialPage(item, {
    header: `${progressBar()}<h1>${CONFIG.TESTS[b.test].name}: ${S.item_idx + 1} of ${b.items.length}</h1>`,
    onDone: (res) => {
      S.queue.push({submission_id: S.submission_id, rater_id: S.rater_id, test: b.test,
        group: b.group, trial_idx: S.trial_counter++, trial_id: item.trial_id,
        stimulus_id: item.stimulus_id, reference_id: item.reference_id, target_id: item.target_id,
        is_check: item.is_check, check_expected: item.check_expected, rating: res.rating,
        plays_ref: res.plays_ref, plays_stim: res.plays_stim, listen_ms: res.listen_ms,
        client_ts: new Date().toISOString(), user_agent: navigator.userAgent.slice(0, 200),
        group_source: b.group_source});
      S.item_idx++;
      if (S.item_idx >= b.items.length) {
        b.done = true;
        S.raterDirty = true;
        S.block_idx++;
        S.item_idx = 0;
        if (S.block_idx >= S.blocks.length) {
          S.finished = true;
          S.completion_code = randomId(6);
          S.screen = 'done';
        } else {
          S.screen = 'intro';
        }
      }
      save();
      if (S.queue.length >= CONFIG.BATCH_SIZE || b.done) net.flush(true);
      render();
    },
  });
}

function downloadBackup() {
  const blob = new Blob([JSON.stringify({rater: net.raterPayload(), rows: S.queue,
    blocks: S.blocks.map((b) => ({test: b.test, group: b.group, group_source: b.group_source}))}, null, 1)],
  {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'listening_test_' + S.rater_id + '_' + S.submission_id + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function renderDone() {
  const pending = S.queue.length;
  const offline = !net.configured();
  app().innerHTML = `
    <h1>Thank you!</h1>
    <p>You have finished the listening test.</p>
    ${pending ? `<p class="warn">${offline ? 'This page is not connected to the results server.' :
      'Your last answers are still being saved. Please keep this page open for a moment.'}
      ${pending} rating${pending === 1 ? '' : 's'} not yet saved.</p>
      <div class="actions left"><button id="retry">Retry now</button>
      <button id="dl">Download my answers</button></div>
      <p class="muted small">If saving keeps failing, download your answers and send the file to
      <a href="mailto:${CONFIG.CONTACT}">${CONFIG.CONTACT}</a>.</p>` :
      '<p>All your answers have been saved. You can close this page.</p>'}
    <p>Completion code: <b class="code">${S.completion_code}</b></p>`;
  if (pending) {
    $('#retry').onclick = () => net.flush(true);
    $('#dl').onclick = downloadBackup;
  }
}

function renderExcluded() {
  app().innerHTML = `
    <h1>Thank you for your interest</h1>
    <p>The sound check did not succeed, so we cannot use ratings from this setup.
      This often happens with low volume, a noisy room, or audio playing through the wrong device.</p>
    <p>If you think something went wrong, please contact <a href="mailto:${CONFIG.CONTACT}">${CONFIG.CONTACT}</a>.</p>`;
}

function renderClosed() {
  app().innerHTML = `<h1>The test is closed</h1><p>This listening test is not accepting new responses.
    Thank you for your interest.</p>`;
}

/* ---------- boot ---------- */

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('reset') === '1') store.clear();
  const alias = (params.get('rater') || '').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 32);
  try {
    DATA = await loadData();
  } catch (e) {
    app().innerHTML = '<h1>Loading failed</h1><p>Please reload the page. If it keeps failing, contact ' +
      `<a href="mailto:${CONFIG.CONTACT}">${CONFIG.CONTACT}</a>.</p>`;
    return;
  }
  S = store.load();
  if (!S || S.version !== 1) {
    S = newState(alias);
    save();
  } else if (S.screen === 'practice' || S.screen === 'trial') {
    setNetStatus('Welcome back. You are continuing where you left off.');
    setTimeout(() => setNetStatus(''), 5000);
  }
  render();
  net.flush();
}

window.addEventListener('DOMContentLoaded', boot);
