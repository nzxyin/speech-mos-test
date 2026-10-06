# Speech listening test (E-MOS and NMOS)

A static listening test served by GitHub Pages. Ratings go to a Google Sheet through a Google Apps
Script web app. Two tests share the site and the backend:

- **E-MOS (emotion similarity).** The listener hears a reference recording, then a second clip, and
  rates how similar the emotion of the second clip is to the reference: 1 completely different,
  2 mostly different, 3 somewhat similar, 4 mostly similar, 5 identical emotion. Voice identity and
  audio quality are to be ignored.
- **NMOS (naturalness).** The listener hears one clip and rates how natural it sounds:
  1 bad, 2 poor, 3 fair, 4 good, 5 excellent. There is no reference.

The repository holds only anonymized clips (`s001.wav`, `n001.wav`, ...) and the trial lists. The
mapping from clips to systems, the system names and the Sheet are private and are not in this
repository or its history.

## Flow

1. **Information and consent.** Purpose, duration (about 20 minutes), anonymity, voluntary
   participation, the IRB exemption and a contact address. A checkbox is required.
2. **About you.** A required alias (letters, digits, `-`, `_`; it can be prefilled with
   `?rater=alias`) and optional questions: listening device, native English speaker, years of
   speech or language technology experience, whether the listener helped build any of the systems,
   and a yes/no hearing-issue checkbox. No names, emails or IP addresses are collected.
3. **Sound check.** A tone to set the volume, then a spoken 4-digit sequence (at most 2 plays) that
   the listener types. A second, different sequence is offered after a wrong answer. Two failures
   end the test with a polite message.
4. **Three blocks:** E-MOS, NMOS, then a second E-MOS block. Each test starts with instructions and
   two practice trials that are not recorded and that show feedback on the expected rating. The
   second E-MOS block shows a short reminder instead.
5. **Trials.** One page per trial with custom play buttons (at most 3 plays per clip). For E-MOS
   the second clip unlocks after the reference has played once, and the rating unlocks after both
   clips have played once. For NMOS the rating unlocks after the clip has played once. Five large
   rating buttons, keys `1` to `5`, `Enter` for Next, no default selection. The next trial's audio
   is preloaded and a progress bar is shown.
6. **Completion.** A completion code and a thank-you message. If some ratings could not be
   delivered, the page keeps retrying and offers a JSON download of the unsent ratings.

Per trial the page records the rating, the number of plays of each clip, the time from the first
play to the rating, and whether the trial is an attention check.

## Design

**Latin square.** With S systems and T targets (T a multiple of S), each target t has a private
offset o_t, and listener group g hears target t from system (o_t + g) mod S. Every listener hears
every target once and every system T/S times; the S groups together cover every clip exactly once.
The offsets are balanced and private, so the public group lists do not show which clips share a
system.

| Test | Systems S | Targets T | Clips | Trials per block | Checks per block | Repeat per block |
|---|---|---|---|---|---|---|
| E-MOS | 5 | 30 | 150 | 30 | 2 | 1 |
| NMOS | 7 | 35 | 245 | 35 | 4 | 1 |

A listener does E-MOS twice with two different groups, so for every target they rate two different
systems. Per listener this gives 60 + 4 + 2 E-MOS ratings and 35 + 4 + 1 NMOS ratings.

**Group assignment.** At the start of each block the page calls `?action=assign`. The server picks
the group with the fewest completed blocks (counted from the `raters` tab), then the fewest
assignments, then the lowest number, and skips groups this alias has already completed and the
group of the listener's first E-MOS block. Abandoned sessions therefore do not leave holes. If the
server cannot be reached the page picks a group from a hash of the alias and records
`group_source: local` in the downloadable backup.

**Trial order.** For each group, 24 orders are precomputed offline. In each order no system occurs
twice in a row, and one trial from the first half is repeated in the second half at least 8
positions later (trial id `<id>#r`), to measure rater consistency. The page picks one of the 24
orders with a seed from the alias and the session, and inserts the attention checks at seeded,
spread-out positions.

**Attention checks** (expected rating in brackets):
- E-MOS: a reference paired with itself (5), and a pair with the same speaker and sentence but a
  clearly different emotion (1 or 2). Two of each, one of each per block.
- NMOS: a real recording that is not a target (4 or 5), and a heavily degraded recording: 8 kHz,
  8 kbit/s MP3 and white noise at 5 dB SNR (1 or 2). Two of each.

