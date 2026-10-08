# Changelog

## 2026-10-08

- Replaced 21 NMOS clips (n004, n008, n010, n012, n013, n016, n030, n034, n050, n055, n058, n069,
  n072, n077, n081, n095, n100, n112, n114, n125, n137) whose source audio was invalid. Ids,
  targets and groups are unchanged. Ratings of these ids collected before this commit went live
  rate the old audio and must be excluded.

## 2026-10-07

- Connected the deployed Apps Script web app (`APPS_SCRIPT_URL` in `config.js`).
- Cut the test from 106 to 47 ratings per listener to limit fatigue: one E-MOS block (20 targets,
  100 clips, 5 groups) and one NMOS block (21 targets, 147 clips, 7 groups), each with 2 checks and
  1 repeat. New clip ids and orders; `STORAGE_KEY` bumped to `v2` so saved progress from the old
  layout is ignored. Backend unchanged (still 5 and 7 groups).

## 2026-10-06

- Initial site: consent, setup questions, sound check, E-MOS / NMOS / E-MOS blocks with practice
  trials, play limits, keyboard rating, progress bar, resume from `localStorage`.
- Batched `text/plain` submission with retry and backoff, `no-cors` fallback confirmed through
  `?action=status`, JSON backup download when delivery fails.
- Apps Script backend (`apps_script/Code.gs`): `setupSheet`, completion-aware group assignment,
  duplicate-safe `doPost`, `status`, rater upsert, `selfTest`.
- Data: 150 E-MOS clips (5 groups of 30), 245 NMOS clips (7 groups of 35), 4 attention checks and
  2 practice trials per test, sound-check tone and digits.
- Tools: `build_site_data.py`, `make_headphone_audio.py`, `dev_server.js` (Code.gs on an in-memory
  Sheet, byte-range serving), `test_backend.js`, `test_e2e.js` (Playwright).
