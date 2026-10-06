// Local test server: serves the site and runs apps_script/Code.gs against an in-memory Sheet.
//   node tools/dev_server.js [port]          then open http://localhost:PORT/
// Endpoints: /exec (doGet/doPost, CORS like Apps Script), /__sheet (JSON dump of all tabs),
// /__fail?on=1 (make /exec fail with HTTP 500 until /__fail?on=0), /__reset (fresh Sheet),
// /__selftest (runs selfTest() from Code.gs).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 8765);
const TOKEN = 'devtoken';

function makeBackend() {
  const tabs = {};
  class Range {
    constructor(name, r, c, nr, nc) { Object.assign(this, {name, r, c, nr, nc}); }
    getValues() {
      const t = tabs[this.name];
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = [];
        for (let j = 0; j < this.nc; j++) {
          const v = (t[this.r - 1 + i] || [])[this.c - 1 + j];
          row.push(v === undefined ? '' : v);
        }
        out.push(row);
      }
      return out;
    }
    getValue() { return this.getValues()[0][0]; }
    setValues(v) {
      const t = tabs[this.name];
      v.forEach((row, i) => {
        t[this.r - 1 + i] = t[this.r - 1 + i] || [];
        row.forEach((x, j) => { t[this.r - 1 + i][this.c - 1 + j] = x; });
      });
    }
    setValue(x) { this.setValues([[x]]); }
  }
  class Sheet {
    constructor(name) { this.name = name; tabs[name] = tabs[name] || []; }
    getLastRow() { return tabs[this.name].length; }
    getRange(r, c, nr = 1, nc = 1) { return new Range(this.name, r, c, nr, nc); }
    getDataRange() {
      const t = tabs[this.name];
      const nc = Math.max(1, ...t.map((r) => r.length));
      return new Range(this.name, 1, 1, Math.max(t.length, 1), nc);
    }
    appendRow(row) { tabs[this.name].push(row.slice()); }
    deleteRow(i) { tabs[this.name].splice(i - 1, 1); }
    setFrozenRows() {}
  }
  const ss = {
    getSheetByName: (n) => (tabs[n] ? new Sheet(n) : null),
    insertSheet: (n) => new Sheet(n),
    getSheets: () => Object.keys(tabs).map((n) => new Sheet(n)),
    deleteSheet: (s) => { delete tabs[s.name]; },
  };
  const ctx = {
    SpreadsheetApp: {getActiveSpreadsheet: () => ss},
    LockService: {getScriptLock: () => ({waitLock() {}, releaseLock() {}})},
    ContentService: {
      MimeType: {JSON: 'json'},
      createTextOutput: (s) => ({setMimeType() { return this; }, getContent: () => s}),
    },
    Logger: {log: (x) => console.log('[Logger]', x)},
    console, Set, Date, JSON, Math, Number, String, Object, isFinite,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps_script/Code.gs'), 'utf8'), ctx);
  ctx.setupSheet();
  tabs.config[1][1] = TOKEN;
  return {ctx, tabs};
}

let be = makeBackend();
let failing = false;
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wav': 'audio/wav'};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type) => {
    res.writeHead(code, {'Content-Type': type || 'application/json',
      'Access-Control-Allow-Origin': '*'});
    res.end(body);
  };
  if (url.pathname === '/__sheet') return send(200, JSON.stringify(be.tabs, null, 1));
  if (url.pathname === '/__fail') { failing = url.searchParams.get('on') === '1'; return send(200, '{}'); }
  if (url.pathname === '/__reset') { be = makeBackend(); return send(200, '{}'); }
  if (url.pathname === '/__selftest') return send(200, JSON.stringify({ok: be.ctx.selfTest()}));
  if (url.pathname === '/exec') {
    if (failing) return send(500, 'fail', 'text/plain');
    if (req.method === 'GET') {
      const out = be.ctx.doGet({parameter: Object.fromEntries(url.searchParams)});
      return send(200, out.getContent());
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => send(200, be.ctx.doPost({postData: {contents: body}}).getContent()));
    return;
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) return send(403, 'no', 'text/plain');
  if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) return send(404, 'not found', 'text/plain');
    let body = data;
    if (url.pathname.endsWith('/config.js')) {
      // Point the page at this server; keep everything else from the real config.
      body = data.toString().replace(/APPS_SCRIPT_URL: '[^']*'/, "APPS_SCRIPT_URL: '/exec'")
        .replace(/TOKEN: '[^']*'/, `TOKEN: '${TOKEN}'`);
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    // Byte ranges, as GitHub Pages serves them; browsers need them to seek and to know durations.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const size = body.length;
      const start = m[1] ? Number(m[1]) : Math.max(size - Number(m[2]), 0);
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.writeHead(206, {'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1});
      return res.end(body.subarray(start, end + 1));
    }
    res.writeHead(200, {'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': body.length});
    res.end(body);
  });
}).listen(PORT, () => console.log(`dev server on http://localhost:${PORT}/`));