**Pre-registered exclusion rules** (applied per listener, before looking at system results):
1. A listener who fails more than 1 of the 4 checks of a test is excluded from that test. A check
   fails when the rating is outside the expected range.
2. A listener whose median time per trial in a test is below one third of the median over all
   listeners is excluded from that test.
3. A listener who gives the same rating to every trial of a test is excluded from that test.
4. Listeners who report that they helped build one of the systems are kept, and the analysis is
   repeated without them as a bias check.

Raw ratings are kept. Rater-mean-centered scores are a secondary analysis.

## Files

```
index.html, test.js, style.css   the single-page app
config.js                        backend URL, token, scale text, block order
data/emos_trials.json            trials {trial_id, stimulus, reference, reference_id, target_id} and groups
data/nmos_trials.json            trials {trial_id, stimulus, target_id} and groups
data/checks.json                 attention checks, practice trials and sound-check audio
audio/                           16 kHz mono 16-bit WAV, peak -1 dBFS, no metadata chunks
apps_script/Code.gs              the backend
tools/build_site_data.py         builds data/ and audio/ from the anonymized packages
tools/make_headphone_audio.py    builds the tone and the spoken digits (espeak-ng, sox)
tools/dev_server.js              local server that runs Code.gs on an in-memory Sheet
tools/test_backend.js            backend tests against the local server
tools/test_e2e.js                browser test of the full flow (Playwright)
```

## Backend

1. Create a new Google Sheet (private), for example at <https://sheets.new>.
2. Extensions → Apps Script. Replace the contents of `Code.gs` with `apps_script/Code.gs`. Save.
3. Select `setupSheet` in the function menu and press Run. Authorize when asked. This creates the
   tabs `responses`, `raters`, `assignments` (one row per test and group) and `config`.
4. In the `config` tab, set `token` to the `TOKEN` value in `config.js`.
5. Back in the editor, run `selfTest`. The execution log should end with `selfTest PASSED`. It
   posts two fake rows twice, reads them back and deletes them.
6. Deploy → New deployment → type Web app. Execute as: **Me**. Who has access: **Anyone**. Copy the
   `/exec` URL into `APPS_SCRIPT_URL` in `config.js`, commit and push.
7. After any change to `Code.gs`: Deploy → Manage deployments → Edit (pencil) → Version: New
   version → Deploy. The `/exec` URL stays the same; without a new version it keeps serving the old
   code.

To close the test, set `open` to `false` in the `config` tab. New listeners then see a closed
message; listeners already in a block can finish.

Sheet tabs:

| Tab | Columns |
|---|---|
| `responses` | server_ts, submission_id, rater_id, test, group, trial_idx, trial_id, stimulus_id, reference_id, target_id, is_check, check_expected, rating, plays_ref, plays_stim, listen_ms, client_ts, user_agent |
| `raters` | rater_id, first_seen, source, consent, headphone_check_passed, native_english, device, finished, completion_code, lang_tech_years, hearing_issues, helped_build, blocks_done, last_seen |
| `assignments` | test, group, assigned_count, completed_count |
| `config` | key, value (`token`, `emos_groups`, `nmos_groups`, `open`) |

**Delivery.** Ratings are queued in `localStorage` and posted as `text/plain` JSON (a simple request,
so no CORS preflight) every 10 trials and at the end of each block. Every post carries the
session's `submission_id`; the server ignores duplicate `(submission_id, trial_id)` pairs. If the
response cannot be read, the page posts with `mode: 'no-cors'` and then confirms through
`?action=status&submission_id=...`, which returns the stored trial ids. Rows leave the queue only
after confirmation. Failed posts are retried with exponential backoff up to 60 s, and again when
the browser comes back online.

## Local testing

```
node tools/dev_server.js 8765      # open http://localhost:8765/ ; /__sheet shows the stored rows
node tools/test_backend.js
node tools/test_e2e.js             # needs Playwright with Chromium
```

Add `?reset=1` to the URL to clear the saved progress in the current browser.

## Rebuilding data

The packages and the design export are built by private scripts that also write the answer keys.
Then, from this repository:

```
python -I tools/make_headphone_audio.py --out_dir HEADPHONE_DIR
python -I tools/build_site_data.py --emos_package EMOS_PKG --nmos_package NMOS_PKG \
    --design DESIGN_EXPORT --headphone HEADPHONE_DIR
```
