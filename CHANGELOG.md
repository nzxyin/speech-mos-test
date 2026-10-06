# Changelog

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
