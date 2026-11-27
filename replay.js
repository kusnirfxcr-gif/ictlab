/* Tape · Backtest a replay
   Canvas chart with bar-by-bar replay, timeframes, zoom and pan, drawing tools,
   long/short position tools with dollar or percent risk, and on-chart orders.
   Data comes from the user's own 1-minute CSV (kept in IndexedDB "tape-replay")
   or from a public demo feed; nothing is uploaded anywhere. */
(function(){
  "use strict";
  const API = () => window.TapeRP || {};
  const EN = () => { try { return !!(API().en && API().en()); } catch(e){ return false; } };
  const T = (cz, en) => EN() ? en : cz;
  const LS = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || "null"); localStorage.setItem(k, JSON.stringify(v)); } catch(e){ return null; } };
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const btn = (cls, txt, fn, title) => { const b = mk("button", cls, txt); b.type = "button"; if (title){ b.title = title; b.setAttribute("aria-label", title); } if (fn) b.addEventListener("click", fn); return b; };
  const toast = m => { try { API().toast(m); } catch(e){} };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const loc = () => EN() ? "en-US" : "cs-CZ";
  const num = (v, d) => (+v).toLocaleString(loc(), {minimumFractionDigits: d || 0, maximumFractionDigits: d == null ? 2 : d});
  const usd = v => (v < 0 ? "−" : v > 0 ? "+" : "") + "$" + num(Math.abs(v), Math.abs(v) >= 1000 ? 0 : 2);
  const rr = v => (v > 0 ? "+" : v < 0 ? "−" : "") + num(Math.abs(v), 2) + " R";
  const hm = t => { t = ((Math.round(t) % 1440) + 1440) % 1440; return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };

  const INSTR = {
    NQ: {n: "NQ", full: "E-mini Nasdaq-100", pv: 20, tick: .25, step: 1},
    MNQ: {n: "MNQ", full: "Micro E-mini Nasdaq-100", pv: 2, tick: .25, step: 1},
    ES: {n: "ES", full: "E-mini S&P 500", pv: 50, tick: .25, step: 1},
    MES: {n: "MES", full: "Micro E-mini S&P 500", pv: 5, tick: .25, step: 1},
    BTC: {n: "BTCUSDT", full: "Bitcoin (ukázka)", pv: 1, tick: .01, step: .001}
  };
  const TFS = [[1440, "1D"], [240, "4h"], [60, "1h"], [15, "15m"], [5, "5m"], [1, "1m"]];
  // time is kept as absolute New York wall-clock minutes; a trading day runs 18:00 to 17:00, like CME futures
  const dayBase = ds => Math.round(Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10)) / 6e4);
  const grp = (t, tf) => Math.floor((t + 360) / tf) * tf - 360;
  const tdOf = t => new Date((t + 360) * 6e4).toISOString().slice(0, 10);
  const modOf = t => ((t % 1440) + 1440) % 1440;
  const SPEEDS = [[1, "1×"], [3, "3×"], [10, "10×"], [30, "30×"], [60, "60×"]];
  const CYC = [420, 510, 600, 690, 780, 870, 960];

  // ---------- settings and storage ----------
  const DEF = {ind: [], abe: 0, ptp: 0, ptpPct: 50, tags: null, sess: "eth", cup: "", cdn: "", hollow: false, ot: "mkt", size: "risk", qty: 1, bal: 50000, mode: "%", risk: 1, inst: "NQ", comm: 0, tf: 1, speed: 3, panel: null, cyc: false, tz: 0, magnet: true};
  const set = Object.assign({}, DEF, LS("tape-rp-set") || {});
  try { const s = (API().sym && API().sym()) || ""; if (!LS("tape-rp-set") && INSTR[s]) set.inst = s; } catch(e){}
  const saveSet = () => LS("tape-rp-set", set);
  // candle style: body, border and wick, each with its own up and down colour, like TradingView
  set.cs = Object.assign({bu: set.cup || "#16b67f", bd: set.cdn || "#f0475a", ou: set.cup || "#16b67f", od: set.cdn || "#f0475a", wu: set.cup || "#16b67f", wd: set.cdn || "#f0475a", sb: true, so: true, sw: true}, set.cs || {});
  let hist = LS("tape-rp-hist") || [];
  // backtest accounts: each has its own balance and its own trade history
  let accts = LS("tape-rp-accts") || [{id: "main", name: "Hlavní účet", bal: set.bal || 50000}];
  if (!set.acct || !accts.some(a => a.id === set.acct)) set.acct = accts[0].id;
  hist.forEach(h => { if (!h.acct) h.acct = "main"; });
  const acct = () => accts.find(a => a.id === set.acct) || accts[0];
  const saveAccts = () => LS("tape-rp-accts", accts);
  const AH = () => hist.filter(h => h.acct === set.acct);
  const saveHist = () => LS("tape-rp-hist", hist.slice(-2000));
  const drawStore = LS("tape-rp-draw") || {};
  (function migrate(){ const all = drawStore.all || []; Object.keys(drawStore).forEach(k => { if (k === "all" || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return; const b = dayBase(k); (drawStore[k] || []).forEach(d => { const f = t => t < 2880 ? t + b : t; if (d.a) d.a.t = f(d.a.t); if (d.b) d.b.t = f(d.b.t); if (d.t1 != null){ d.t1 = f(d.t1); d.t2 = f(d.t2); } d.t = d.t != null ? f(d.t) : (d.a ? d.a.t : d.t1 != null ? d.t1 : b + 540); all.push(d); }); delete drawStore[k]; }); drawStore.all = all; })();
  hist.forEach(h => { if (h.t1 < 2880){ const b = dayBase(h.day); h.t1 += b; h.tx += b; } });
  const anchor = d => d.t != null ? d.t : d.a ? d.a.t : d.t1;
  let drawTm = null;
  const saveDraw = () => { clearTimeout(drawTm); drawTm = setTimeout(() => { try { snapTrack(); } catch(e){} if (S.demo || !S.B.length) return; const mine = S.draws.filter(d => d.k !== "pos" || !d.st || d.st === "plan").map(d => Object.assign({}, d, {id: undefined})); drawStore.all = (S.drawOut || []).concat(mine).slice(-600); LS("tape-rp-draw", drawStore); }, 300); };

  // ---------- data library (IndexedDB, shared with the price-action charts) ----------
  const idb = () => new Promise((res, rej) => { try { const r = indexedDB.open("tape-replay", 1); r.onupgradeneeded = () => r.result.createObjectStore("days", {keyPath: "day"}); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch(e){ rej(e); } });
  const libSave = ds => idb().then(db => new Promise((res, rej) => { const tx = db.transaction("days", "readwrite"), st = tx.objectStore("days"); ds.forEach(d => st.put(d)); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }));
  const libLoad = () => idb().then(db => new Promise((res, rej) => { const r = db.transaction("days").objectStore("days").getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }));
  const libWipe = () => idb().then(db => new Promise(res => { const tx = db.transaction("days", "readwrite"); tx.objectStore("days").clear(); tx.oncomplete = () => res(); }));
  const zoneOff = (ms, tz) => { try { return API().zoneOff(ms, tz); } catch(e){ return -300; } };

  function parseCSV(text){
    const lines = text.split(/\r?\n/), out = {}, offC = {}; let epoch = false;
    for (let i = 0; i < lines.length; i++){
      const c = lines[i].split(/[;,\t]/); if (c.length < 5) continue;
      let k = 1, ts = c[0].trim().replace(/^"|"$/g, "");
      if (/^\d{10,13}$/.test(ts)){
        const ms = ts.length > 11 ? +ts : +ts * 1000, dk = Math.floor(ms / 864e5); if (offC[dk] === undefined) offC[dk] = zoneOff(ms + 432e5, "America/New_York");
        const w = new Date(ms + offC[dk] * 6e4), td = new Date(ms + offC[dk] * 6e4 + 36e4 * 60), wd = td.getUTCDay(); if (wd === 0 || wd === 6) continue;
        ts = w.toISOString().slice(0, 16).replace("T", " ") + "|" + td.toISOString().slice(0, 10); epoch = true; }
      else if (/^\d{4}[-./]\d{2}[-./]\d{2}T\d{2}:\d{2}/.test(ts)) ts = ts.replace("T", " ");
      else if (/^\d{8}\s/.test(ts)) ts = ts.slice(0, 4) + "-" + ts.slice(4, 6) + "-" + ts.slice(6, 8) + ts.slice(8);
      if (/^\d{1,2}:\d{2}/.test((c[1] || "").trim())){ ts += " " + c[1].trim(); k = 2; }
      const o = parseFloat(c[k]), h = parseFloat(c[k + 1]), l = parseFloat(c[k + 2]), cl = parseFloat(c[k + 3]), vo = parseFloat(c[k + 4]);
      if (![o, h, l, cl].every(isFinite)) continue;
      const m = ts.match(/^(\d{4})[-./](\d{2})[-./](\d{2})\s+(\d{1,2}):(\d{2})(?:\|(\S+))?/); if (!m) continue;
      const day = m[6] || (m[1] + "-" + m[2] + "-" + m[3]);
      (out[day] = out[day] || []).push([m[1] + "-" + m[2] + "-" + m[3] + " " + m[4].padStart(2, "0") + ":" + m[5], o, h, l, cl].concat(isFinite(vo) && vo >= 0 ? [vo] : []));
    }
    return {epoch: epoch, days: Object.keys(out).filter(d => out[d].length >= (epoch ? 60 : 120) && new Set(out[d].map(b => b[4])).size >= Math.min(20, out[d].length / 10)).sort().map(d => ({day: d, ny: epoch, bars: out[d].sort((a, b) => a[0] < b[0] ? -1 : 1)}))};
  }

  // demo: a real BTCUSDT day from Binance's public market-data endpoint, or an invented random walk if that fails
  async function demoDays(){
    const now = Date.now();
    for (let tries = 0; tries < 2; tries++){
      const d = new Date(now - (3 + Math.floor(Math.random() * 40)) * 864e5); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const day = d.toISOString().slice(0, 10), off = zoneOff(Date.parse(day + "T17:00:00Z"), "America/New_York"), end = Date.parse(day + "T16:00:00Z") - off * 6e4;
      try {
        let k = []; for (let j = 4; j >= 1; j--){ const r = await fetch("https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000&startTime=" + (end - j * 6e7)); if (!r.ok) throw 0; const x = await r.json(); if (!Array.isArray(x)) throw 0; k = k.concat(x); }
        if (k.length < 1500) throw 0; const out = {};
        k.forEach(x => { const w = new Date(x[0] + off * 6e4), td = new Date(x[0] + off * 6e4 + 216e5).toISOString().slice(0, 10); (out[td] = out[td] || []).push([w.toISOString().slice(0, 16).replace("T", " "), +x[1], +x[2], +x[3], +x[4], +x[5]]); });
        return Object.keys(out).sort().filter(t => out[t].length > 200).map(t => ({day: t, ny: true, demo: "BTCUSDT", real: true, bars: out[t]}));
      } catch(e){ break; }
    }
    const res = []; let p = 21000;
    for (let k = 4; k >= 0; k--){ const dd = new Date(now - 864e5 * (8 + k)); if (dd.getUTCDay() === 0 || dd.getUTCDay() === 6) continue; const day = dd.toISOString().slice(0, 10), bars = []; let v = 6;
      for (let m = 420; m < 960; m++){ v = clamp(v * (0.97 + Math.random() * .06) + (m === 570 ? 8 : 0), 3, 18); const o = p, c = Math.round((o + (Math.random() - .5) * v * 1.6) * 4) / 4, h = Math.max(o, c) + Math.round(Math.random() * v * 2) / 4, l = Math.min(o, c) - Math.round(Math.random() * v * 2) / 4; bars.push([day + " " + hm(m), o, h, l, c, Math.round(200 + Math.random() * 800 * v / 6)]); p = c; }
      res.push({day: day, ny: true, demo: "SIM", real: false, bars: bars}); }
    return res;
  }

  // ---------- state ----------
  const S = {day: "", demo: "", B: [], pos: 0, tf: TFS.some(x => x[0] === set.tf) ? set.tf : 5, bw: 9, follow: true, off: 8, R: 0, yMan: null, draws: [], tool: "cur", sel: null, hover: null, mouse: null, playing: false, timer: null, days: [], demoDays: [], drawOut: [], quiz: null, creating: null};
  const lib = () => S.demo ? S.demoDays : S.days;
  let ui = null, uid = 1, raf = 0;
  const inst = () => S.demo ? INSTR.BTC : (INSTR[set.inst] || INSTR.NQ);
  const tick = () => inst().tick;
  const rt = p => Math.round(p / tick()) * tick();
  const last = () => S.B[S.pos - 1];
  const equity = () => (+acct().bal || 0) + AH().reduce((a, t) => a + (t.usd || 0), 0);
  const riskUsd = () => set.mode === "%" ? equity() * (+set.risk || 0) / 100 : (+set.risk || 0);

  function sizing(e, sl){
    const I = inst(), pts = Math.abs(e - sl), want = riskUsd();
    if (set.size === "qty"){ if (!(pts > 0)) return null; let q = Math.max(I.step, Math.round((+set.qty || 0) / I.step) * I.step); q = Math.round(q * 1000) / 1000; return {q: q, risk: q * pts * I.pv, want: q * pts * I.pv, pts: pts, small: false, fixed: true}; } if (!(pts > 0) || !(want > 0)) return null;
    let q = want / (pts * I.pv); q = I.step >= 1 ? Math.floor(q) : Math.floor(q / I.step) * I.step; const small = q < I.step; if (small) q = I.step;
    q = Math.round(q * 1000) / 1000; return {q: q, risk: q * pts * I.pv, want: want, pts: pts, small: small};
  }

  // ---------- timeframe aggregation ----------
  let AG = {tf: 0, src: null, n: 0, a: []};
  function agg(){
    if (AG.tf !== S.tf || AG.src !== S.B || AG.n > S.pos) AG = {tf: S.tf, src: S.B, n: 0, a: []};
    const a = AG.a, tf = S.tf;
    for (let i = AG.n; i < S.pos; i++){ const b = S.B[i], g = grp(b.t, tf), L = a[a.length - 1]; if (!L || L.t !== g) a.push({t: g, i: a.length, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0}); else { if (b.h > L.h) L.h = b.h; if (b.l < L.l) L.l = b.l; L.c = b.c; L.v += b.v || 0; } }
    AG.n = S.pos; return AG;
  }
  let aggC = null;
  function idxT(t){ const a = agg().a, n = a.length; if (!n) return 0; if (t < a[0].t) return (t - a[0].t) / S.tf; if (t >= a[n - 1].t) return n - 1 + (t - a[n - 1].t) / S.tf;
    let lo = 0, hi = n - 1; while (hi - lo > 1){ const m = (lo + hi) >> 1; if (a[m].t <= t) lo = m; else hi = m; } return lo + Math.min(.999, (t - a[lo].t) / S.tf); }
  function tIdx(i){ const a = agg().a, n = a.length; if (!n) return 0; if (i < 0) return a[0].t + i * S.tf; if (i >= n - 1) return a[n - 1].t + (i - (n - 1)) * S.tf; const k = Math.floor(i); return a[k].t + (i - k) * S.tf; }
  function atr(n){ const a = agg().a, k = Math.min(n, a.length - 1); if (k < 2) return tick() * 16; let s = 0; for (let i = a.length - k; i < a.length; i++) s += Math.max(a[i].h - a[i].l, Math.abs(a[i].h - a[i - 1].c), Math.abs(a[i].l - a[i - 1].c)); return s / k; }

  // ---------- geometry ----------
  const AXW = 64, AXH = 26;
  let W = 800, H = 480, PW = 736, PH = 454, TY = 454;
  function rightIdx(){ const a = agg().a, L = a.length ? a[a.length - 1].i : 0; return S.follow ? L + S.off : S.R; }
  const xOf = i => PW - (rightIdx() - i) * S.bw;
  const iOf = x => rightIdx() - (PW - x) / S.bw;
  let yLo = 0, yHi = 1;
  const yOf = p => (yHi - p) / (yHi - yLo) * PH;
  const pOf = y => yHi - y / PH * (yHi - yLo);
  function fitY(){
    if (S.yMan){ yLo = S.yMan.lo; yHi = S.yMan.hi; return; }
    const a = agg().a, i0 = Math.floor(iOf(0)), i1 = Math.ceil(iOf(PW)); let lo = Infinity, hi = -Infinity;
    for (let k = Math.max(0, i0); k <= Math.min(a.length - 1, i1); k++){ const b = a[k]; if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    S.draws.forEach(d => { if (d.k === "pos" && (d.st === "open" || d.st === "pending" || d.st === "draft")){ lo = Math.min(lo, d.sl, d.tp, d.e); hi = Math.max(hi, d.sl, d.tp, d.e); } });
    if (!isFinite(lo)){ const b = last(); lo = b ? b.l - 10 : 0; hi = b ? b.h + 10 : 1; }
    if (hi - lo < tick() * 8){ const m = (hi + lo) / 2; lo = m - tick() * 4; hi = m + tick() * 4; }
    const pad = (hi - lo) * .09; yLo = lo - pad; yHi = hi + pad;
  }
  function nice(r){ const e = Math.pow(10, Math.floor(Math.log10(r))), f = r / e; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * e; }

  // ---------- colours ----------
  function pal(){
    const cs = getComputedStyle(ui.wrap), v = n => (cs.getPropertyValue(n) || "").trim(), light = document.documentElement.dataset.tk === "l" || document.body.classList.contains("sakura");
    return {light: light, bg: light ? "#ffffff" : "#0d0d11", grid: light ? "rgba(30,20,60,.06)" : "rgba(255,255,255,.05)", ink: light ? "#1d1530" : "#ececf1", muted: light ? "#7a7290" : "#8b8b96",
      up: "#16b67f", dn: "#f0475a", cu: set.cs.bu, cd: set.cs.bd, acc: v("--accent") || "#8ab4ff", axis: light ? "rgba(30,20,60,.12)" : "rgba(255,255,255,.09)", draw: light ? "#5b3fd6" : "#a98bff"};
  }

  // ---------- drawing ----------
  function req(){ if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); }
  function paint(){
    if (!ui) return; const cv = ui.cv, dpr = window.devicePixelRatio || 1, bx = ui.box;
    W = Math.max(280, bx.clientWidth); H = Math.max(260, bx.clientHeight); PW = W - AXW; TY = H - AXH; const PN = panes(), PNH = Math.round(clamp(H * .16, 64, 110)); PH = TY - PN.length * PNH;
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr); if (cv.width !== cw || cv.height !== ch){ cv.width = cw; cv.height = ch; cv.style.width = W + "px"; cv.style.height = H + "px"; }
    const c = cv.getContext("2d"), P = pal(), A = agg(), a = A.a; c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
    if (!S.B.length){ if (ui.empty && !ui.empty.hidden) return; c.fillStyle = P.muted; c.font = "500 14px Inter,system-ui,sans-serif"; c.textAlign = "center"; c.fillText(T("Nahraj data nebo spusť ukázku", "Load data or start the demo"), W / 2, H / 2); return; }
    fitY();
    // grid and price axis
    const step = nice((yHi - yLo) / Math.max(3, PH / 70)); c.font = "500 11px Inter,system-ui,sans-serif"; c.textBaseline = "middle";
    const dec = step < .1 ? 2 : step < 1 ? 2 : 0;
    for (let p = Math.ceil(yLo / step) * step; p <= yHi; p += step){ const y = Math.round(yOf(p)) + .5; c.strokeStyle = P.grid; c.lineWidth = 1; c.beginPath(); c.moveTo(0, y); c.lineTo(PW, y); c.stroke(); c.fillStyle = P.muted; c.textAlign = "left"; c.fillText(num(p, dec), PW + 8, y); }
    // time axis
    const i0 = Math.floor(iOf(0)) - 1, i1 = Math.ceil(iOf(PW)) + 1; c.textAlign = "center"; c.textBaseline = "middle";
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240, 360, 720], mins = S.tf >= 1440 ? 0 : (steps.find(s => s / S.tf * S.bw >= 70) || 1440), gap = 64; let lastX = -1e9;
    const dlab = t => { if (EX) return "·"; const d = new Date(t * 6e4); return d.getUTCDate() + ". " + (d.getUTCMonth() + 1) + "."; };
    for (let i = Math.max(0, i0); i <= Math.min(a.length - 1, i1); i++){ const t = a[i].t, x = Math.round(xOf(i)) + .5; if (x < 0 || x > PW) continue;
      const prev = i > 0 ? a[i - 1].t : null, newDay = prev == null || tdOf(prev) !== tdOf(t), newMon = prev != null && new Date(prev * 6e4).getUTCMonth() !== new Date(t * 6e4).getUTCMonth();
      let txt = null, bold = false;
      if (S.tf >= 1440){ if (x - lastX >= gap){ txt = newMon ? new Date(t * 6e4).toLocaleDateString(loc(), {month: "short", timeZone: "UTC"}) : dlab(t + 360); bold = newMon; } }
      else if (newDay && x - lastX >= gap * .8){ txt = dlab(t + 360); bold = true; }
      else if (mins && modOf(t) % mins === 0 && x - lastX >= gap){ txt = hm(t); }
      if (newDay && S.tf < 1440 && i > 0){ c.strokeStyle = P.axis; c.beginPath(); c.moveTo(x - S.bw / 2, 0); c.lineTo(x - S.bw / 2, TY); c.stroke(); }
      if (!txt) continue; lastX = x; c.strokeStyle = P.grid; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, TY); c.stroke(); c.fillStyle = bold ? P.ink : P.muted; c.font = (bold ? "700 " : "500 ") + "11px Inter,system-ui,sans-serif"; c.fillText(txt, x, TY + AXH / 2); }
    c.font = "500 11px Inter,system-ui,sans-serif";
    // cycles (training)
    if (set.cyc) cycPaint(c, P);
    // extended hours shading (outside 9:30-16:00 New York)
    if (set.sess === "eth" && S.tf < 240){ c.fillStyle = P.light ? "rgba(40,25,80,.035)" : "rgba(255,255,255,.025)"; let st = null;
      for (let k = Math.max(0, i0); k <= Math.min(a.length - 1, i1) + 1; k++){ const b = a[k], out = b ? (modOf(b.t) < 570 || modOf(b.t) >= 960) : false; if (out && st == null) st = k; if ((!out || !b) && st != null){ const xa = xOf(st) - S.bw / 2, xb = xOf(k) - S.bw / 2; c.fillRect(Math.max(0, xa), 0, Math.min(PW, xb) - Math.max(0, xa), PH); st = null; } } }
    // candles
    const bw = Math.max(1, S.bw * .7);
    c.save(); c.beginPath(); c.rect(0, 0, PW, PH); c.clip();
    indUnder(c, P, a, i0, i1);
    const CS = set.cs;
    for (let k = Math.max(0, i0); k <= Math.min(a.length - 1, i1); k++){ const b = a[k], x = xOf(b.i), up = b.c >= b.o; c.lineWidth = 1;
      const t = yOf(Math.max(b.o, b.c)), bt = yOf(Math.min(b.o, b.c)), bx = Math.round(x - bw / 2), bwp = Math.max(1, Math.round(bw)), xm = Math.round(x) + .5, hol = up && set.hollow && bwp > 2;
      if (CS.sw){ c.strokeStyle = up ? CS.wu : CS.wd; c.beginPath(); c.moveTo(xm, yOf(b.h)); c.lineTo(xm, hol ? t : yOf(b.l)); if (hol){ c.moveTo(xm, bt); c.lineTo(xm, yOf(b.l)); } c.stroke(); }
      if (CS.sb && !hol){ c.fillStyle = up ? CS.bu : CS.bd; c.fillRect(bx, t, bwp, Math.max(1, bt - t)); }
      if ((CS.so || hol) && bwp > 2){ c.strokeStyle = CS.so ? (up ? CS.ou : CS.od) : (up ? CS.bu : CS.bd); c.strokeRect(bx + .5, t + .5, bwp - 1, Math.max(1, bt - t - 1)); } }
    indOver(c, P, a, i0, i1);
    // drawings
    S.draws.forEach(d => drawObj(c, P, d));
    if (S.creating && S.creating.d) drawObj(c, P, S.creating.d);
    // crosshair
    const m = S.mouse;
    c.restore();
    PN.forEach((ind, k) => panePaint(c, P, a, i0, i1, ind, PH + k * PNH, PNH));
    if (m && m.x < PW && m.y < TY && m.y >= 0){ c.setLineDash([4, 4]); c.strokeStyle = P.muted; c.globalAlpha = .7; c.beginPath(); c.moveTo(0, Math.round(m.y) + .5); c.lineTo(PW, Math.round(m.y) + .5); c.moveTo(Math.round(m.x) + .5, 0); c.lineTo(Math.round(m.x) + .5, TY); c.stroke(); c.setLineDash([]); c.globalAlpha = 1; }
    if (S.meas) measPaint(c, P);
    // axis lines
    c.strokeStyle = P.axis; c.beginPath(); c.moveTo(PW + .5, 0); c.lineTo(PW + .5, H); c.moveTo(0, TY + .5); c.lineTo(W, TY + .5); c.stroke();
    // last price tag
    const lb = last(); if (lb){ const y = yOf(lb.c); if (y > 0 && y < PH){ const col = lb.c >= lb.o ? P.cu : P.cd; c.setLineDash([2, 3]); c.strokeStyle = col; c.globalAlpha = .6; c.beginPath(); c.moveTo(0, Math.round(y) + .5); c.lineTo(PW, Math.round(y) + .5); c.stroke(); c.setLineDash([]); c.globalAlpha = 1; tag(c, PW, y, num(lb.c, dec || (tick() < 1 ? 2 : 0)), col, "#fff"); } }
    // labels for open trades on the axis
    S.draws.forEach(d => { if (d.k !== "pos" || !(d.st === "open" || d.st === "draft" || d.st === "pending")) return; tag(c, PW, yOf(d.sl), num(d.sl, 2), P.dn, "#fff"); tag(c, PW, yOf(d.tp), num(d.tp, 2), P.up, "#fff"); });
    if (m && m.x < PW && m.y < TY && m.y >= 0){ if (m.y < PH) tag(c, PW, m.y, num(rt(pOf(m.y)), 2), P.light ? "#2b2440" : "#e9e9ee", P.light ? "#fff" : "#111"); const t = tIdx(Math.round(iOf(m.x))); const tw = S.tf >= 1440 ? 62 : 92; c.fillStyle = P.light ? "#2b2440" : "#e9e9ee"; rrect(c, m.x - tw / 2, TY + 3, tw, AXH - 6, 4); c.fill(); c.fillStyle = P.light ? "#fff" : "#111"; c.textAlign = "center"; c.fillText(S.tf >= 1440 ? new Date((t + 360) * 6e4).toLocaleDateString(loc(), {day: "numeric", month: "numeric", year: "2-digit", timeZone: "UTC"}) : (EX ? "" : new Date((t + 360) * 6e4).toLocaleDateString(loc(), {day: "numeric", month: "numeric", timeZone: "UTC"}) + " ") + hm(t), m.x, TY + AXH / 2); }
    legend(); indLegend();
    panelPaint(); otbPaint(); if (ui.rt) ui.rt.hidden = S.follow;
  }
  function rrect(c, x, y, w, h, r){ c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function tag(c, x, y, txt, bg, fg){ if (y < -8 || y > PH + 8) return; c.font = "600 11px Inter,system-ui,sans-serif"; const w = AXW - 4; c.fillStyle = bg; rrect(c, x + 2, y - 9, w, 18, 4); c.fill(); c.fillStyle = fg; c.textAlign = "left"; c.textBaseline = "middle"; c.fillText(txt, x + 7, y); }
  function label(c, x, y, txt, bg, fg){ c.font = "600 11.5px Inter,system-ui,sans-serif"; const w = c.measureText(txt).width + 14; c.fillStyle = bg; rrect(c, x - w / 2, y - 10, w, 20, 6); c.fill(); c.fillStyle = fg; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(txt, x, y + .5); }

  function drawObj(c, P, d){
    if (d.k !== "pos"){ const lw = d.lw || 1.5; c.lineWidth = lw + (S.sel === d ? .6 : 0); c.setLineDash(d.ls === "d" ? [7, 5] : d.ls === "o" ? [1.5, 3.5] : []); c.lineCap = d.ls === "o" ? "round" : "butt"; }
    shape(c, P, d); c.setLineDash([]); c.lineCap = "butt"; c.globalAlpha = 1;
  }
  function shape(c, P, d){
    const sel = S.sel === d, col = d.col || P.draw; c.strokeStyle = col; c.fillStyle = col;
    if (d.k === "h"){ const y = Math.round(yOf(d.p)) + .5; c.beginPath(); c.moveTo(0, y); c.lineTo(PW, y); c.stroke(); if (d.lab !== false){ c.font = "600 10.5px Inter,system-ui,sans-serif"; c.textAlign = "right"; c.textBaseline = "bottom"; c.fillText(num(d.p, 2), PW - 6, y - 3); } if (sel) hdl(c, PW / 2, y, P); return; }
    if (d.k === "txt"){ const x = xOf(idxT(d.a.t)), y = yOf(d.a.p), fs = d.fs || 14; c.font = "600 " + fs + "px Inter,system-ui,sans-serif"; c.textAlign = "left"; c.textBaseline = "middle"; const lines = String(d.s || "").split("\n"); let w = 0; lines.forEach((l, k) => { c.fillText(l, x, y + k * fs * 1.25); w = Math.max(w, c.measureText(l).width); }); d._w = w; d._h = lines.length * fs * 1.25; if (sel){ c.setLineDash([3, 3]); c.lineWidth = 1; c.strokeRect(x - 4, y - fs * .7, w + 8, d._h + fs * .15); c.setLineDash([]); } return; }
    if (d.k === "line" || d.k === "ray"){ const x1 = xOf(idxT(d.a.t)), y1 = yOf(d.a.p), x2 = xOf(idxT(d.b.t)), y2 = yOf(d.b.p); c.beginPath(); c.moveTo(x1, y1); if (d.k === "ray" && x2 !== x1){ const k = (y2 - y1) / (x2 - x1), xe = x2 > x1 ? PW : 0; c.lineTo(xe, y1 + k * (xe - x1)); } else c.lineTo(x2, y2); c.stroke(); if (sel){ hdl(c, x1, y1, P); hdl(c, x2, y2, P); } return; }
    if (d.k === "rect"){ const x1 = xOf(idxT(d.a.t)), y1 = yOf(d.a.p), x2 = xOf(idxT(d.b.t)), y2 = yOf(d.b.p); c.globalAlpha = d.fo != null ? d.fo : .13; c.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); c.globalAlpha = 1; c.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); if (sel){ hdl(c, x1, y1, P); hdl(c, x2, y2, P); } return; }
    if (d.k === "fib"){ const x1 = xOf(idxT(d.a.t)), x2 = xOf(idxT(d.b.t)), xl = Math.min(x1, x2), xr = Math.max(x1, x2) + 60, lv = [[0, "0"], [.5, "0.5"], [.62, "0.62"], [.705, "0.705"], [.79, "0.79"], [1, "1"]];
      c.font = "600 10px Inter,system-ui,sans-serif"; c.textBaseline = "bottom"; c.textAlign = "left";
      const pAt = f => d.b.p + (d.a.p - d.b.p) * f; c.globalAlpha = d.fo != null ? d.fo : .1; c.fillRect(xl, yOf(pAt(.62)), xr - xl, yOf(pAt(.79)) - yOf(pAt(.62))); c.globalAlpha = 1;
      lv.forEach(l => { const y = Math.round(yOf(pAt(l[0]))) + .5; c.globalAlpha = l[0] === 0 || l[0] === 1 ? 1 : .75; c.beginPath(); c.moveTo(xl, y); c.lineTo(xr, y); c.stroke(); c.fillText(l[1] + "  " + num(rt(pAt(l[0])), 2), xl + 4, y - 2); }); c.globalAlpha = 1;
      c.setLineDash([3, 3]); c.beginPath(); c.moveTo(x1, yOf(d.a.p)); c.lineTo(x2, yOf(d.b.p)); c.stroke(); c.setLineDash([]); if (sel){ hdl(c, x1, yOf(d.a.p), P); hdl(c, x2, yOf(d.b.p), P); } return; }
    if (d.k === "pos") posPaint(c, P, d, sel);
  }
  function hdl(c, x, y, P){ c.fillStyle = P.bg; c.strokeStyle = P.draw; c.lineWidth = 1.6; c.beginPath(); c.arc(x, y, 4.5, 0, Math.PI * 2); c.fill(); c.stroke(); }
  function posGeo(d){ const x1 = xOf(idxT(d.t1)), x2 = Math.max(x1 + 24, xOf(idxT(d.t2))); return {x1: x1, x2: x2, ye: yOf(d.e), ys: yOf(d.sl), yt: yOf(d.tp)}; }
  function posPaint(c, P, d, sel){
    const g = posGeo(d), live = d.st === "open" || d.st === "pending" || d.st === "draft", done = d.st === "win" || d.st === "loss" || d.st === "be" || d.st === "closed";
    const a = done ? .1 : .17;
    c.globalAlpha = a; c.fillStyle = P.dn; c.fillRect(g.x1, Math.min(g.ye, g.ys), g.x2 - g.x1, Math.abs(g.ys - g.ye)); c.fillStyle = P.up; c.fillRect(g.x1, Math.min(g.ye, g.yt), g.x2 - g.x1, Math.abs(g.yt - g.ye)); c.globalAlpha = 1;
    c.lineWidth = 1; c.strokeStyle = P.dn; c.beginPath(); c.moveTo(g.x1, Math.round(g.ys) + .5); c.lineTo(g.x2, Math.round(g.ys) + .5); c.stroke(); c.strokeStyle = P.up; c.beginPath(); c.moveTo(g.x1, Math.round(g.yt) + .5); c.lineTo(g.x2, Math.round(g.yt) + .5); c.stroke();
    c.strokeStyle = P.ink; c.lineWidth = 1.3; if (d.st === "pending") c.setLineDash([5, 4]); c.beginPath(); c.moveTo(g.x1, Math.round(g.ye) + .5); c.lineTo(g.x2, Math.round(g.ye) + .5); c.stroke(); c.setLineDash([]);
    if (done && d.tx != null){ const xe = xOf(idxT(d.tx)), ye = yOf(d.ex); c.setLineDash([3, 3]); c.strokeStyle = P.ink; c.globalAlpha = .7; c.beginPath(); c.moveTo(g.x1, g.ye); c.lineTo(xe, ye); c.stroke(); c.setLineDash([]); c.globalAlpha = 1; c.fillStyle = d.r > 0 ? P.up : d.r < 0 ? P.dn : P.muted; c.beginPath(); c.arc(xe, ye, 3.5, 0, Math.PI * 2); c.fill(); }
    const risk = Math.abs(d.e - d.sl), R = risk ? Math.abs(d.tp - d.e) / risk : 0, sz = d.q ? {q: d.q, risk: d.q * Math.abs(d.e - (d.sl0 != null ? d.sl0 : d.sl)) * inst().pv} : sizing(d.e, d.sl), cx = (g.x1 + g.x2) / 2, I = inst();
    if (g.x2 - g.x1 > 70 || sel || live){
      const qtxt = sz ? num(sz.q, I.step < 1 ? 3 : 0) + " " + I.n : "";
      const tUsd = sz ? Math.abs(d.tp - d.e) * sz.q * I.pv : 0, sUsd = sz ? Math.abs(d.e - d.sl) * sz.q * I.pv : 0;
      const lt = T("Cíl ", "Target ") + num(R, 2) + "R · " + num(Math.abs(d.tp - d.e), 2) + T(" b.", " pts") + (sz ? " · +$" + num(tUsd, 0) : "");
      const ls = T("Stop ", "Stop ") + (d.sl0 != null && Math.abs(d.sl - d.sl0) > 1e-9 ? num(d.dir * (d.sl - d.e) / Math.abs(d.e - d.sl0), 2) + "R" : "1R") + " · " + num(Math.abs(d.e - d.sl), 2) + T(" b.", " pts") + (sz ? " · −$" + num(sUsd, 0) : "");
      label(c, cx, g.yt + (g.yt < g.ye ? -14 : 14), lt, P.up, "#fff");
      label(c, cx, g.ys + (g.ys > g.ye ? 14 : -14), ls, P.dn, "#fff");
      let mid = (d.dir > 0 ? "Long " : "Short ") + (qtxt ? "· " + qtxt : "");
      if (d.st === "draft") mid = T("Návrh ", "Draft ") + otName(d.ot || "mkt").toLowerCase() + " · " + mid; if (d.st === "pending") mid = otName(d.ot || "lim") + T(" čeká · ", " pending · ") + mid;
      if (d.st === "open"){ const lb = last(), pnl = lb ? d.dir * (lb.c - d.e) * d.q * I.pv : 0, r = d.dir * ((lb ? lb.c : d.e) - d.e) / Math.abs(d.e - d.sl0); mid += " · " + rr(r) + " · " + usd(pnl); }
      if (done) mid = (d.st === "win" ? T("Cíl ✓ ", "Target ✓ ") : d.st === "loss" ? T("Stop ✕ ", "Stop ✕ ") : d.st === "be" ? T("Na nule ", "Breakeven ") : T("Zavřeno ", "Closed ")) + rr(d.r) + " · " + usd(d.usd);
      if (sz && sz.small && !d.q && live) mid += T(" · stop je na zvolené riziko moc široký", " · stop too wide for your risk");
      label(c, cx, g.ye, mid, done ? (d.r > 0 ? P.up : d.r < 0 ? P.dn : P.muted) : P.light ? "#2b2440" : "#ececf1", done ? "#fff" : P.light ? "#fff" : "#111");
    }
    if (sel || live){ if (!done){ hdl(c, g.x1, g.ys, P); hdl(c, g.x1, g.yt, P); if (d.st !== "open") hdl(c, g.x1, g.ye, P); hdl(c, g.x2, g.ye, P); } }
  }


  // ---------- indicators ----------
  const IND = {
    ema: {n: "EMA", p: 21, col: "#ffb300", lw: 1.6},
    sma: {n: "SMA", p: 50, col: "#2196f3", lw: 1.6},
    vwap: {n: "VWAP", col: "#ff5fa2", lw: 1.8, sd: false},
    bb: {n: "Bollinger", p: 20, m: 2, col: "#26c6da", lw: 1.2},
    vol: {n: "Objem|Volume", col: ""},
    rsi: {n: "RSI", p: 14, col: "#a98bff", lw: 1.5, pane: 1},
    atr: {n: "ATR", p: 14, col: "#ff9800", lw: 1.5, pane: 1},
    pdl: {n: "PDH / PDL", col: "#9e9e9e", lw: 1.2},
    opn: {n: "Půlnoc a 9:30|Midnight & 9:30 open", col: "#ffd54a", lw: 1.2},
    kz: {n: "Killzóny|Killzones"}
  };
  const indName = k => { const n = IND[k].n.split("|"); return EN() && n[1] ? n[1] : n[0]; };
  const indLabel = d => indName(d.k) + (d.p ? " " + d.p : "") + (d.k === "bb" ? " " + num(d.m, 1) : "");
  const KZ = [[1200, 1440, "Asie|Asia", "#7c4dff"], [120, 300, "Londýn|London", "#2196f3"], [510, 660, "NY AM", "#16b67f"], [810, 960, "NY PM", "#ff9800"]];
  const panes = () => (set.ind || []).filter(d => d.on !== false && IND[d.k] && IND[d.k].pane);
  let IC = {key: ""};
  function indCalc(){
    const A = agg(), a = A.a, key = AG.n + "|" + S.tf + "|" + a.length + "|" + JSON.stringify(set.ind) + "|" + S.B.length;
    if (IC.key === key) return IC; const out = {key: key};
    (set.ind || []).forEach(d => {
      if (d.on === false) return; const n = a.length, v = new Array(n).fill(null), p = Math.max(1, +d.p || 14);
      if (d.k === "ema"){ const k = 2 / (p + 1); let e = null; for (let i = 0; i < n; i++){ e = e == null ? a[i].c : a[i].c * k + e * (1 - k); if (i >= p - 1) v[i] = e; } out[d.id] = v; }
      else if (d.k === "sma"){ let s2 = 0; for (let i = 0; i < n; i++){ s2 += a[i].c; if (i >= p) s2 -= a[i - p].c; if (i >= p - 1) v[i] = s2 / p; } out[d.id] = v; }
      else if (d.k === "bb"){ const up = new Array(n).fill(null), dn = new Array(n).fill(null); for (let i = p - 1; i < n; i++){ let s2 = 0; for (let j = i - p + 1; j <= i; j++) s2 += a[j].c; const mean = s2 / p; let q = 0; for (let j = i - p + 1; j <= i; j++) q += (a[j].c - mean) * (a[j].c - mean); const sd = Math.sqrt(q / p); v[i] = mean; up[i] = mean + (+d.m || 2) * sd; dn[i] = mean - (+d.m || 2) * sd; } out[d.id] = {m: v, u: up, d: dn}; }
      else if (d.k === "vwap"){ let pv = 0, vv = 0, td = null; const any = a.some(b => b.v > 0); for (let i = 0; i < n; i++){ const t2 = tdOf(a[i].t); if (t2 !== td){ td = t2; pv = 0; vv = 0; } const w = any ? (a[i].v || 0) : 1, tp = (a[i].h + a[i].l + a[i].c) / 3; pv += tp * w; vv += w; v[i] = vv ? pv / vv : tp; } out[d.id] = v; out[d.id + "nv"] = !any; }
      else if (d.k === "rsi"){ let ag = 0, al = 0; for (let i = 1; i < n; i++){ const ch = a[i].c - a[i - 1].c, g = Math.max(0, ch), l = Math.max(0, -ch); if (i <= p){ ag += g / p; al += l / p; if (i === p) v[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } else { ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p; v[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } } out[d.id] = v; }
      else if (d.k === "atr"){ let x = null; for (let i = 1; i < n; i++){ const tr = Math.max(a[i].h - a[i].l, Math.abs(a[i].h - a[i - 1].c), Math.abs(a[i].l - a[i - 1].c)); x = x == null ? tr : (x * (p - 1) + tr) / p; if (i >= p) v[i] = x; } out[d.id] = v; }
    });
    // day levels from revealed 1-minute bars only, so nothing from the future leaks in
    if ((set.ind || []).some(d => d.on !== false && (d.k === "pdl" || d.k === "opn" || d.k === "kz"))){
      const days = {}, order = []; for (let i = 0; i < S.pos; i++){ const b = S.B[i], td = tdOf(b.t), m = modOf(b.t); let D = days[td]; if (!D){ D = days[td] = {td: td, t0: b.t, t1: b.t, h: b.h, l: b.l, mo: null, o930: null, kz: {}}; order.push(td); }
        D.t1 = b.t; if (b.h > D.h) D.h = b.h; if (b.l < D.l) D.l = b.l; if (D.mo == null && m >= 0 && m < 1080 && b.t >= dayBase(td)) D.mo = {t: b.t, p: b.o}; if (D.o930 == null && m >= 570 && m < 960 && b.t >= dayBase(td)) D.o930 = {t: b.t, p: b.o};
        KZ.forEach((z, k) => { if (m >= z[0] && m < z[1]){ const Z = D.kz[k] || (D.kz[k] = {t0: b.t, t1: b.t, h: b.h, l: b.l}); Z.t1 = b.t; if (b.h > Z.h) Z.h = b.h; if (b.l < Z.l) Z.l = b.l; } }); }
      out.days = days; out.order = order; }
    IC = out; return out;
  }
  const lineSeries = (c, a, v, i0, i1, col, lw, dash) => { c.strokeStyle = col; c.lineWidth = lw || 1.5; c.setLineDash(dash || []); c.beginPath(); let on = false; for (let k = Math.max(0, i0 - 1); k <= Math.min(a.length - 1, i1 + 1); k++){ const y = v[k]; if (y == null){ on = false; continue; } const x = xOf(k), yy = yOf(y); if (!on){ c.moveTo(x, yy); on = true; } else c.lineTo(x, yy); } c.stroke(); c.setLineDash([]); };
  function indUnder(c, P, a, i0, i1){
    const R = indCalc();
    (set.ind || []).forEach(d => {
      if (d.on === false) return;
      if (d.k === "vol"){ let mx = 0; for (let k = Math.max(0, i0); k <= Math.min(a.length - 1, i1); k++) mx = Math.max(mx, a[k].v || 0); if (!mx) return; const hh = PH * .18, bw2 = Math.max(1, S.bw * .7);
        for (let k = Math.max(0, i0); k <= Math.min(a.length - 1, i1); k++){ const b = a[k], hgt = (b.v || 0) / mx * hh; c.fillStyle = b.c >= b.o ? set.cs.bu : set.cs.bd; c.globalAlpha = .28; c.fillRect(Math.round(xOf(k) - bw2 / 2), PH - hgt, Math.max(1, Math.round(bw2)), hgt); } c.globalAlpha = 1; }
      if (d.k === "kz" && S.tf <= 60 && R.days){ c.font = "600 10px Inter,system-ui,sans-serif"; c.textBaseline = "bottom"; c.textAlign = "left";
        R.order.forEach(td => { const D = R.days[td]; Object.keys(D.kz).forEach(k => { const Z = D.kz[k], z = KZ[k], x1 = xOf(idxT(Z.t0)) - S.bw / 2, x2 = xOf(idxT(Z.t1)) + S.bw / 2; if (x2 < 0 || x1 > PW) return; const y1 = yOf(Z.h), y2 = yOf(Z.l); c.fillStyle = z[3]; c.globalAlpha = .09; c.fillRect(x1, y1, x2 - x1, y2 - y1); c.globalAlpha = .55; c.strokeStyle = z[3]; c.lineWidth = 1; c.strokeRect(x1 + .5, y1 + .5, x2 - x1 - 1, y2 - y1 - 1); c.globalAlpha = .9; c.fillStyle = z[3]; const nm = z[2].split("|"); c.fillText(EN() && nm[1] ? nm[1] : nm[0], x1 + 3, y1 - 2); c.globalAlpha = 1; }); }); }
    });
  }
  function indOver(c, P, a, i0, i1){
    const R = indCalc(); c.font = "600 10px Inter,system-ui,sans-serif"; c.textBaseline = "bottom";
    (set.ind || []).forEach(d => {
      if (d.on === false) return; const v = R[d.id];
      if ((d.k === "ema" || d.k === "sma" || d.k === "vwap") && v) lineSeries(c, a, v, i0, i1, d.col, d.lw);
      if (d.k === "bb" && v){ c.fillStyle = d.col; c.globalAlpha = .06; c.beginPath(); let st = -1; for (let k = Math.max(0, i0); k <= Math.min(a.length - 1, i1); k++){ if (v.u[k] == null) continue; if (st < 0){ c.moveTo(xOf(k), yOf(v.u[k])); st = k; } else c.lineTo(xOf(k), yOf(v.u[k])); } for (let k = Math.min(a.length - 1, i1); k >= Math.max(0, st); k--){ if (v.d[k] != null) c.lineTo(xOf(k), yOf(v.d[k])); } c.closePath(); if (st >= 0) c.fill(); c.globalAlpha = 1;
        lineSeries(c, a, v.u, i0, i1, d.col, d.lw); lineSeries(c, a, v.d, i0, i1, d.col, d.lw); lineSeries(c, a, v.m, i0, i1, d.col, 1, [4, 4]); }
      if ((d.k === "pdl" || d.k === "opn") && R.days && S.tf < 1440){ const L = R.order;
        L.forEach((td, k) => { const D = R.days[td], x1 = Math.max(0, xOf(idxT(D.t0)) - S.bw / 2), x2 = Math.min(PW, xOf(idxT(D.t1)) + S.bw / 2); if (x2 < 0 || x1 > PW) return;
          const hl = (y0, txt, from) => { const y = Math.round(yOf(y0)) + .5, xa = from != null ? Math.max(x1, xOf(idxT(from)) - S.bw / 2) : x1; c.strokeStyle = d.col; c.lineWidth = d.lw || 1.2; c.setLineDash([6, 4]); c.beginPath(); c.moveTo(xa, y); c.lineTo(x2, y); c.stroke(); c.setLineDash([]); c.fillStyle = d.col; c.textAlign = "right"; c.fillText(txt, x2 - 3, y - 2); };
          if (d.k === "pdl" && k > 0){ const Pd = R.days[L[k - 1]]; hl(Pd.h, "PDH"); hl(Pd.l, "PDL"); }
          if (d.k === "opn"){ if (D.mo) hl(D.mo.p, T("Půlnoc", "Midnight"), D.mo.t); if (D.o930) hl(D.o930.p, "9:30", D.o930.t); } }); }
    });
    c.textAlign = "left";
  }
  function panePaint(c, P, a, i0, i1, d, y0, hh){
    const v = indCalc()[d.id]; c.save(); c.beginPath(); c.rect(0, y0, W, hh); c.clip();
    c.strokeStyle = P.axis; c.lineWidth = 1; c.beginPath(); c.moveTo(0, y0 + .5); c.lineTo(W, y0 + .5); c.stroke();
    let lo, hi; if (d.k === "rsi"){ lo = 0; hi = 100; } else { lo = Infinity; hi = -Infinity; for (let k = Math.max(0, i0); k <= Math.min(a.length - 1, i1); k++){ if (v && v[k] != null){ lo = Math.min(lo, v[k]); hi = Math.max(hi, v[k]); } } if (!isFinite(lo)){ lo = 0; hi = 1; } const pd = (hi - lo) * .12 || 1; lo -= pd; hi += pd; }
    const Y = val => y0 + 6 + (hi - val) / (hi - lo) * (hh - 12);
    if (d.k === "rsi"){ c.fillStyle = d.col; c.globalAlpha = .06; c.fillRect(0, Y(70), PW, Y(30) - Y(70)); c.globalAlpha = 1; [30, 50, 70].forEach(l => { c.strokeStyle = P.axis; c.setLineDash([3, 4]); c.beginPath(); c.moveTo(0, Math.round(Y(l)) + .5); c.lineTo(PW, Math.round(Y(l)) + .5); c.stroke(); c.setLineDash([]); c.fillStyle = P.muted; c.font = "500 10px Inter,system-ui,sans-serif"; c.textAlign = "left"; c.textBaseline = "middle"; c.fillText(String(l), PW + 8, Y(l)); }); }
    if (v){ c.save(); c.beginPath(); c.rect(0, y0, PW, hh); c.clip(); c.strokeStyle = d.col; c.lineWidth = d.lw || 1.5; c.beginPath(); let on = false; for (let k = Math.max(0, i0 - 1); k <= Math.min(a.length - 1, i1 + 1); k++){ if (v[k] == null){ on = false; continue; } const x = xOf(k), y = Y(v[k]); if (!on){ c.moveTo(x, y); on = true; } else c.lineTo(x, y); } c.stroke(); c.restore();
      const lv = v[a.length - 1]; if (lv != null){ c.fillStyle = d.col; rrect(c, PW + 2, Y(lv) - 9, AXW - 4, 18, 4); c.fill(); c.fillStyle = "#fff"; c.font = "600 11px Inter,system-ui,sans-serif"; c.textAlign = "left"; c.textBaseline = "middle"; c.fillText(num(lv, d.k === "rsi" ? 1 : 2), PW + 7, Y(lv)); } }
    const m = S.mouse; let hv = v ? v[a.length - 1] : null; if (m && m.x < PW && v){ const k = Math.round(iOf(m.x)); if (v[k] != null) hv = v[k]; }
    c.fillStyle = P.muted; c.font = "600 11px Inter,system-ui,sans-serif"; c.textAlign = "left"; c.textBaseline = "top"; c.fillText(indLabel(d), 8, y0 + 5); if (hv != null){ c.fillStyle = d.col; c.fillText(num(hv, d.k === "rsi" ? 1 : 2), 14 + c.measureText(indLabel(d)).width, y0 + 5); }
    c.restore();
  }
  function indLegend(){
    if (!ui || !ui.ileg) return; const box = ui.ileg, R = indCalc(), a = agg().a, m = S.mouse; let k = a.length - 1; if (m && m.x < PW){ const j = Math.round(iOf(m.x)); if (j >= 0 && j < a.length) k = j; }
    const list = (set.ind || []).filter(d => !IND[d.k].pane), sig = list.map(d => d.id + (d.on === false ? 0 : 1)).join();
    if (box.dataset.sig !== sig){ box.dataset.sig = sig; box.innerHTML = ""; list.forEach(d => { const ch = mk("button", "rp-il" + (d.on === false ? " off" : "")); ch.type = "button"; ch.dataset.id = d.id; const dot = mk("i"); dot.style.background = d.col || (d.k === "kz" ? "conic-gradient(#7c4dff,#2196f3,#16b67f,#ff9800,#7c4dff)" : d.k === "vol" ? "linear-gradient(90deg," + set.cs.bu + " 50%," + set.cs.bd + " 50%)" : P0()); ch.appendChild(dot); ch.appendChild(mk("span", null, indLabel(d))); ch.appendChild(mk("b")); ch.addEventListener("click", () => indDialog(d.id)); box.appendChild(ch); }); }
    box.querySelectorAll(".rp-il").forEach(ch => { const d = (set.ind || []).find(x => x.id === ch.dataset.id); if (!d) return; const v = R[d.id], bEl = ch.querySelector("b"); let txt = ""; if (d.on !== false && v){ if (d.k === "bb"){ if (v.m[k] != null) txt = num(v.u[k], 2) + " / " + num(v.d[k], 2); } else if (Array.isArray(v) && v[k] != null) txt = num(v[k], 2); if (d.k === "vwap" && R[d.id + "nv"]) txt += T(" (bez objemu)", " (no volume)"); } bEl.textContent = txt; });
  }
  const P0 = () => "#9e9e9e";
  function indAdd(k){ const D = IND[k], d = {id: "i" + Date.now().toString(36) + Math.floor(Math.random() * 1e3), k: k, on: true}; if (D.p) d.p = D.p; if (D.m) d.m = D.m; if (D.col) d.col = D.col; if (D.lw) d.lw = D.lw; if (k === "ema" && (set.ind || []).some(x => x.k === "ema")) { d.p = 50; d.col = "#2962ff"; } set.ind = (set.ind || []).concat([d]); saveSet(); IC.key = ""; req(); return d; }
  function indDialog(focus){
    const pop = ui.indp; if (!pop.hidden && !focus){ pop.hidden = true; return; } pop.innerHTML = ""; pop.hidden = false; ui.setp.hidden = true;
    const hd = mk("div", "rp-ih"); hd.appendChild(mk("b", null, T("Indikátory", "Indicators"))); hd.appendChild(btn("rp-no", "✕", () => { pop.hidden = true; }, T("Zavřít", "Close"))); pop.appendChild(hd);
    const add = mk("div", "rp-iadd"); Object.keys(IND).forEach(k => add.appendChild(btn("chip", "+ " + indName(k), () => { const d = indAdd(k); indDialog(d.id); }))); pop.appendChild(add);
    const lst = mk("div", "rp-ilist"); if (!(set.ind || []).length) lst.appendChild(mk("p", "small muted", T("Zatím žádný indikátor. Přidej si třeba EMA 21 a VWAP.", "No indicators yet. Try EMA 21 and VWAP.")));
    (set.ind || []).forEach(d => { const row = mk("div", "rp-irow" + (d.id === focus ? " focus" : "")), upd = () => { saveSet(); IC.key = ""; ui.ileg.dataset.sig = ""; req(); };
      if (d.col != null){ const sw = btn("rp-csw", null, null, T("Barva", "Colour")); const i = mk("i"); i.style.background = d.col; sw.appendChild(i); sw.addEventListener("click", ev => { ev.stopPropagation(); cpal(sw, d.col, v => { d.col = v; i.style.background = v; upd(); }); }); row.appendChild(sw); } else row.appendChild(mk("span", "rp-iph"));
      row.appendChild(mk("b", null, indName(d.k)));
      const fl = (lab, key, st, mn) => { const l = mk("label", "rp-if"); l.appendChild(mk("span", "small muted", lab)); const i = mk("input"); i.type = "number"; i.step = st; i.min = mn; i.value = d[key]; i.addEventListener("change", () => { const v = parseFloat(String(i.value).replace(",", ".")); if (v >= mn){ d[key] = v; upd(); } }); l.appendChild(i); row.appendChild(l); };
      if (d.p != null) fl(T("Perioda", "Length"), "p", 1, 1); if (d.m != null) fl(T("Odchylky", "StdDev"), "m", .1, .1); if (d.lw != null) fl(T("Tloušťka", "Width"), "lw", .5, .5);
      const eye = btn("rp-ieye" + (d.on === false ? " off" : ""), d.on === false ? T("Skryto", "Hidden") : T("Vidět", "Shown"), () => { d.on = d.on === false; eye.classList.toggle("off", d.on === false); eye.textContent = d.on === false ? T("Skryto", "Hidden") : T("Vidět", "Shown"); upd(); }); row.appendChild(eye);
      row.appendChild(ibtn("del", T("Odebrat", "Remove"), () => { set.ind = set.ind.filter(x => x !== d); upd(); indDialog(); }, "rp-odel")); lst.appendChild(row); });
    pop.appendChild(lst);
    pop.appendChild(mk("p", "small muted", T("Hodnoty se počítají jen ze svíček, které už replay odhalil. Denní úrovně (PDH, PDL, půlnoc, 9:30) a killzóny jsou podle newyorského času.", "Values use only candles the replay has revealed. Day levels (PDH, PDL, midnight, 9:30) and killzones follow New York time.")));
  }

  // ---------- measure tool and bar picker ----------
  function measPaint(c, P){
    const M = S.meas, x1 = xOf(idxT(M.a.t)), x2 = xOf(idxT(M.b.t)), y1 = yOf(M.a.p), y2 = yOf(M.b.p), up = M.b.p >= M.a.p, col = up ? "#2196f3" : "#f0475a";
    c.fillStyle = col; c.globalAlpha = .14; c.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); c.globalAlpha = 1; c.strokeStyle = col; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo((x1 + x2) / 2, y1); c.lineTo((x1 + x2) / 2, y2); c.moveTo(x1, (y1 + y2) / 2); c.lineTo(x2, (y1 + y2) / 2); c.stroke();
    const dp = M.b.p - M.a.p, bars = Math.round(idxT(M.b.t) - idxT(M.a.t)), mins = Math.round(Math.abs(M.b.t - M.a.t)), pct = M.a.p ? dp / M.a.p * 100 : 0, I = inst(), q = set.size === "qty" ? +set.qty || 1 : 1;
    const l1 = (dp >= 0 ? "+" : "−") + num(Math.abs(dp), 2) + T(" b. (", " pts (") + (pct >= 0 ? "+" : "−") + num(Math.abs(pct), 2) + " %) · " + usd(dp * I.pv * q).replace("+", "") + (set.size === "qty" ? " / " + num(q, 0) + " " + I.n : T(" / 1 kontrakt", " / 1 contract"));
    const l2 = Math.abs(bars) + T(" svíček · ", " bars · ") + (mins >= 1440 ? num(mins / 1440, 1) + T(" dne", " days") : mins >= 60 ? Math.floor(mins / 60) + " h " + (mins % 60) + " min" : mins + " min");
    c.font = "600 11.5px Inter,system-ui,sans-serif"; const w = Math.max(c.measureText(l1).width, c.measureText(l2).width) + 18, bx = (x1 + x2) / 2 - w / 2, by = up ? Math.min(y1, y2) - 48 : Math.max(y1, y2) + 8;
    c.fillStyle = col; rrect(c, bx, by, w, 40, 7); c.fill(); c.fillStyle = "#fff"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(l1, bx + w / 2, by + 13); c.fillText(l2, bx + w / 2, by + 28);
  }
  function pickAt(x){
    const t = tIdx(Math.round(iOf(x))), k = S.B.findIndex(b => b.t > t + S.tf - 1), want = k < 0 ? S.B.length : k;
    if (S.draws.some(d => d.k === "pos" && d.st && d.st !== "plan" && d.st !== "draft" && (d.t1 >= t || (d.tx != null && d.tx >= t)))){ toast(T("Před obchod se vrátit nejde. Vyber místo za posledním obchodem.", "You can't go back before a trade. Pick a spot after your last trade.")); return; }
    S.pick = false; ui.pickHint.hidden = true; S.draws = S.draws.filter(d => d.st !== "draft"); if (want > S.pos){ while (S.pos < want){ if (!step1()) break; } } else S.pos = Math.max(2, want); S.ended = false; S.follow = true; S.off = 14; after(); toast(T("Replay pokračuje od ", "Replay continues from ") + hm(last().t));
  }
  // ---------- 90-minute cycles (training) ----------
  function cycOf(t){ const m = modOf(t); for (let k = 0; k < 6; k++) if (m >= CYC[k] && m < CYC[k + 1]) return k; return -1; }
  function cycRange(k, upto){ const lb = S.B[upto - 1]; if (!lb) return null; const td = tdOf(lb.t); let hi = -Infinity, lo = Infinity, any = false; for (let i = upto - 1; i >= 0 && i >= upto - 1500; i--){ const b = S.B[i]; if (tdOf(b.t) !== td) break; if (cycOf(b.t) === k){ hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); any = true; } } return any ? {hi: hi, lo: lo} : null; }
  function cycPaint(c, P){
    const lb = last(); if (!lb) return; const base = dayBase(tdOf(lb.t));
    CYC.forEach(t => { const x = Math.round(xOf(idxT(base + t))) + .5; if (x < 0 || x > PW) return; c.strokeStyle = P.acc; c.globalAlpha = .35; c.setLineDash([2, 4]); c.beginPath(); c.moveTo(x, 0); c.lineTo(x, PH); c.stroke(); c.setLineDash([]); c.globalAlpha = 1; });
    const k = cycOf(lb.t); if (k < 1) return; const pv = cycRange(k - 1, S.pos); if (!pv) return;
    const xs = Math.max(0, xOf(idxT(base + CYC[k - 1]))); c.font = "600 10px Inter,system-ui,sans-serif"; c.textAlign = "left"; c.textBaseline = "bottom";
    [[pv.hi, "PCH"], [pv.lo, "PCL"]].forEach(l => { const y = Math.round(yOf(l[0])) + .5; c.strokeStyle = "#c58aff"; c.fillStyle = "#c58aff"; c.setLineDash([5, 4]); c.beginPath(); c.moveTo(xs, y); c.lineTo(PW, y); c.stroke(); c.setLineDash([]); c.fillText(l[1], xs + 4, y - 2); });
  }
  function cycQuiz(k){
    const pv = cycRange(k - 1, S.pos), cur = cycRange(k, S.pos); if (!pv || !cur || !ui) return false;
    const td = tdOf(last().t); let iH = -1, iL = -1, a = -1, b = -1; for (let i = Math.max(0, S.pos - 1500); i < S.pos; i++){ const x = S.B[i]; if (tdOf(x.t) !== td || cycOf(x.t) !== k) continue; if (a < 0) a = i; b = i; if (iH < 0 && x.h > pv.hi) iH = i; if (iL < 0 && x.l < pv.lo) iL = i; }
    const first = iH < 0 && iL < 0 ? "none" : iL < 0 || (iH >= 0 && iH < iL) ? "high" : iH < 0 || iL < iH ? "low" : "both", up = S.B[b].c >= S.B[a].o;
    const names = T("1. dopolední|2. dopolední|3. dopolední|Oběd|1. odpolední|2. odpolední", "1st morning|2nd morning|3rd morning|Lunch|1st afternoon|2nd afternoon").split("|");
    const qs = [[T("Cyklus „", "The ") + names[k] + T("“ skončil. Kterou stranu předchozího cyklu cena vybrala jako první?", " cycle ended. Which side of the previous cycle did price take first?"), [["high", "High (PCH)"], ["low", "Low (PCL)"], ["none", T("Žádnou", "Neither")]], first === "both" ? ["high", "low"] : [first]],
      [T("Kde cyklus zavřel proti své otevírací ceně?", "Where did the cycle close against its open?"), [["up", T("Nad ní", "Above it")], ["down", T("Pod ní", "Below it")]], [up ? "up" : "down"]]];
    const box = ui.quiz; box.innerHTML = ""; box.hidden = false; let st = 0, ok = 0;
    const show = () => { box.innerHTML = ""; if (st >= qs.length){ box.appendChild(mk("span", "small", T("Správně ", "Correct ") + ok + "/" + qs.length)); box.appendChild(btn("primary", T("Pokračovat", "Continue"), () => { box.hidden = true; })); return; }
      const q = qs[st]; box.appendChild(mk("b", null, q[0])); const row = mk("div", "rp-qrow"); let done = false;
      const bs = q[1].map(o => { const b2 = btn("chip", o[1], () => { if (done) return; done = true; const good = q[2].indexOf(o[0]) >= 0; if (good) ok++; else b2.classList.add("no"); bs.forEach((x, j) => { if (q[2].indexOf(q[1][j][0]) >= 0) x.classList.add("ok"); }); row.appendChild(btn("primary", T("Dál", "Next"), () => { st++; show(); })); }); row.appendChild(b2); return b2; });
      box.appendChild(row); };
    show(); return true;
  }

  // ---------- replay engine ----------
  function fillOrTrigger(d, b){
    if (d.st === "pending"){
      const hit = d.ot === "lim" ? (d.dir > 0 ? b.l <= d.e : b.h >= d.e) : (d.dir > 0 ? b.h >= d.e : b.l <= d.e);
      if (!hit) return; let px = d.e; if (d.ot === "stp" && (d.dir > 0 ? b.o > d.e : b.o < d.e)) px = b.o; if (d.ot === "lim" && (d.dir > 0 ? b.o < d.e : b.o > d.e)) px = b.o;
      d.e = px; d.st = "open"; d.t1 = b.t; d.sl0 = d.sl; toast(T("Pokyn vyplněn: ", "Order filled: ") + (d.dir > 0 ? "Long" : "Short") + " @ " + num(px, 2));
      const slNow = d.dir > 0 ? b.l <= d.sl : b.h >= d.sl; if (slNow) close(d, d.sl, b.t, "loss"); return;
    }
    if (d.st !== "open") return;
    const r0 = Math.abs(d.e - d.sl0) || 1, fav = (d.dir > 0 ? b.h - d.e : d.e - b.l) / r0, adv = (d.dir > 0 ? d.e - b.l : b.h - d.e) / r0;
    const slHit = d.dir > 0 ? b.l <= d.sl : b.h >= d.sl, tpHit = d.dir > 0 ? b.h >= d.tp : b.l <= d.tp;
    d.mae = Math.max(d.mae || 0, Math.min(adv, slHit ? Math.abs(d.e - d.sl) / r0 : adv)); if (!slHit) d.mfe = Math.max(d.mfe || 0, Math.min(fav, tpHit ? Math.abs(d.tp - d.e) / r0 : fav));
    if (slHit){ let px = d.sl; if (d.dir > 0 ? b.o < d.sl : b.o > d.sl) px = b.o; close(d, px, b.t, "sl"); return; }
    if (tpHit){ let px = d.tp; if (d.dir > 0 ? b.o > d.tp : b.o < d.tp) px = b.o; close(d, px, b.t, "tp"); return; }
    if (+set.ptp > 0 && !d.pt && fav >= +set.ptp) partial(d, rt(d.e + d.dir * set.ptp * r0), b.t, (+set.ptpPct || 50) / 100, "ptp");
    if (+set.abe > 0 && !d.beDone && fav >= +set.abe && (d.dir > 0 ? d.sl < d.e : d.sl > d.e)){ d.sl = d.e; d.beDone = 1; toast(T("Stop posunutý na nulu (", "Stop moved to breakeven (") + num(set.abe, 1) + " R)"); }
  }
  function record(d, px, t, why, q){
    const I = inst(), r0 = Math.abs(d.e - d.sl0) || 1, q0 = d.q0 || d.q, r = d.dir * (px - d.e) / r0 * (q / q0), $ = d.dir * (px - d.e) * q * I.pv - (+set.comm || 0) * q;
    const rec = {id: d.id, acct: set.acct, day: tdOf(d.t1), sym: I.n, demo: S.demo || "", dir: d.dir, e: d.e, sl: d.sl0, tp: d.tp, ex: px, t1: d.t1, tx: t, q: q, q0: q0, r: Math.round(r * 100) / 100, usd: Math.round($ * 100) / 100, why: why, ts: new Date().toISOString(), tf: S.tf, mfe: Math.round((d.mfe || 0) * 100) / 100, mae: Math.round((d.mae || 0) * 100) / 100, tags: d.tags || [], note: d.note || ""};
    if (why === "ptp" || why === "part") rec.part = 1; hist.push(rec); saveHist(); d.rAcc = (d.rAcc || 0) + rec.r; d.usdAcc = (d.usdAcc || 0) + rec.usd; return rec;
  }
  function partial(d, px, t, frac, why){
    const I = inst(); let qp = I.step >= 1 ? Math.floor(d.q * frac) : Math.floor(d.q * frac / I.step) * I.step; qp = Math.round(qp * 1000) / 1000;
    if (qp < I.step || qp >= d.q){ if (why === "part"){ toast(T("Jeden kontrakt rozdělit nejde, zavři celou pozici.", "One contract can't be split; close the whole position.")); } d.pt = 1; return; }
    if (!d.q0) d.q0 = d.q; const rec = record(d, px, t, why, qp); d.q = Math.round((d.q - qp) * 1000) / 1000; d.pt = 1;
    toast(T("Vybráno ", "Took ") + num(qp, I.step < 1 ? 3 : 0) + " " + I.n + " @ " + num(px, 2) + " · " + rr(rec.r) + " · " + usd(rec.usd)); statsPaint(); posList();
  }
  function close(d, px, t, why){
    if (!d.q0) d.q0 = d.q; record(d, px, t, why, d.q); const parts = hist.filter(h => h.id === d.id && h.acct === set.acct);
    d.ex = px; d.tx = t; d.r = Math.round(parts.reduce((a, h) => a + h.r, 0) * 100) / 100; d.usd = Math.round(parts.reduce((a, h) => a + h.usd, 0) * 100) / 100; d.st = d.r > .02 ? "win" : d.r < -.02 ? "loss" : "be";
    try { const j = API().jr(); j.paper = j.paper || []; j.paper.push({ts: new Date().toISOString(), r: d.r, setup: "Replay", usd: d.usd}); API().store(); API().touchDay(); } catch(e){}
    promo(); toast((d.r >= 0 ? "✓ " : "✕ ") + (why === "tp" ? T("Cíl zasažen", "Target hit") : why === "sl" ? (d.beDone && Math.abs(d.sl - d.e) < tick() ? T("Stop na nule", "Breakeven stop") : T("Stop zasažen", "Stop hit")) : T("Pozice zavřena", "Position closed")) + " · " + rr(d.r) + " · " + usd(d.usd));
    S.tagFor = d.id; statsPaint(); posList();
  }
  function step1(){
    if (S.pos >= S.B.length){ stop(); return false; }
    const prevC = last() ? cycOf(last().t) : -1, b = S.B[S.pos]; S.pos++;
    S.draws.forEach(d => { if (d.k === "pos") fillOrTrigger(d, b); });
    S.draws.forEach(d => { if (d.k === "pos" && d.st === "draft" && d.follow){ const dp = b.c - d.e, dt = grp(b.t, S.tf) - d.t1; d.e = b.c; d.sl = rt(d.sl + dp); d.tp = rt(d.tp + dp); if (dt > 0){ d.t1 += dt; d.t2 += dt; } } });
    const td = tdOf(b.t); if (td !== S.day){ S.day = td; if (ui) libPaint(); }
    if (set.cyc && prevC >= 1 && cycOf(b.t) !== prevC && cycQuiz(prevC)){ stop(); return false; }
    return true;
  }
  function stepTF(n){ for (let k = 0; k < n; k++){ const lb = last(); if (!lb){ step1(); continue; } const g = grp(lb.t, S.tf); while (S.pos < S.B.length && grp(S.B[S.pos].t, S.tf) === g){ if (!step1()) return after(); } if (!step1()) return after(); } after(); }
  let sessT = 0;
  function after(){ const now = Date.now(); if (now - sessT > 800){ sessT = now; saveSess(); } posList(); ctlPaint(); req(); if (EX){ examPaint(); if (S.pos >= S.B.length && !EX.done){ EX.done = 1; setTimeout(() => examFinish(true), 300); } } if (S.pos >= S.B.length && !S.ended){ S.ended = true; toast(T("Konec nahraných dat. Otevřené pozice zavírám za poslední cenu.", "End of the loaded data. Closing open positions at the last price.")); S.draws.forEach(d => { if (d.k === "pos" && d.st === "open") close(d, last().c, last().t, "eod"); if (d.k === "pos" && d.st === "pending") d.st = "cancel"; }); S.draws = S.draws.filter(d => d.st !== "cancel"); req(); } }
  function back(){
    if (EX){ toast(T("Ve zkoušce se nedá vracet zpět.", "You cannot rewind during an exam.")); return; }
    if (S.pos <= 2) return; const b = S.B[S.pos - 1];
    if (S.draws.some(d => d.k === "pos" && (d.st === "open" || ["win", "loss", "be", "closed"].indexOf(d.st) >= 0) && (d.t1 >= b.t || (d.tx != null && d.tx >= b.t)))){ toast(T("Zpátky před vstup nebo výstup obchodu to nejde.", "You can't rewind past a trade entry or exit.")); return; }
    S.pos--; S.ended = false; after();
  }
  function play(){ if (S.playing){ stop(); return; } if (S.pos >= S.B.length) return; S.playing = true; ctlPaint(); const ms = Math.max(16, 1000 / (+set.speed || 1)); S.timer = setInterval(() => { const ok = step1(); after(); if (!ok) stop(); }, ms); }
  function stop(){ if (S.timer){ clearInterval(S.timer); S.timer = null; } if (S.playing){ S.playing = false; ctlPaint(); } }
  function jump(m){
    stop(); const lb = last(); if (!lb) return; const base = dayBase(tdOf(lb.t)), t = m >= 1080 ? base - 1440 + m : base + m; const target = S.B.findIndex(b => b.t >= t); const want = target < 0 ? S.B.length : target + 1;
    if (want >= S.pos){ while (S.pos < want){ if (!step1()) break; } after(); return; }
    const first = S.B[want - 1].t; if (S.draws.some(d => d.k === "pos" && d.st && d.st !== "plan" && d.st !== "draft" && (d.t1 >= first || (d.tx != null && d.tx >= first)))){ toast(T("Zpátky před obchod to nejde. Vyber jiný den.", "Can't rewind before a trade. Pick another day.")); return; }
    S.pos = Math.max(2, want); S.ended = false; after();
  }
  const saveSess = () => { if (!S.demo && S.day && last()) LS("tape-rp-sess", {day: S.day, at: last().t, tf: S.tf}); };

  // the chart holds the chosen day plus the days around it, so earlier days can be scrolled back and the replay runs on into the next ones
  function loadDay(d, startAt){
    if (EX && !EX.loading && d.day !== EX.day){ EX = null; LS("tape-rp-exam", null); examPaint(); toast(T("Zkouška je zrušená, otevřel jsi jiný den.", "The exam is cancelled, you opened another day.")); }
    stop(); S.demo = d.demo || ""; const L = lib(), k = Math.max(0, L.findIndex(x => x.day === d.day)), win = L.slice(Math.max(0, k - 60), k + 16);
    const B = []; win.forEach(w => { const sh = w.ny || w.demo ? 0 : (+set.tz || 0); w.bars.forEach(x => { const ts = String(x[0]); B.push({t: dayBase(ts.slice(0, 10)) + +ts.slice(11, 13) * 60 + +ts.slice(14, 16) + sh, o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] || 0}); }); });
    B.sort((a, b) => a.t - b.t); const B2 = []; S.ethData = false; B.forEach(b => { const m = modOf(b.t); if (m < 420 || m >= 960) S.ethData = true; if (set.sess === "rth" && (m < 570 || m >= 960)) return; if (!B2.length || b.t !== B2[B2.length - 1].t) B2.push(b); }); S.B = B2;
    const t0 = S.B.length ? S.B[0].t : 0, t1 = S.B.length ? S.B[S.B.length - 1].t + 1440 * 3 : 0;
    const all = S.demo ? [] : (drawStore.all || []); S.drawOut = all.filter(x => { const a = anchor(x); return !(a >= t0 && a <= t1); });
    S.draws = all.filter(x => { const a = anchor(x); return a >= t0 && a <= t1; }).map(x => Object.assign({}, x, {id: uid++}));
    const byId = {}; AH().filter(h => !h.demo && !S.demo && h.t1 >= t0 && h.t1 <= t1).forEach(h => { (byId[h.id] = byId[h.id] || []).push(h); });
    Object.keys(byId).forEach(id => { const ps = byId[id], h = ps[ps.length - 1], r = ps.reduce((a, x) => a + x.r, 0), u = ps.reduce((a, x) => a + x.usd, 0), tx = Math.max.apply(null, ps.map(x => x.tx)); S.draws.push({k: "pos", id: uid++, dir: h.dir, e: h.e, sl: h.sl, sl0: h.sl, tp: h.tp, t1: h.t1, t2: Math.max(tx, h.t1 + 20 * (h.tf || 1)), q: h.q0 || h.q, q0: h.q0 || h.q, ex: h.ex, tx: tx, r: Math.round(r * 100) / 100, usd: Math.round(u * 100) / 100, st: r > .02 ? "win" : r < -.02 ? "loss" : "be", ot: "mkt"}); });
    const base = dayBase(d.day); let p0 = S.B.findIndex(b => b.t >= base + 540); if (p0 < 0) p0 = S.B.findIndex(b => tdOf(b.t) === d.day) + 1; if (p0 <= 0) p0 = Math.floor(S.B.length * .5);
    if (startAt != null){ const q = S.B.findIndex(b => b.t > startAt); p0 = q < 0 ? S.B.length : q; }
    if (!S.demo){ const done = AH().filter(h => !h.demo && h.tx >= t0 && h.tx <= t1).map(h => h.tx); if (startAt != null && done.length){ const lx = Math.max.apply(null, done), q = S.B.findIndex(b => b.t > lx); if (q > p0) p0 = q; } }
    S.pos = clamp(p0, 2, S.B.length); S.day = tdOf(S.B[S.pos - 1].t);
    S.sel = null; S.yMan = null; S.follow = true; S.off = 14; S.bw = window.innerWidth < 700 ? 6 : 9; S.ended = false; if (ui && ui.quiz) ui.quiz.hidden = true;
    UND = []; RED = []; lastSnap = snapNow(); IC.key = ""; if (ui && ui.ileg) ui.ileg.dataset.sig = "";
    saveSess(); libPaint(); after(); statsPaint(); promo();
  }

  // ---------- interaction ----------
  function hit(x, y){
    const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 9;
    const segD = (px, py, x1, y1, x2, y2) => { const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy; let t = l ? ((px - x1) * dx + (py - y1) * dy) / l : 0; t = clamp(t, 0, 1); return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)); };
    const P = {x: x, y: y}, list = S.draws.slice().reverse();
    for (const d of list){
      if (d.k === "pos"){ const g = posGeo(d), editable = d.st !== "win" && d.st !== "loss" && d.st !== "be" && d.st !== "closed";
        if (editable && (S.sel === d || d.st)){ if (near(P, {x: g.x1, y: g.ys})) return {d: d, h: "sl"}; if (near(P, {x: g.x1, y: g.yt})) return {d: d, h: "tp"}; if (d.st !== "open" && near(P, {x: g.x1, y: g.ye})) return {d: d, h: "e"}; if (near(P, {x: g.x2, y: g.ye})) return {d: d, h: "w"}; }
        if (d.lock && d.st === "plan"){ if (x >= g.x1 && x <= g.x2 && y >= Math.min(g.ys, g.yt) && y <= Math.max(g.ys, g.yt)) return {d: d, h: "sel"}; continue; }
        const top = Math.min(g.ys, g.yt), bot = Math.max(g.ys, g.yt); if (x >= g.x1 && x <= g.x2 && y >= top && y <= bot) return {d: d, h: editable && (d.st === "open") ? "sel" : editable ? "move" : "sel"};
        if (editable && Math.abs(y - g.ys) < 5 && x >= g.x1 - 4 && x <= g.x2) return {d: d, h: "sl"}; if (editable && Math.abs(y - g.yt) < 5 && x >= g.x1 - 4 && x <= g.x2) return {d: d, h: "tp"};
        continue; }
      if (d.k === "h"){ if (Math.abs(y - yOf(d.p)) < 6) return {d: d, h: d.lock ? "sel" : "move"}; continue; }
      if (d.k === "txt"){ const tx = xOf(idxT(d.a.t)), ty = yOf(d.a.p), fs = d.fs || 14; if (x >= tx - 4 && x <= tx + (d._w || 40) + 4 && y >= ty - fs * .7 && y <= ty + (d._h || fs) ) return {d: d, h: d.lock ? "sel" : "move"}; continue; }
      const x1 = xOf(idxT(d.a.t)), y1 = yOf(d.a.p), x2 = xOf(idxT(d.b.t)), y2 = yOf(d.b.p);
      if (d.lock){ if (segD(x, y, x1, y1, x2, y2) < 6 || (d.k !== "line" && d.k !== "ray" && x >= Math.min(x1, x2) && x <= Math.max(x1, x2) + (d.k === "fib" ? 60 : 0) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2))) return {d: d, h: "sel"}; continue; }
      if (near(P, {x: x1, y: y1})) return {d: d, h: "a"}; if (near(P, {x: x2, y: y2})) return {d: d, h: "b"};
      if (d.k === "line" || d.k === "ray" || d.k === "fib"){ if (segD(x, y, x1, y1, x2, y2) < 6) return {d: d, h: "move"}; if (d.k === "fib"){ const xl = Math.min(x1, x2), xr = Math.max(x1, x2) + 60; if (x >= xl && x <= xr && y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) return {d: d, h: "move"}; } }
      if (d.k === "rect" && x >= Math.min(x1, x2) - 4 && x <= Math.max(x1, x2) + 4 && y >= Math.min(y1, y2) - 4 && y <= Math.max(y1, y2) + 4) return {d: d, h: "move"};
    }
    return null;
  }
  function ptAt(x, y, snap){
    let i = iOf(x), p = pOf(y);
    if (snap && set.magnet){ const a = agg().a, k = Math.round(i), b = a.find(z => z.i === k); if (b){ const opts = [b.h, b.l, b.o, b.c]; let best = null; opts.forEach(v => { const dy = Math.abs(yOf(v) - y); if (dy < 12 && (!best || dy < best.dy)) best = {v: v, dy: dy}; }); if (best){ p = best.v; i = k; } } }
    return {t: tIdx(i), p: rt(p)};
  }
  function sty(d){ const st = (set.ds || {})[d.k === "ray" ? "line" : d.k]; if (st) ["col", "lw", "ls", "fo"].forEach(k => { if (st[k] != null) d[k] = st[k]; }); return d; }
  function newPos(dir, t, p, st){
    const d0 = Math.max(rt(atr(14) * 1.5), tick() * 4), d = {k: "pos", id: uid++, dir: dir, t1: t, t2: tIdx(idxT(t) + 30), e: rt(p), sl: rt(p - dir * d0), tp: rt(p + dir * d0 * 2), st: st};
    return d;
  }
  function onDown(ev){
    if (!S.B.length) return; const r = ui.cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top; ui.cv.setPointerCapture(ev.pointerId);
    S.ptrs = S.ptrs || {}; S.ptrs[ev.pointerId] = {x: x, y: y};
    if (Object.keys(S.ptrs).length === 2){ const ps = Object.values(S.ptrs); S.pinch = {d: Math.abs(ps[0].x - ps[1].x) || 1, bw: S.bw, mid: (ps[0].x + ps[1].x) / 2, R: rightIdx()}; S.drag = null; return; }
    if (x > PW){ S.drag = {k: "ys", y: y, lo: yLo, hi: yHi}; return; }
    if (y > TY){ S.drag = {k: "xs", x: x, bw: S.bw, R: rightIdx()}; return; }
    if (y > PH){ S.drag = {k: "pan", x: x, y: y, R: rightIdx(), lo: yLo, hi: yHi, nov: 1}; return; }
    if (S.pick){ pickAt(x); return; }
    if (S.tool === "meas" || (ev.shiftKey && S.tool === "cur")){ S.meas = {a: {t: tIdx(iOf(x)), p: pOf(y)}, b: {t: tIdx(iOf(x)), p: pOf(y)}, live: 1}; S.drag = {k: "meas"}; req(); return; }
    if (S.meas && !S.meas.live){ S.meas = null; req(); }
    if (S.creating && S.creating.stage === 2){ finishCreate(); return; }
    if (S.tool !== "cur"){
      const pt = ptAt(x, y, true), tool = S.tool;
      if (tool === "txt"){ const d = sty({k: "txt", id: uid++, a: {t: pt.t, p: pOf(y)}, s: T("Text", "Text"), fs: 14}); S.draws.push(d); S.sel = d; setTool("cur"); saveDraw(); req(); setTimeout(() => { const i = ui.otb.querySelector(".rp-otxt"); if (i){ i.focus(); i.select(); } }, 60); return; }
      if (tool === "h"){ const d = sty({k: "h", id: uid++, p: pt.p, t: pt.t}); S.draws.push(d); S.sel = d; setTool("cur"); saveDraw(); req(); return; }
      if (tool === "long" || tool === "short"){ const d = newPos(tool === "long" ? 1 : -1, pt.t, pt.p, "plan"); S.draws.push(d); S.sel = d; setTool("cur"); saveDraw(); req(); return; }
      S.creating = {d: sty({k: tool, id: uid++, a: pt, b: Object.assign({}, pt)}), x: x, y: y, stage: 1}; req(); return;
    }
    const h = hit(x, y);
    if (h){ S.sel = h.d; if (h.h !== "sel") S.drag = {k: "obj", h: h.h, d: h.d, x: x, y: y, orig: JSON.parse(JSON.stringify(h.d))}; else S.drag = {k: "pan", x: x, y: y, R: rightIdx(), lo: yLo, hi: yHi}; posList(); req(); return; }
    S.sel = null; S.drag = {k: "pan", x: x, y: y, R: rightIdx(), lo: yLo, hi: yHi}; req();
  }
  function onMove(ev){
    const r = ui.cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top; S.mouse = {x: x, y: y};
    if (S.ptrs && S.ptrs[ev.pointerId]) S.ptrs[ev.pointerId] = {x: x, y: y};
    if (S.pinch && S.ptrs && Object.keys(S.ptrs).length === 2){ const ps = Object.values(S.ptrs), d = Math.abs(ps[0].x - ps[1].x) || 1; S.bw = clamp(S.pinch.bw * d / S.pinch.d, 1.5, 70); const im = S.pinch.R - (PW - S.pinch.mid) / S.pinch.bw; setR(im + (PW - S.pinch.mid) / S.bw); req(); return; }
    if (S.creating){ const pt = ptAt(x, y, true); S.creating.d.b = pt; req(); return; }
    const D = S.drag;
    if (D && D.k === "meas"){ S.meas.b = {t: tIdx(iOf(x)), p: pOf(y)}; req(); return; }
    if (!D){ const h = S.B.length && x < PW && y < PH && !S.pick ? hit(x, y) : null; ui.cv.style.cursor = S.pick ? "col-resize" : x > PW ? "ns-resize" : y > TY ? "ew-resize" : y > PH ? "grab" : S.tool !== "cur" ? "crosshair" : h ? (h.h === "sl" || h.h === "tp" || h.h === "e" ? "ns-resize" : h.h === "w" ? "ew-resize" : h.h === "sel" ? "pointer" : "move") : "crosshair"; req(); return; }
    if (D.k === "pan"){ setR(D.R - (x - D.x) / S.bw); if (!D.nov && (S.yMan || Math.abs(y - D.y) > 12)){ const rng = D.hi - D.lo, dp = (y - D.y) / PH * rng; S.yMan = {lo: D.lo + dp, hi: D.hi + dp}; } req(); return; }
    if (D.k === "ys"){ const f = Math.exp((y - D.y) / 160), mid = (D.lo + D.hi) / 2, rng = (D.hi - D.lo) * f; S.yMan = {lo: mid - rng / 2, hi: mid + rng / 2}; req(); return; }
    if (D.k === "xs"){ const f = Math.exp((D.x - x) / 140); S.bw = clamp(D.bw * f, 1.5, 70); const im = D.R - PW / 2 / D.bw; setR(im + PW / 2 / S.bw); req(); return; }
    if (D.k === "obj"){ dragObj(D, x, y); req(); }
  }
  function setR(R){ const a = agg().a, L = a.length ? a[a.length - 1].i : 0; if (R >= L + 2){ S.follow = true; S.off = Math.min(R - L, 80); } else { S.follow = false; S.R = R; } }
  function dragObj(D, x, y){
    const d = D.d, o = D.orig, p = rt(pOf(y)), di = iOf(x) - iOf(D.x), sh = t => tIdx(idxT(t) + di), dp = pOf(y) - pOf(D.y), lb = last();
    if (d.k === "pos"){
      if (D.h === "sl"){ let v = p; if (d.st === "open" && lb) v = d.dir > 0 ? Math.min(v, lb.c - tick()) : Math.max(v, lb.c + tick()); else v = d.dir > 0 ? Math.min(v, d.e - tick()) : Math.max(v, d.e + tick()); d.sl = rt(v); }
      else if (D.h === "tp"){ let v = p; if (d.st === "open" && lb) v = d.dir > 0 ? Math.max(v, lb.c + tick()) : Math.min(v, lb.c - tick()); else v = d.dir > 0 ? Math.max(v, d.e + tick()) : Math.min(v, d.e - tick()); d.tp = rt(v); }
      else if (D.h === "e"){ const ne = rt(clamp(p, Math.min(d.sl, d.tp) + tick(), Math.max(d.sl, d.tp) - tick())); if (d.st === "draft" && lb){ if (d.ot === "mkt" && Math.abs(ne - lb.c) >= tick()){ d.ot = d.dir * (ne - lb.c) < 0 ? "lim" : "stp"; set.ot = d.ot; saveSet(); if (ui) ui.pOT.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.ot === d.ot)); } } d.e = ne; d.follow = d.ot === "mkt" && Math.abs(ne - (lb ? lb.c : ne)) < tick(); if (d.st === "draft" && d.ot === "mkt") d.e = lb.c; }
      else if (D.h === "w"){ d.t2 = Math.max(tIdx(idxT(d.t1) + 3), sh(o.t2)); }
      else if (D.h === "move" && (!d.st || d.st === "plan")){ d.t1 = sh(o.t1); d.t2 = sh(o.t2); d.e = rt(o.e + dp); d.sl = rt(o.sl + dp); d.tp = rt(o.tp + dp); }
      if (d.st === "open" || d.st === "pending" || d.st === "draft") posList();
      return; }
    if (d.k === "h"){ d.p = rt(o.p + dp); return; }
    if (d.k === "txt"){ d.a = {t: sh(o.a.t), p: o.a.p + dp}; return; }
    if (D.h === "a"){ d.a = ptAt(x, y, true); return; } if (D.h === "b"){ d.b = ptAt(x, y, true); return; }
    d.a = {t: sh(o.a.t), p: rt(o.a.p + dp)}; d.b = {t: sh(o.b.t), p: rt(o.b.p + dp)};
  }
  function onUp(ev){
    if (S.ptrs) delete S.ptrs[ev.pointerId]; if (S.pinch && (!S.ptrs || Object.keys(S.ptrs).length < 2)) S.pinch = null;
    if (S.creating && S.creating.stage === 1){ const r = ui.cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top; if (Math.hypot(x - S.creating.x, y - S.creating.y) < 5){ S.creating.stage = 2; return; } finishCreate(); return; }
    if (S.drag && S.drag.k === "obj"){ saveDraw(); }
    if (S.drag && S.drag.k === "meas"){ S.meas.live = 0; if (S.tool === "meas") setTool("cur"); }
    S.drag = null;
  }
  function finishCreate(){ const d = S.creating.d; S.creating = null; if (Math.abs(d.a.t - d.b.t) < 1e-6 && Math.abs(d.a.p - d.b.p) < 1e-9){ req(); return; } S.draws.push(d); S.sel = d; setTool("cur"); saveDraw(); req(); }
  function onWheel(ev){
    if (!S.B.length) return; ev.preventDefault(); const r = ui.cv.getBoundingClientRect(), x = ev.clientX - r.left;
    if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) && !ev.ctrlKey){ setR(rightIdx() + ev.deltaX / S.bw); req(); return; }
    const f = Math.exp(-ev.deltaY * (ev.ctrlKey ? .01 : .0018)), im = iOf(Math.min(x, PW)); S.bw = clamp(S.bw * f, 1.5, 70); setR(im + (PW - Math.min(x, PW)) / S.bw); req();
  }
  function onDbl(ev){ const r = ui.cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top; if (x > PW || y > TY){ S.yMan = null; S.follow = true; S.off = 8; S.bw = 9; req(); } }
  // undo and redo of drawings (trades are never undone)
  let UND = [], RED = [], lastSnap = null, restoring = false;
  const isDraw = d => d.k !== "pos" || !d.st || d.st === "plan";
  const snapNow = () => JSON.stringify(S.draws.filter(isDraw).map(d => { const c = Object.assign({}, d); delete c.id; delete c._w; delete c._h; return c; }));
  function snapTrack(){ if (restoring) return; const sn = snapNow(); if (lastSnap != null && sn !== lastSnap){ UND.push(lastSnap); if (UND.length > 80) UND.shift(); RED = []; } lastSnap = sn; }
  function restore(sn){ restoring = true; S.draws = S.draws.filter(d => !isDraw(d)).concat(JSON.parse(sn).map(d => Object.assign(d, {id: uid++}))); S.sel = null; lastSnap = sn; saveDraw(); setTimeout(() => { restoring = false; }, 350); req(); }
  function undo(){ if (!UND.length){ toast(T("Není co vrátit.", "Nothing to undo.")); return; } RED.push(snapNow()); restore(UND.pop()); }
  function redo(){ if (!RED.length) return; UND.push(snapNow()); restore(RED.pop()); }
  function gotoMenu(anchor){
    const m = ui.gmenu; if (!m.hidden){ m.hidden = true; return; } m.innerHTML = ""; m.hidden = false;
    [[1200, T("Asie 20:00", "Asia 20:00")], [120, T("Londýn 2:00", "London 2:00")], [510, T("NY 8:30, zprávy", "NY 8:30, news")], [570, T("Otevření NY 9:30", "NY open 9:30")], [810, T("NY PM 13:30", "NY PM 13:30")], [960, T("Zavření 16:00", "Close 16:00")], [1080, T("Další obchodní den 18:00", "Next trading day 18:00")]].forEach(x => m.appendChild(btn("rp-cmi", x[1], () => { m.hidden = true; gotoNext(x[0]); })));
    const wr = ui.wrap.getBoundingClientRect(), ar = anchor.getBoundingClientRect(); m.style.left = Math.min(ar.left - wr.left, wr.width - 200) + "px"; m.style.top = (ar.bottom - wr.top + 6) + "px";
  }
  function gotoNext(mn){
    stop(); const lb = last(); if (!lb) return; let j = -1;
    for (let i = S.pos; i < S.B.length; i++){ const t = S.B[i].t, target = Math.floor(t / 1440) * 1440 + mn, pt = i > 0 ? S.B[i - 1].t : t - 1; if (t >= target && pt < target){ j = i; break; } }
    if (j < 0){ toast(T("V nahraných datech už další taková chvíle není.", "No such moment left in the loaded data.")); return; }
    S.draws.forEach(d => { if (d.st === "draft") d.follow = true; }); while (S.pos < j){ if (!step1()) break; } S.follow = true; S.off = 14; after();
  }
  function shot(){
    if (!S.B.length) return; paint(); const cv = ui.cv, dpr = window.devicePixelRatio || 1, P = pal(), o = document.createElement("canvas"), hh = 44 * dpr; o.width = cv.width; o.height = cv.height + hh; const c = o.getContext("2d");
    c.fillStyle = P.bg; c.fillRect(0, 0, o.width, o.height); c.drawImage(cv, 0, hh); c.scale(dpr, dpr); c.fillStyle = P.ink; c.font = "700 15px Inter,system-ui,sans-serif"; c.textBaseline = "middle"; c.textAlign = "left"; c.fillText(ui.ttl.textContent, 14, 22);
    c.fillStyle = P.muted; c.font = "600 12px Inter,system-ui,sans-serif"; c.textAlign = "right"; c.fillText("tape · " + ui.clock.textContent, o.width / dpr - 14, 22);
    o.toBlob(b => { if (!b) return; const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "tape-replay-" + S.day + "-" + hm(last().t).replace(":", "") + ".png"; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); toast(T("Obrázek grafu je stažený.", "Chart image downloaded.")); });
  }
  function helpPop(){
    const pop = ui.helpp; if (!pop.hidden){ pop.hidden = true; return; } pop.innerHTML = ""; pop.hidden = false;
    const hd = mk("div", "rp-ih"); hd.appendChild(mk("b", null, T("Klávesové zkratky", "Keyboard shortcuts"))); hd.appendChild(btn("rp-no", "✕", () => { pop.hidden = true; })); pop.appendChild(hd);
    const g = mk("div", "rp-keys"); [["Mezerník|Space", T("Přehrát a pauza", "Play and pause")], ["→", T("Další svíčka", "Next candle")], ["Shift + →", T("O 10 svíček", "10 candles")], ["←", T("Zpět o svíčku", "Back one candle")], ["V", T("Kurzor", "Cursor")], ["T", T("Trendová čára", "Trend line")], ["H", T("Horizontála", "Horizontal line")], ["R", T("Obdélník", "Rectangle")], ["F", T("Fibonacci s OTE", "Fibonacci with OTE")], ["X", "Text"], ["L / S", T("Long a short pozice", "Long and short position")], ["M", T("Pravítko", "Measure")], ["Shift + " + T("táhnout", "drag"), T("Rychlé měření", "Quick measure")], ["Ctrl + Z / Y", T("Zpět a znovu", "Undo and redo")], ["Del", T("Smazat vybrané", "Delete selected")], ["Esc", T("Zrušit", "Cancel")], [T("Kolečko", "Wheel"), T("Přiblížit a oddálit", "Zoom")], [T("Dvojklik na osu", "Double-click an axis"), T("Výchozí pohled", "Reset view")], ["?", T("Tahle nápověda", "This help")]].forEach(x => { const n = x[0].split("|"); g.appendChild(mk("kbd", null, EN() && n[1] ? n[1] : n[0])); g.appendChild(mk("span", "small", x[1])); }); pop.appendChild(g);
  }
  function setTool(t){ S.tool = t; S.creating = null; if (ui) ui.tools.querySelectorAll("button[data-t]").forEach(b => b.classList.toggle("on", b.dataset.t === t)); }
  function delSel(){ const d = S.sel; if (!d) return; if (d.k === "pos" && (d.st === "open")){ toast(T("Otevřenou pozici zavři tlačítkem Zavřít.", "Close an open position with the Close button.")); return; } if (d.k === "pos" && ["win", "loss", "be", "closed"].indexOf(d.st) >= 0){ toast(T("Hotový obchod zůstává v historii.", "A finished trade stays in the history.")); return; } S.draws = S.draws.filter(x => x !== d); S.sel = null; saveDraw(); posList(); req(); }
  function key(ev){
    if (!ui || !S.B.length) return; const tg = ev.target; if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || tg.isContentEditable)) return;
    if (location.hash !== "#backtest") return;
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "z" || ev.key === "Z")){ ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "y" || ev.key === "Y")){ ev.preventDefault(); redo(); return; }
    if (ev.key === "?"){ helpPop(); return; }
    if (ev.key === " "){ ev.preventDefault(); play(); } else if (ev.key === "ArrowRight"){ ev.preventDefault(); stop(); stepTF(ev.shiftKey ? 10 : 1); } else if (ev.key === "ArrowLeft"){ ev.preventDefault(); stop(); back(); }
    else if (ev.key === "Delete" || ev.key === "Backspace"){ if (S.sel){ ev.preventDefault(); delSel(); } } else if (ev.key === "Escape"){ if (ui.wrap.classList.contains("rp-fs") && !document.fullscreenElement) fsFake(false); S.pick = false; if (ui.pickHint) ui.pickHint.hidden = true; S.meas = null; setTool("cur"); S.sel = null; S.draws = S.draws.filter(d => d.st !== "draft"); posList(); req(); }
    else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey){ const m = {t: "line", h: "h", r: "rect", f: "fib", x: "txt", l: "long", s: "short", m: "meas", v: "cur"}[ev.key.toLowerCase()]; if (m) setTool(m); }
  }

  // ---------- orders from the corner panel ----------
  const OT = {mkt: ["Trh", "Market"], lim: ["Limit", "Limit"], stp: ["Stop", "Stop"]};
  const otName = k => T(OT[k][0], OT[k][1]);
  function entryFor(dir, ot){ const lb = last(), off = Math.max(rt(atr(14) * 1.2), tick() * 4); return ot === "lim" ? rt(lb.c - dir * off) : ot === "stp" ? rt(lb.c + dir * off) : lb.c; }
  function retype(d, ot){ const lb = last(), e = entryFor(d.dir, ot), dp = e - d.e; d.ot = ot; d.follow = ot === "mkt"; d.e = e; d.sl = rt(d.sl + dp); d.tp = rt(d.tp + dp); if (ot === "mkt"){ d.t1 = lb.t; } }
  function setOT(ot){ set.ot = ot; saveSet(); const d = S.draws.find(x => x.st === "draft"); if (d) retype(d, ot); if (ui) ui.pOT.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.ot === ot)); posList(); req(); }
  function draft(dir){
    if (!S.B.length) return; const lb = last(); S.draws = S.draws.filter(d => d.st !== "draft"); const d = newPos(dir, lb.t, lb.c, "draft"); d.follow = true; d.ot = "mkt"; if (set.ot !== "mkt") retype(d, set.ot); S.draws.push(d); S.sel = d; if (S.follow) S.off = Math.max(S.off, Math.min(40, Math.floor(PW / S.bw * .42))); posList(); req();
  }
  function confirm(d){
    const sz = sizing(d.e, d.sl); if (!sz){ toast(T("Nastav riziko nebo počet kontraktů.", "Set your risk or the number of contracts.")); return; }
    const lb = last(), ot = d.ot || "mkt";
    if (ot === "lim" && (d.dir > 0 ? d.e >= lb.c : d.e <= lb.c)){ toast(d.dir > 0 ? T("Limit long musí být pod aktuální cenou. Nad ní použij stop pokyn.", "A buy limit must be below the current price. Above it, use a stop order.") : T("Limit short musí být nad aktuální cenou. Pod ní použij stop pokyn.", "A sell limit must be above the current price. Below it, use a stop order.")); return; }
    if (ot === "stp" && (d.dir > 0 ? d.e <= lb.c : d.e >= lb.c)){ toast(d.dir > 0 ? T("Stop long musí být nad aktuální cenou. Pod ní použij limit.", "A buy stop must be above the current price. Below it, use a limit.") : T("Stop short musí být pod aktuální cenou. Nad ní použij limit.", "A sell stop must be below the current price. Above it, use a limit.")); return; }
    d.q = sz.q; d.q0 = sz.q; d.sl0 = d.sl;
    if (ot === "mkt"){ d.e = lb.c; d.st = "open"; d.t1 = lb.t; d.sl0 = d.sl; toast((d.dir > 0 ? "Long " : "Short ") + num(d.q, inst().step < 1 ? 3 : 0) + " " + inst().n + " @ " + num(d.e, 2) + T(" · riziko ", " · risk ") + "$" + num(sz.risk, 0)); }
    else { d.st = "pending"; toast(otName(ot) + " " + (d.dir > 0 ? "long" : "short") + T(" čeká na ", " waiting at ") + num(d.e, 2) + " · " + num(d.q, inst().step < 1 ? 3 : 0) + " " + inst().n); }
    S.sel = d; posList(); req();
  }
  function closeNow(d){ const lb = last(); if (d.st === "pending" || d.st === "draft"){ S.draws = S.draws.filter(x => x !== d); posList(); req(); return; } close(d, lb.c, lb.t, "manual"); req(); }
  function toBE(d){ const lb = last(); if (d.dir > 0 ? lb.c <= d.e : lb.c >= d.e){ toast(T("Na nulu jde stop posunout, až je pozice v zisku.", "Move the stop to breakeven once the position is in profit.")); return; } d.sl = d.e; posList(); req(); }

  // ---------- UI ----------
  const ICON = {
    cur: '<path d="M5 3l14 8-6 1.5L10 19z"/>', line: '<path d="M4 20L20 4"/><circle cx="4" cy="20" r="1.8"/><circle cx="20" cy="4" r="1.8"/>', ray: '<path d="M4 18L21 6"/><circle cx="4" cy="18" r="1.8"/>',
    h: '<path d="M3 12h18"/><circle cx="12" cy="12" r="1.8"/>', rect: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>', fib: '<path d="M4 5h16M4 10h16M4 14h16M4 19h16"/>',
    long: '<rect x="5" y="4" width="14" height="8" fill="currentColor" opacity=".25" stroke="none"/><path d="M5 12h14M5 4h14v16H5z"/><path d="M9 9l3-3 3 3" />', short: '<rect x="5" y="12" width="14" height="8" fill="currentColor" opacity=".25" stroke="none"/><path d="M5 12h14M5 4h14v16H5z"/><path d="M9 15l3 3 3-3"/>',
    del: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>', clr: '<path d="M4 4l16 16M20 4L4 20"/>', mag: '<path d="M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4z"/>',
    txt: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>', lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>', unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>', ext: '<path d="M4 18L20 6"/><path d="M15 6h5v5"/>', go: '<path d="M5 12h12M13 7l5 5-5 5"/>',
    fx: '<path d="M9 4c-2 0-3 1-3 3v13M3 10h7"/><path d="M13 10l7 9M20 10l-7 9"/>', meas: '<path d="M4 17L17 4l3 3L7 20z"/><path d="M8 13l2 2M11 10l2 2M14 7l2 2"/>', cut: '<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5L20 17M8 15.5L20 7"/>', cam: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', goto: '<path d="M4 12h12M12 6l6 6-6 6"/><path d="M20 5v14"/>', undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12h-2" transform="translate(0 -6)"/>', redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 12h2" transform="translate(0 -6)"/>', help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 015 0c0 2-2.5 2-2.5 4M12 17h.01"/>', rt: '<path d="M6 6l6 6-6 6M13 6l6 6-6 6"/>',
    unfull: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>', pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor"/>', next: '<path d="M5 4l10 8-10 8zM17 4h2v16h-2z" fill="currentColor"/>', prev: '<path d="M19 4L9 12l10 8zM5 4h2v16H5z" fill="currentColor"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>', grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>'
  };
  const svgI = n => '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[n] + '</svg>';
  function ibtn(n, title, fn, cls){ const b = btn("rp-ib" + (cls ? " " + cls : ""), null, fn, title); b.innerHTML = svgI(n); return b; }

  function legend(){
    if (!ui) return; const a = agg().a, m = S.mouse; let b = a[a.length - 1];
    if (m && m.x < PW && m.y < PH){ const k = Math.round(iOf(m.x)); b = a.find(z => z.i === k) || b; }
    const I = inst(), d = new Date(S.day + "T12:00:00"), ds = isNaN(d) ? S.day : d.toLocaleDateString(loc(), {weekday: "short", day: "numeric", month: "numeric", year: "numeric"});
    ui.ttl.textContent = (S.demo ? (S.demo === "SIM" ? T("Ukázka (vymyšlená data)", "Demo (invented data)") : "BTCUSDT · Binance") : I.n + " · " + I.full) + " · " + (TFS.find(x => x[0] === S.tf) || [0, S.tf + "m"])[1] + " · " + (EX ? T("zkouška, den je skrytý", "exam, the day is hidden") : ds);
    if (b){ const dc = I.tick < 1 && I.tick >= .25 ? 2 : 2, ch = b.c - b.o; ui.ohlc.innerHTML = ""; [["O", b.o], ["H", b.h], ["L", b.l], ["C", b.c]].forEach(x => { const s = mk("span", null, x[0] + " "); const v = mk("b", ch >= 0 ? "up" : "dn", num(x[1], dc)); s.appendChild(v); ui.ohlc.appendChild(s); }); ui.ohlc.appendChild(mk("span", ch >= 0 ? "up" : "dn", (ch >= 0 ? "+" : "") + num(ch, 2))); if (m && m.x < PW) ui.ohlc.appendChild(mk("span", null, S.tf >= 1440 ? new Date((b.t + 360) * 6e4).toLocaleDateString(loc(), {day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC"}) : new Date(b.t * 6e4).toLocaleDateString(loc(), {day: "numeric", month: "numeric", timeZone: "UTC"}) + " " + hm(b.t))); ui.clock.textContent = (last() ? new Date((last().t) * 6e4).toLocaleDateString(loc(), {day: "numeric", month: "numeric", timeZone: "UTC"}) + " " + hm(last().t) : "") + " NY"; }
  }
  // ---------- object toolbar (like TradingView): colour, width, style, fill, lock, clone, delete ----------
  const COLS = ["#a98bff", "#7c4dff", "#2962ff", "#2196f3", "#00bcd4", "#26a69a", "#16b67f", "#8bc34a", "#ffeb3b", "#ffb300", "#ff9800", "#ff5722", "#f0475a", "#e91e63", "#ec407a", "#9c27b0", "#ffffff", "#9e9e9e", "#1d1530"];
  function customSw(cur, fn){ const l = mk("label", "rp-cust"), ci = mk("input"); ci.type = "color"; ci.value = /^#[0-9a-f]{6}$/i.test(cur || "") ? cur : "#a98bff"; l.title = T("Vlastní barva", "Custom colour"); l.setAttribute("aria-label", l.title); ci.addEventListener("input", () => fn(ci.value)); l.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v10M7 12h10"/></svg>'; l.appendChild(ci); return l; }
  function palette(anchor, d, upd){
    let pp = ui.otb.querySelector(".rp-pal"); if (pp){ pp.remove(); return; } pp = mk("div", "rp-pal");
    COLS.forEach(c => { const b = btn("rp-sw" + ((d.col || "") === c ? " on" : ""), null, () => { d.col = c; anchor.firstChild.style.background = c; pp.remove(); upd(); }, c); b.style.background = c; pp.appendChild(b); });
    pp.appendChild(customSw(d.col, v => { d.col = v; anchor.firstChild.style.background = v; upd(); }));
    ui.otb.appendChild(pp);
  }
  function cpal(anchor, cur, set1){
    const old = ui.box.querySelector(".rp-cpal"); if (old){ old.remove(); if (old._a === anchor) return; }
    const pp = mk("div", "rp-pal rp-cpal"); pp._a = anchor;
    const EXT = COLS.concat(["#089981", "#f23645", "#0ecb81", "#f6465d", "#4caf50", "#d32f2f", "#5c5c68", "#e8e8ee"]);
    EXT.forEach(c => { const b = btn("rp-sw" + (cur === c ? " on" : ""), null, () => { set1(c); pp.remove(); }, c); b.style.background = c; pp.appendChild(b); });
    pp.appendChild(customSw(cur, set1));
    const br = ui.box.getBoundingClientRect(), ar = anchor.getBoundingClientRect(); pp.style.left = Math.min(ar.left - br.left, br.width - 240) + "px"; ui.box.appendChild(pp); const hh = pp.offsetHeight || 120; pp.style.top = (ar.bottom - br.top + 6 + hh > br.height ? Math.max(4, ar.top - br.top - hh - 6) : ar.bottom - br.top + 6) + "px";
  }
  function clone(d){ const c = JSON.parse(JSON.stringify(d)); c.id = uid++; delete c._w; c.lock = false; const shf = t => tIdx(idxT(t) + 5); if (c.a) c.a.t = shf(c.a.t); if (c.b) c.b.t = shf(c.b.t); if (c.t1 != null){ c.t1 = shf(c.t1); c.t2 = shf(c.t2); } if (c.k === "h") c.p = rt(c.p + tick() * 8); S.draws.push(c); S.sel = c; saveDraw(); req(); }
  function planToOrder(d){
    const lb = last(); if (!lb) return; S.draws = S.draws.filter(x => x.st !== "draft"); const ot = Math.abs(d.e - lb.c) < tick() ? "mkt" : d.dir * (d.e - lb.c) < 0 ? "lim" : "stp";
    if (ot === "mkt"){ const dp = lb.c - d.e; d.e = lb.c; d.sl = rt(d.sl + dp); d.tp = rt(d.tp + dp); d.follow = true; d.t1 = grp(lb.t, S.tf); } else d.follow = false;
    d.st = "draft"; d.ot = ot; d.lock = false; set.ot = ot; saveSet(); if (ui) ui.pOT.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.ot === ot)); saveDraw(); posList(); req(); toast(T("Pozice je připravená jako pokyn. Potvrď ho v panelu.", "The position is ready as an order. Confirm it in the panel."));
  }
  function otbPaint(){
    if (!ui) return; const d = S.sel, box = ui.otb, ok = d && S.draws.indexOf(d) >= 0 && (d.k !== "pos" || d.st === "plan");
    if (!ok){ if (!box.hidden){ box.hidden = true; ui.otbId = null; } return; }
    if (ui.otbId === d.id && !box.hidden) return; ui.otbId = d.id; box.innerHTML = ""; box.hidden = false;
    const upd = () => { const k = d.k === "ray" ? "line" : d.k; set.ds = set.ds || {}; set.ds[k] = {col: d.col, lw: d.lw, ls: d.ls, fo: d.fo}; saveSet(); saveDraw(); req(); };
    const grp2 = () => { const g = mk("div", "rp-og"); box.appendChild(g); return g; };
    if (d.k !== "pos"){
      const g1 = grp2(), cb = btn("rp-oc", null, null, T("Barva", "Colour")); cb.innerHTML = "<i></i>"; cb.firstChild.style.background = d.col || pal().draw; cb.addEventListener("click", () => palette(cb, d, upd)); g1.appendChild(cb);
      if (d.k !== "txt"){
        const wg = mk("div", "rp-seg rp-ow"); [1, 2, 3, 4].forEach(w => { const b = btn((d.lw || 1) === w ? "on" : "", null, () => { d.lw = w; wg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); upd(); }, T("Tloušťka ", "Width ") + w + " px"); b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 12h16" stroke-width="' + w + '"/></svg>'; wg.appendChild(b); }); g1.appendChild(wg);
        const sg = mk("div", "rp-seg rp-ow"); [["s", "M4 12h16", T("Plná", "Solid")], ["d", "M3 12h5M10 12h5M17 12h4", T("Čárkovaná", "Dashed")], ["o", "M4 12h.1M8 12h.1M12 12h.1M16 12h.1M20 12h.1", T("Tečkovaná", "Dotted")]].forEach(x => { const b = btn((d.ls || "s") === x[0] ? "on" : "", null, () => { d.ls = x[0]; sg.querySelectorAll("button").forEach(y => y.classList.toggle("on", y === b)); upd(); }, x[2]); b.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + x[1] + '" stroke-width="2" stroke-linecap="round"/></svg>'; sg.appendChild(b); }); g1.appendChild(sg);
      }
      if (d.k === "rect" || d.k === "fib"){ const fl = mk("label", "rp-ofl"), r = mk("input"); r.type = "range"; r.min = 0; r.max = 50; r.value = Math.round(100 * (d.fo != null ? d.fo : d.k === "fib" ? .1 : .13)); r.title = T("Výplň", "Fill"); r.addEventListener("input", () => { d.fo = r.value / 100; upd(); }); fl.appendChild(mk("span", "small muted", T("Výplň", "Fill"))); fl.appendChild(r); grp2().appendChild(fl); }
      if (d.k === "line" || d.k === "ray"){ const b = ibtn("ext", T("Prodloužit doprava", "Extend right"), () => { d.k = d.k === "ray" ? "line" : "ray"; b.classList.toggle("on", d.k === "ray"); saveDraw(); req(); }); b.classList.toggle("on", d.k === "ray"); grp2().appendChild(b); }
      if (d.k === "h"){ const b = btn("chip rp-otog" + (d.lab !== false ? " on" : ""), T("Cena", "Price"), () => { d.lab = d.lab === false; b.classList.toggle("on", d.lab !== false); saveDraw(); req(); }, T("Zobrazit cenu", "Show price")); grp2().appendChild(b); }
      if (d.k === "txt"){ const g = grp2(), ti = mk("textarea", "rp-otxt"); ti.rows = 1; ti.value = d.s || ""; ti.setAttribute("aria-label", T("Text", "Text")); ti.addEventListener("input", () => { d.s = ti.value; saveDraw(); req(); }); ti.addEventListener("keydown", e => e.stopPropagation());
        const fs = mk("select"); [11, 12, 14, 16, 20, 24, 30].forEach(v => { const o = mk("option", null, v + " px"); o.value = v; if (v === (d.fs || 14)) o.selected = true; fs.appendChild(o); }); fs.addEventListener("change", () => { d.fs = +fs.value; saveDraw(); req(); }); fs.setAttribute("aria-label", T("Velikost písma", "Font size")); g.appendChild(ti); g.appendChild(fs); }
    } else { grp2().appendChild(btn("chip rp-otog on", T("Použít jako pokyn", "Use as order"), () => planToOrder(d), T("Z nakreslené pozice udělá limit, stop nebo tržní pokyn", "Turns the drawn position into a limit, stop or market order"))); }
    const g3 = grp2(), lk = ibtn(d.lock ? "lock" : "unlock", d.lock ? T("Odemknout", "Unlock") : T("Zamknout", "Lock"), () => { d.lock = !d.lock; lk.innerHTML = svgI(d.lock ? "lock" : "unlock"); lk.classList.toggle("on", !!d.lock); lk.title = d.lock ? T("Odemknout", "Unlock") : T("Zamknout", "Lock"); saveDraw(); req(); }); lk.classList.toggle("on", !!d.lock);
    g3.appendChild(lk); g3.appendChild(ibtn("copy", T("Duplikovat", "Clone"), () => clone(d))); g3.appendChild(ibtn("del", T("Smazat (Del)", "Delete (Del)"), () => delSel(), "rp-odel"));
  }
  function ctxMenu(ev){
    ev.preventDefault(); const r = ui.cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top, h = x < PW && y < PH ? hit(x, y) : null; let m = ui.cm; m.innerHTML = ""; m.hidden = false;
    const it = (t, fn, cls) => { const b = btn("rp-cmi" + (cls ? " " + cls : ""), t, () => { m.hidden = true; fn(); }); m.appendChild(b); };
    if (h && (h.d.k !== "pos" || h.d.st === "plan")){ S.sel = h.d; it(T("Duplikovat", "Clone"), () => clone(h.d)); it(h.d.lock ? T("Odemknout", "Unlock") : T("Zamknout", "Lock"), () => { h.d.lock = !h.d.lock; ui.otbId = null; saveDraw(); req(); }); if (h.d.k === "pos") it(T("Použít jako pokyn", "Use as order"), () => planToOrder(h.d)); it(T("Smazat", "Delete"), () => delSel(), "rp-cmd"); }
    else { it(T("Resetovat pohled", "Reset view"), () => { S.yMan = null; S.follow = true; S.off = 14; req(); }); it(T("Long pozice sem", "Long position here"), () => { const pt = ptAt(x, y, false), d = newPos(1, pt.t, pt.p, "plan"); S.draws.push(d); S.sel = d; saveDraw(); req(); }); it(T("Short pozice sem", "Short position here"), () => { const pt = ptAt(x, y, false), d = newPos(-1, pt.t, pt.p, "plan"); S.draws.push(d); S.sel = d; saveDraw(); req(); }); it(T("Horizontála sem", "Horizontal line here"), () => { const pt = ptAt(x, y, false), d = sty({k: "h", id: uid++, p: pt.p, t: pt.t}); S.draws.push(d); S.sel = d; saveDraw(); req(); }); }
    const br = ui.box.getBoundingClientRect(); m.style.left = Math.min(x, br.width - 190) + "px"; m.style.top = Math.min(y, br.height - m.offsetHeight - 6) + "px"; req();
  }
  function panelPaint(){
    if (!ui) return; const lb = last(), dr = S.draws.find(d => d.st === "draft"), I = inst();
    ui.pSell.querySelector("b").textContent = lb ? num(lb.c, 2) : "–"; ui.pBuy.querySelector("b").textContent = lb ? num(lb.c, 2) : "–";
    const rk = riskUsd(); ui.pRisk.textContent = set.size === "qty" ? T("Velikost ", "Size ") + num(set.qty, I.step < 1 ? 3 : 0) + " " + I.n : T("Riziko ", "Risk ") + (set.mode === "%" ? num(set.risk, 2) + " % = " : "") + "$" + num(rk, 0) + " · " + I.n;
    ui.pSize.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.sz === set.size)); ui.pQty.hidden = set.size !== "qty"; if (document.activeElement !== ui.pQtyI) ui.pQtyI.value = set.qty; ui.pQtyI.step = I.step; ui.pQtyU.textContent = I.n;
    ui.pConf.hidden = !dr; if (dr){ const sz = sizing(dr.e, dr.sl), ot = dr.ot || "mkt"; ui.pOk.textContent = (ot === "mkt" ? T("Vstoupit ", "Enter ") + (dr.dir > 0 ? "long" : "short") + T(" za trh", " at market") : otName(ot) + " " + (dr.dir > 0 ? "long" : "short") + " @ " + num(dr.e, 2)) + (sz ? " · " + num(sz.q, I.step < 1 ? 3 : 0) + " " + I.n + " · $" + num(sz.risk, 0) : ""); ui.pOk.className = "rp-ok " + (dr.dir > 0 ? "buy" : "sell"); }
  }
  function posList(){
    if (!ui) return; const box = ui.pos; box.innerHTML = ""; const lb = last(), I = inst();
    const live = S.draws.filter(d => d.k === "pos" && (d.st === "open" || d.st === "pending"));
    const tagRecs = S.tagFor ? hist.filter(h => h.id === S.tagFor && h.acct === set.acct) : [];
    if (!live.length && !tagRecs.length){ box.hidden = true; panelPaint(); return; } box.hidden = false;
    if (tagRecs.length){ const tr = tagRecs[tagRecs.length - 1], tb = mk("div", "rp-tagbox"), tot = tagRecs.reduce((a, h) => a + h.r, 0);
      tb.appendChild(mk("b", tot >= 0 ? "pos" : "neg", T("Obchod zavřen ", "Trade closed ") + rr(tot) + T(". Označ si ho:", ". Tag it:")));
      const TG = set.tags || [T("A+ setup", "A+ setup"), "Sweep", "MSS", "FVG", "Order block", "Breaker", T("Podle plánu", "By the plan"), T("Chyba", "Mistake"), "FOMO"], row = mk("div", "rp-tags");
      const cur = new Set(tr.tags || []); TG.forEach(g => { const b = btn("chip" + (cur.has(g) ? " on" : ""), g, () => { if (cur.has(g)) cur.delete(g); else cur.add(g); b.classList.toggle("on"); tagRecs.forEach(h => h.tags = Array.from(cur)); saveHist(); }); row.appendChild(b); }); tb.appendChild(row);
      const ni2 = mk("input"); ni2.placeholder = T("Poznámka k obchodu (nepovinné)", "Note on the trade (optional)"); ni2.value = tr.note || ""; ni2.addEventListener("input", () => { tagRecs.forEach(h => h.note = ni2.value); saveHist(); }); ni2.addEventListener("keydown", e => e.stopPropagation()); tb.appendChild(ni2);
      tb.appendChild(btn("primary", T("Hotovo", "Done"), () => { S.tagFor = null; statsPaint(); posList(); })); box.appendChild(tb); }
    live.forEach(d => { const row = mk("div", "rp-prow"), pnl = d.st === "open" && lb ? d.dir * (lb.c - d.e) * d.q * I.pv : 0, r = d.st === "open" && lb ? d.dir * (lb.c - d.e) / Math.abs(d.e - d.sl0) : 0;
      row.appendChild(mk("span", "rp-dir " + (d.dir > 0 ? "buy" : "sell"), d.dir > 0 ? "Long" : "Short"));
      row.appendChild(mk("span", "small", num(d.q, I.step < 1 ? 3 : 0) + " " + I.n + " @ " + num(d.e, 2) + (d.st === "pending" ? " · " + otName(d.ot || "lim") + T(" čeká", " pending") : "")));
      row.appendChild(mk("span", "small muted", "SL " + num(d.sl, 2) + " · TP " + num(d.tp, 2)));
      if (d.st === "open"){ const rq = d.q / (d.q0 || d.q), done = (d.rAcc || 0); row.appendChild(mk("b", pnl >= 0 ? "pos" : "neg", rr(r * rq + done) + " · " + usd(pnl + (d.usdAcc || 0)))); row.appendChild(mk("span", "small muted", "MFE " + num(d.mfe || 0, 2) + "R · MAE " + num(d.mae || 0, 2) + "R")); }
      const act = mk("div", "rp-pact"); if (d.st === "open"){ act.appendChild(btn("chip", T("Stop na nulu", "Stop to BE"), () => toBE(d))); act.appendChild(btn("chip", T("Zavřít polovinu", "Close half"), () => { const lb2 = last(); partial(d, lb2.c, lb2.t, .5, "part"); req(); })); } act.appendChild(btn("chip", d.st === "pending" ? T("Zrušit", "Cancel") : T("Zavřít", "Close"), () => closeNow(d))); row.appendChild(act);
      box.appendChild(row); });
    panelPaint();
  }
  function ctlPaint(){
    if (!ui) return; ui.play.innerHTML = svgI(S.playing ? "pause" : "play"); ui.play.title = S.playing ? T("Pauza (mezerník)", "Pause (space)") : T("Přehrát (mezerník)", "Play (space)");
    ui.tfs.querySelectorAll("button").forEach(b => b.classList.toggle("on", +b.dataset.tf === S.tf));
    ui.prog.style.width = (S.B.length ? 100 * S.pos / S.B.length : 0) + "%";
    const lb = last(); if (lb && document.activeElement !== ui.jt) ui.jt.value = hm(lb.t);
  }
  function libPaint(){
    if (!ui) return; const sel = ui.daySel; sel.innerHTML = "";
    if (!lib().length){ const o = mk("option", null, T("Žádná data", "No data")); sel.appendChild(o); sel.disabled = true; }
    else { sel.disabled = false; lib().forEach(d => { const o = mk("option", null, d.day); o.value = d.day; if (d.day === S.day) o.selected = true; sel.appendChild(o); }); }
    ui.libInfo.textContent = (S.B.length && !S.ethData && !S.demo && set.sess === "eth" ? T("Tato data mají jen 7:00–16:00 NY. Pro Asii a Londýn nahraj CSV s celou seancí znovu. ", "This data only covers 7:00–16:00 NY. Re-upload a full-session CSV for Asia and London. ") : "") + (S.days.length ? T("V zařízení ", "Stored on this device: ") + S.days.length + T(" dní · ", " days · ") + S.days[0].day + " – " + S.days[S.days.length - 1].day : T("Data zůstávají jen v tomto zařízení.", "Data stays on this device only."));
  }
  const SESS = [[1080, 1440, "Asie|Asia"], [0, 120, "Asie|Asia"], [120, 510, "Londýn|London"], [510, 720, "NY AM"], [720, 1020, "NY PM"], [1020, 1080, "Mimo|Off"]];
  const sessOf = t => { const m = modOf(t), z = SESS.find(x => m >= x[0] && m < x[1]) || SESS[5], n = z[2].split("|"); return EN() && n[1] ? n[1] : n[0]; };
  function tradesOf(){
    const g = {}; AH().forEach(h => { const k = h.id + "|" + h.t1; (g[k] = g[k] || []).push(h); });
    return Object.keys(g).map(k => { const ps = g[k], f = ps[0], L = ps[ps.length - 1]; return {id: f.id, day: f.day, dir: f.dir, e: f.e, sl: f.sl, tp: L.tp, t1: f.t1, tx: Math.max.apply(null, ps.map(x => x.tx)), ex: L.ex, why: L.why, r: Math.round(ps.reduce((a, x) => a + x.r, 0) * 100) / 100, usd: Math.round(ps.reduce((a, x) => a + x.usd, 0) * 100) / 100, q: f.q0 || f.q, mfe: Math.max.apply(null, ps.map(x => x.mfe || 0)), mae: Math.max.apply(null, ps.map(x => x.mae || 0)), tags: L.tags || [], note: L.note || "", parts: ps.length, demo: f.demo, sym: f.sym, ts: L.ts}; }).sort((a, b) => a.t1 - b.t1 || (a.ts < b.ts ? -1 : 1));
  }
  function statsPaint(){
    if (!ui) return; const box = ui.stats; box.innerHTML = ""; const F = ui.f || (ui.f = {scope: "all", dir: 0, tag: "", tab: "an"});
    const allT = tradesOf(), tagsAll = Array.from(new Set([].concat.apply([], allT.map(t => t.tags)))).sort();
    const all = allT.filter(t => (F.scope !== "day" || t.day === S.day) && (!F.dir || t.dir === F.dir) && (!F.tag || t.tags.indexOf(F.tag) >= 0));
    // filters
    const fl = mk("div", "rp-filt"), seg = (opts, cur, fn) => { const g2 = mk("div", "rp-seg"); opts.forEach(o => { const b = btn(o[0] === cur ? "on" : "", o[1], () => { fn(o[0]); statsPaint(); }); g2.appendChild(b); }); return g2; };
    fl.appendChild(seg([["all", T("Vše", "All")], ["day", T("Tento den", "This day")]], F.scope, v => F.scope = v)); fl.appendChild(seg([[0, T("Oba směry", "Both")], [1, "Long"], [-1, "Short"]], F.dir, v => F.dir = v));
    if (tagsAll.length){ const ts = mk("select", "rp-tsel"); [["", T("Všechny štítky", "All tags")]].concat(tagsAll.map(t => [t, t])).forEach(o => { const op = mk("option", null, o[1]); op.value = o[0]; if (o[0] === F.tag) op.selected = true; ts.appendChild(op); }); ts.addEventListener("change", () => { F.tag = ts.value; statsPaint(); }); fl.appendChild(ts); }
    box.appendChild(fl);
    const n = all.length, w = all.filter(h => h.r > .02), l = all.filter(h => h.r < -.02), tr = all.reduce((a, h) => a + h.r, 0), tu = all.reduce((a, h) => a + h.usd, 0);
    const gw = w.reduce((a, h) => a + h.usd, 0), gl = -l.reduce((a, h) => a + h.usd, 0); let pk = 0, cum = 0, dd = 0, sw = 0, sl2 = 0, bw2 = 0, bl = 0; all.forEach(h => { cum += h.r; pk = Math.max(pk, cum); dd = Math.min(dd, cum - pk); if (h.r > .02){ sw++; sl2 = 0; } else if (h.r < -.02){ sl2++; sw = 0; } else { sw = 0; sl2 = 0; } bw2 = Math.max(bw2, sw); bl = Math.max(bl, sl2); });
    const avg = arr => arr.length ? arr.reduce((a, h) => a + h.r, 0) / arr.length : 0, best = n ? Math.max.apply(null, all.map(h => h.r)) : 0, worst = n ? Math.min.apply(null, all.map(h => h.r)) : 0;
    const tiles = mk("div", "rp-tiles"), tl = (k, v, cls, tip) => { const t = mk("div", "rp-tile"); if (tip) t.title = tip; t.appendChild(mk("span", null, k)); t.appendChild(mk("b", cls || null, v)); tiles.appendChild(t); };
    tl(T("Obchodů", "Trades"), String(n)); tl("Winrate", n ? Math.round(100 * w.length / n) + " %" : "–"); tl(T("Celkem", "Total"), n ? rr(tr) : "–", tr >= 0 ? "pos" : "neg"); tl("P&L", n ? usd(tu) : "–", tu >= 0 ? "pos" : "neg");
    tl("Profit factor", gl > 0 ? num(gw / gl, 2) : n ? "∞" : "–"); tl(T("Očekávaná hodnota", "Expectancy"), n ? rr(tr / n) : "–", tr >= 0 ? "pos" : "neg", T("Průměrný výsledek jednoho obchodu v R", "Average result per trade in R")); tl(T("Průměrná výhra", "Average win"), w.length ? rr(avg(w)) : "–", "pos"); tl(T("Průměrná ztráta", "Average loss"), l.length ? rr(avg(l)) : "–", "neg");
    tl(T("Nejlepší", "Best"), n ? rr(best) : "–", best >= 0 ? "pos" : "neg"); tl(T("Nejhorší", "Worst"), n ? rr(worst) : "–", worst >= 0 ? "pos" : "neg"); tl(T("Výher v řadě", "Win streak"), String(bw2)); tl(T("Ztrát v řadě", "Loss streak"), String(bl));
    tl("Max DD", n ? rr(dd) : "–", "neg"); tl(T("Průměrné MFE", "Average MFE"), n ? num(all.reduce((a, h) => a + h.mfe, 0) / n, 2) + " R" : "–", null, T("Jak daleko šla cena v průměru ve tvůj prospěch", "How far price went your way on average")); tl(T("Průměrné MAE", "Average MAE"), n ? num(all.reduce((a, h) => a + h.mae, 0) / n, 2) + " R" : "–", null, T("Jak daleko šla cena v průměru proti tobě", "How far price went against you on average")); tl(T("Zůstatek", "Balance"), "$" + num(equity(), 0));
    box.appendChild(tiles);
    if (!n){ box.appendChild(window.TapeEmpty ? window.TapeEmpty("chart", T("Zatím žádný obchod.", "No trades yet."), T("Klikni na Long nebo Short v rohu grafu, natáhni stop a cíl a potvrď vstup.", "Click Long or Short in the corner of the chart, drag the stop and target and confirm the entry.")) : mk("p", "small muted", T("Zatím žádný obchod. Klikni na Long nebo Short v rohu grafu, natáhni stop a cíl a potvrď vstup.", "No trades yet. Click Long or Short in the chart corner, drag the stop and target and confirm."))); return; }
    // equity curve
    const cvE = mk("canvas", "rp-eq"); box.appendChild(cvE); requestAnimationFrame(() => { const dpr = window.devicePixelRatio || 1, w2 = cvE.clientWidth || 600, h2 = 120; cvE.width = w2 * dpr; cvE.height = h2 * dpr; const c = cvE.getContext("2d"), P = pal(); c.scale(dpr, dpr); let s2 = 0; const pts = [0].concat(all.map(h => (s2 += h.r))); const lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts), Y = v => 10 + (hi - v) / ((hi - lo) || 1) * (h2 - 20), X = i => 6 + i / Math.max(1, pts.length - 1) * (w2 - 12);
      c.strokeStyle = P.axis; c.setLineDash([3, 4]); c.beginPath(); c.moveTo(0, Y(0)); c.lineTo(w2, Y(0)); c.stroke(); c.setLineDash([]); const g = c.createLinearGradient(0, 0, 0, h2); g.addColorStop(0, s2 >= 0 ? "rgba(22,182,127,.28)" : "rgba(240,71,90,.28)"); g.addColorStop(1, "rgba(0,0,0,0)");
      c.beginPath(); pts.forEach((v, i) => i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))); c.lineTo(X(pts.length - 1), h2); c.lineTo(X(0), h2); c.closePath(); c.fillStyle = g; c.fill(); c.beginPath(); pts.forEach((v, i) => i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))); c.strokeStyle = s2 >= 0 ? "#16b67f" : "#f0475a"; c.lineWidth = 2; c.stroke();
      c.fillStyle = P.muted; c.font = "600 10.5px Inter,system-ui,sans-serif"; c.textAlign = "right"; c.textBaseline = "top"; c.fillText(T("Křivka v R", "Equity in R"), w2 - 8, 6); });
    // tabs
    const tabs = mk("div", "rp-seg rp-stabs"), body = mk("div", "rp-sbody"); [["an", T("Rozbor", "Breakdown")], ["cal", T("Kalendář", "Calendar")], ["dist", T("Rozložení R", "R distribution")], ["list", T("Obchody", "Trades")]].forEach(x => { const b = btn(F.tab === x[0] ? "on" : "", x[1], () => { F.tab = x[0]; statsPaint(); }); tabs.appendChild(b); });
    const exp = btn("chip rp-exp", T("Export CSV", "Export CSV"), () => exportCSV(all)); const th = mk("div", "rp-sth2"); th.appendChild(tabs); th.appendChild(exp); box.appendChild(th); box.appendChild(body);
    if (F.tab === "an"){
      const table = (title, groups) => { const t = mk("div", "rp-btab"); t.appendChild(mk("b", null, title)); Object.keys(groups).forEach(k => { const g = groups[k], r = g.reduce((a, h) => a + h.r, 0), wr = Math.round(100 * g.filter(h => h.r > .02).length / g.length), row = mk("div", "rp-brow"); row.appendChild(mk("span", null, k)); row.appendChild(mk("span", "small muted", g.length + "×")); row.appendChild(mk("span", "small", wr + " %")); const bar = mk("i", "rp-bbar"); const mx = Math.max.apply(null, Object.keys(groups).map(z => Math.abs(groups[z].reduce((a, h) => a + h.r, 0)))) || 1; bar.style.setProperty("--w", Math.round(Math.abs(r) / mx * 100) + "%"); bar.classList.add(r >= 0 ? "pos" : "neg"); row.appendChild(bar); row.appendChild(mk("b", r >= 0 ? "pos" : "neg", rr(r))); t.appendChild(row); }); return t; };
      const by = f => { const o = {}; all.forEach(h => { const ks = [].concat(f(h)); ks.forEach(k => { if (k == null || k === "") return; (o[k] = o[k] || []).push(h); }); }); return o; };
      const dn = EN() ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] : ["Ne", "Po", "Út", "St", "Čt", "Pá", "So"];
      const grid = mk("div", "rp-bgrid"); grid.appendChild(table(T("Podle seance", "By session"), by(h => sessOf(h.t1)))); grid.appendChild(table(T("Podle dne v týdnu", "By weekday"), by(h => dn[new Date(h.day + "T12:00:00Z").getUTCDay()]))); grid.appendChild(table(T("Podle směru", "By direction"), by(h => h.dir > 0 ? "Long" : "Short"))); grid.appendChild(table(T("Podle hodiny vstupu (NY)", "By entry hour (NY)"), by(h => String(Math.floor(modOf(h.t1) / 60)).padStart(2, "0") + ":00")));
      const tg = by(h => h.tags); if (Object.keys(tg).length) grid.appendChild(table(T("Podle štítku", "By tag"), tg)); else grid.appendChild(mk("p", "small muted", T("Po zavření obchodu si ho označ štítkem (A+ setup, Sweep, FVG, Chyba…) a tady uvidíš, které setupy ti vydělávají.", "Tag each trade after it closes (A+ setup, Sweep, FVG, Mistake…) and see here which setups make you money.")));
      body.appendChild(grid);
    }
    if (F.tab === "cal"){
      const byDay = {}; all.forEach(h => { const d = byDay[h.day] || (byDay[h.day] = {r: 0, usd: 0, n: 0}); d.r += h.r; d.usd += h.usd; d.n++; });
      const months = Array.from(new Set(Object.keys(byDay).map(d => d.slice(0, 7)))).sort().reverse().slice(0, 6);
      months.forEach(mo => { const wrapM = mk("div", "rp-cal"), y = +mo.slice(0, 4), mm = +mo.slice(5, 7), first = new Date(Date.UTC(y, mm - 1, 1)), days = new Date(Date.UTC(y, mm, 0)).getUTCDate(), off = (first.getUTCDay() + 6) % 7;
        let mr = 0; Object.keys(byDay).filter(d => d.startsWith(mo)).forEach(d => mr += byDay[d].r);
        const hd = mk("div", "rp-calh"); hd.appendChild(mk("b", null, first.toLocaleDateString(loc(), {month: "long", year: "numeric", timeZone: "UTC"}))); hd.appendChild(mk("span", mr >= 0 ? "pos" : "neg", rr(mr))); wrapM.appendChild(hd);
        const g = mk("div", "rp-calg"); (EN() ? ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] : ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"]).forEach(x => g.appendChild(mk("span", "rp-cald", x)));
        for (let i = 0; i < off; i++) g.appendChild(mk("span"));
        for (let dd2 = 1; dd2 <= days; dd2++){ const key = mo + "-" + String(dd2).padStart(2, "0"), D = byDay[key], c2 = mk("div", "rp-calc" + (D ? (D.r > .02 ? " pos" : D.r < -.02 ? " neg" : " be") : "")); c2.appendChild(mk("i", null, String(dd2))); if (D){ c2.appendChild(mk("b", null, rr(D.r).replace(" R", "R"))); c2.appendChild(mk("small", null, D.n + "×")); c2.title = key + ": " + rr(D.r) + " · " + usd(D.usd); c2.addEventListener("click", () => { const dd3 = lib().find(x => x.day === key); if (dd3) loadDay(dd3); }); } g.appendChild(c2); }
        wrapM.appendChild(g); body.appendChild(wrapM); });
    }
    if (F.tab === "dist"){
      const bins = [[-Infinity, -1.5, "< −1,5"], [-1.5, -.75, "−1"], [-.75, -.25, "−0,5"], [-.25, .25, "0"], [.25, .75, "+0,5"], [.75, 1.5, "+1"], [1.5, 2.5, "+2"], [2.5, 3.5, "+3"], [3.5, 5, "+4"], [5, Infinity, "5+"]], cnt = bins.map(b => all.filter(h => h.r >= b[0] && h.r < b[1]).length), mx = Math.max.apply(null, cnt) || 1;
      const hist2 = mk("div", "rp-dist"); bins.forEach((b, i) => { const col = mk("div", "rp-dcol"); const bar = mk("i", b[1] <= -.25 ? "neg" : b[0] >= .25 ? "pos" : "be"); bar.style.height = Math.round(cnt[i] / mx * 100) + "%"; col.appendChild(mk("small", null, cnt[i] ? String(cnt[i]) : "")); col.appendChild(bar); col.appendChild(mk("span", null, b[2])); hist2.appendChild(col); }); body.appendChild(hist2);
      body.appendChild(mk("p", "small muted", T("Kolik obchodů skončilo s jakým výsledkem v R. Zdravý systém má vlevo hlavně −1 R a vpravo pár velkých výher.", "How many trades ended at each R result. A healthy system shows mostly −1 R on the left and a few big wins on the right.")));
    }
    if (F.tab === "list"){ const tb = mk("div", "rp-hist"); all.slice(-150).reverse().forEach(h => { const r = mk("div", "rp-hrow"); r.appendChild(mk("span", "small muted", h.day + " " + hm(h.t1))); r.appendChild(mk("span", "rp-dir " + (h.dir > 0 ? "buy" : "sell"), h.dir > 0 ? "Long" : "Short")); r.appendChild(mk("span", "small", num(h.e, 2) + " → " + num(h.ex, 2) + (h.parts > 1 ? T(" · částečně", " · partials") : ""))); r.appendChild(mk("span", "small muted", (h.why === "tp" ? T("cíl", "target") : h.why === "sl" ? "stop" : h.why === "eod" ? T("konec dat", "end of data") : T("ručně", "manual")) + (h.tags.length ? " · " + h.tags.join(", ") : "") + (h.note ? " · " + h.note : ""))); r.appendChild(mk("b", h.r >= 0 ? "pos" : "neg", rr(h.r) + " · " + usd(h.usd))); r.title = "MFE " + num(h.mfe, 2) + " R · MAE " + num(h.mae, 2) + " R"; r.addEventListener("click", () => { const dd3 = lib().find(x => x.day === h.day); if (dd3 && dd3.day !== S.day) loadDay(dd3, h.tx); }); tb.appendChild(r); }); body.appendChild(tb); }
  }
  function exportCSV(all){
    const head = ["date", "entry_ny", "exit_ny", "symbol", "side", "contracts", "entry", "stop", "target", "exit", "r", "usd", "mfe_r", "mae_r", "reason", "tags", "note"], q = v => { v = v == null ? "" : String(v); return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const rows = all.map(h => [h.day, hm(h.t1), hm(h.tx), h.sym || "", h.dir > 0 ? "long" : "short", h.q, h.e, h.sl, h.tp, h.ex, h.r, h.usd, h.mfe, h.mae, h.why, h.tags.join("|"), h.note].map(q).join(","));
    const blob = new Blob([head.join(",") + "\n" + rows.join("\n")], {type: "text/csv"}), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "tape-backtest-" + (acct().name || "ucet").replace(/\s+/g, "-") + ".csv"; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function acctBar(el2){
    el2.innerHTML = ""; const sel = mk("select", "rp-acct"); sel.setAttribute("aria-label", T("Účet", "Account")); accts.forEach(a => { const o = mk("option", null, a.name + " · $" + num(a.bal, 0)); o.value = a.id; if (a.id === set.acct) o.selected = true; sel.appendChild(o); });
    sel.addEventListener("change", () => { set.acct = sel.value; set.bal = acct().bal; saveSet(); const d = lib().find(x => x.day === S.day); if (d) loadDay(d, last() ? last().t : null); statsPaint(); acctBar(el2); });
    el2.appendChild(sel);
    const nw = btn("chip", T("+ Nový účet", "+ New account"), () => { const f = mk("div", "rp-newacct"), n1 = mk("input"), b1 = mk("input"); n1.placeholder = T("Název, třeba Lucid 50K test", "Name, e.g. Lucid 50K test"); b1.type = "number"; b1.value = 50000; b1.step = 1000; [n1, b1].forEach(i => i.addEventListener("keydown", e => e.stopPropagation()));
      f.appendChild(n1); f.appendChild(b1); f.appendChild(btn("primary", T("Vytvořit", "Create"), () => { const nm = n1.value.trim() || T("Účet ", "Account ") + (accts.length + 1), bal = parseFloat(b1.value) || 50000, a = {id: "a" + Date.now().toString(36), name: nm, bal: bal}; accts.push(a); saveAccts(); set.acct = a.id; set.bal = bal; saveSet(); const d = lib().find(x => x.day === S.day); if (d) loadDay(d, last() ? last().t : null); statsPaint(); acctBar(el2); toast(T("Účet vytvořen: ", "Account created: ") + nm); })); f.appendChild(btn("rp-no", T("Zrušit", "Cancel"), () => acctBar(el2))); el2.innerHTML = ""; el2.appendChild(f); n1.focus(); });
    el2.appendChild(nw);
    if (accts.length > 1){ const del = btn("chip rp-wipe", T("Smazat účet", "Delete account"), null); let arm = false; del.addEventListener("click", () => { if (!arm){ arm = true; del.textContent = T("Smazat i jeho obchody?", "Delete with its trades?"); setTimeout(() => { arm = false; del.textContent = T("Smazat účet", "Delete account"); }, 3000); return; } const id = set.acct; hist = hist.filter(h => h.acct !== id); saveHist(); accts = accts.filter(a => a.id !== id); saveAccts(); set.acct = accts[0].id; set.bal = acct().bal; saveSet(); const d = lib().find(x => x.day === S.day); if (d) loadDay(d, last() ? last().t : null); statsPaint(); acctBar(el2); }); el2.appendChild(del); }
  }
  function settingsPop(){
    const pop = ui.setp; if (!pop.hidden){ pop.hidden = true; return; } pop.innerHTML = ""; pop.hidden = false;
    const row = (lab, el2) => { const l = mk("label", "rp-f"); l.appendChild(mk("span", null, lab)); l.appendChild(el2); pop.appendChild(l); return el2; };
    const ni = (v, fn, st) => { const i = mk("input"); i.type = "number"; i.step = st || "any"; i.value = v; i.addEventListener("change", () => { fn(parseFloat(String(i.value).replace(",", "."))); saveSet(); panelPaint(); req(); statsPaint(); }); return i; };
    const s1 = mk("select"); Object.keys(INSTR).filter(k => k !== "BTC").forEach(k => { const o = mk("option", null, k + " · $" + INSTR[k].pv + T(" za bod", " per point")); o.value = k; if (k === set.inst) o.selected = true; s1.appendChild(o); }); s1.addEventListener("change", () => { set.inst = s1.value; saveSet(); legend(); panelPaint(); req(); }); row(T("Kontrakt", "Contract"), s1);
    row(T("Počáteční zůstatek účtu ($)", "Account starting balance ($)"), ni(acct().bal, v => { if (v > 0){ acct().bal = v; set.bal = v; saveAccts(); } }, "100"));
    const ab = mk("div", "rp-rw"), abI = ni(set.abe || 0, v => { set.abe = v >= 0 ? v : 0; }, ".1"); ab.appendChild(abI); ab.appendChild(mk("span", "small muted", T("R, 0 = vypnuto", "R, 0 = off"))); row(T("Stop na nulu automaticky po", "Auto breakeven after"), ab);
    const pt = mk("div", "rp-rw"), ptI = ni(set.ptp || 0, v => { set.ptp = v >= 0 ? v : 0; }, ".1"), ptP = ni(set.ptpPct || 50, v => { if (v > 0 && v < 100) set.ptpPct = v; }, "5"); pt.appendChild(ptI); pt.appendChild(mk("span", "small muted", T("R, výběr", "R, take"))); pt.appendChild(ptP); pt.appendChild(mk("span", "small muted", "%")); row(T("Částečný výběr zisku na", "Partial take profit at"), pt);
    const rw = mk("div", "rp-rw"), ri = ni(set.risk, v => { if (v > 0) set.risk = v; }), ms = mk("div", "rp-seg"); ["%", "$"].forEach(m => { const b = btn(m === set.mode ? "on" : "", m, () => { set.mode = m; if (m === "$" && set.risk < 20) { set.risk = Math.round(equity() * set.risk / 100); ri.value = set.risk; } if (m === "%" && set.risk > 20){ set.risk = Math.round(100 * set.risk / equity() * 100) / 100; ri.value = set.risk; } ms.querySelectorAll("button").forEach(x => x.classList.toggle("on", x.textContent === m)); saveSet(); panelPaint(); req(); }); ms.appendChild(b); }); rw.appendChild(ri); rw.appendChild(ms); row(T("Riziko na obchod (1R)", "Risk per trade (1R)"), rw);
    row(T("Poplatek za kontrakt ($)", "Commission per contract ($)"), ni(set.comm, v => { set.comm = v >= 0 ? v : 0; }, ".1"));
    const tz = mk("select"); [["0", T("Časy v souboru: New York", "File times: New York")], ["-300", T("UTC, zimní čas", "UTC, winter time")], ["-240", T("UTC, letní čas", "UTC, summer time")], ["-360", T("Praha", "Prague")]].forEach(x => { const o = mk("option", null, x[1]); o.value = x[0]; if (+x[0] === +set.tz) o.selected = true; tz.appendChild(o); }); tz.addEventListener("change", () => { set.tz = +tz.value; saveSet(); const d = lib().find(x => x.day === S.day); if (d) loadDay(d, last() ? last().t : null); }); row(T("Časové pásmo CSV", "CSV time zone"), tz);
    const cb = mk("div", "rp-f"); cb.appendChild(mk("span", null, T("Svíčky", "Candles"))); const pr = mk("div", "rp-cpre"), grid = mk("div", "rp-cgrid");
    const PRE = [[T("Klasické", "Classic"), "#16b67f", "#f0475a"], ["TradingView", "#089981", "#f23645"], [T("Modrá a oranžová", "Blue and orange"), "#2962ff", "#ff9800"], [T("Tyrkys a růžová", "Teal and pink"), "#26c6da", "#ec407a"], [T("Černobílé", "Mono"), pal().light ? "#1d1530" : "#e8e8ee", pal().light ? "#a59fb8" : "#5c5c68"]];
    const CS = set.cs, sws = {};
    const swatch = key => { const b = btn("rp-csw", null, null, key); const i = mk("i"); i.style.background = CS[key]; b.appendChild(i); sws[key] = i; b.addEventListener("click", ev => { ev.stopPropagation(); cpal(b, CS[key], v => { CS[key] = v; i.style.background = v; saveSet(); req(); }); }); return b; };
    grid.appendChild(mk("span")); grid.appendChild(mk("span", "small muted", T("Rostoucí", "Up"))); grid.appendChild(mk("span", "small muted", T("Klesající", "Down")));
    [["sb", "bu", "bd", T("Tělo", "Body")], ["so", "ou", "od", T("Okraje", "Borders")], ["sw", "wu", "wd", T("Knoty", "Wicks")]].forEach(r => { const l = mk("label", "rp-cl"), ch = mk("input"); ch.type = "checkbox"; ch.checked = CS[r[0]] !== false; ch.addEventListener("change", () => { CS[r[0]] = ch.checked; saveSet(); req(); }); l.appendChild(ch); l.appendChild(mk("span", "small", r[3])); grid.appendChild(l); grid.appendChild(swatch(r[1])); grid.appendChild(swatch(r[2])); });
    PRE.forEach(x => { const b = btn("rp-cp", null, () => { ["bu", "ou", "wu"].forEach(k => { CS[k] = x[1]; sws[k].style.background = x[1]; }); ["bd", "od", "wd"].forEach(k => { CS[k] = x[2]; sws[k].style.background = x[2]; }); saveSet(); req(); }, x[0]); b.innerHTML = '<i style="background:' + x[1] + '"></i><i style="background:' + x[2] + '"></i>'; pr.appendChild(b); });
    const hl = mk("label", "rp-cl"), hc = mk("input"); hc.type = "checkbox"; hc.checked = !!set.hollow; hc.addEventListener("change", () => { set.hollow = hc.checked; saveSet(); req(); }); hl.appendChild(hc); hl.appendChild(mk("span", "small", T("Duté rostoucí svíčky", "Hollow up candles")));
    cb.appendChild(grid); cb.appendChild(mk("span", "small muted", T("Rychlé sady", "Quick sets"))); cb.appendChild(pr); cb.appendChild(hl); pop.appendChild(cb);
    const cy = mk("label", "chk"), cc = mk("input"); cc.type = "checkbox"; cc.checked = !!set.cyc; cc.addEventListener("change", () => { set.cyc = cc.checked; saveSet(); req(); }); cy.appendChild(cc); cy.appendChild(mk("span", null, T("Trénink 90minutových cyklů: PCH, PCL a otázky", "90-minute cycle training: PCH, PCL and questions"))); pop.appendChild(cy);
    const mg = mk("label", "chk"), mc = mk("input"); mc.type = "checkbox"; mc.checked = !!set.magnet; mc.addEventListener("change", () => { set.magnet = mc.checked; saveSet(); }); mg.appendChild(mc); mg.appendChild(mk("span", null, T("Magnet: kreslení se přichytí k high a low svíček", "Magnet: drawings snap to candle highs and lows"))); pop.appendChild(mg);
    pop.appendChild(mk("p", "small muted", T("Klávesy: mezerník přehrát, → další svíčka, Shift+→ deset, ← zpět, T čára, H horizontála, R obdélník, F fibo, L long, S short, Del smazat, Esc zrušit.", "Keys: space play, → next candle, Shift+→ ten, ← back, T line, H horizontal, R rectangle, F fib, L long, S short, Del delete, Esc cancel.")));
    const rs = btn("danger", T("Vynulovat obchody tohoto účtu", "Reset this account's trades"), null); let armed = false; rs.addEventListener("click", () => { if (!armed){ armed = true; rs.textContent = T("Opravdu? Klikni znovu", "Sure? Click again"); setTimeout(() => { armed = false; rs.textContent = T("Vynulovat obchody tohoto účtu", "Reset this account's trades"); }, 3000); return; } hist = hist.filter(h => h.acct !== set.acct); saveHist(); S.draws = S.draws.filter(d => !(d.k === "pos" && ["win", "loss", "be", "closed"].indexOf(d.st) >= 0)); statsPaint(); panelPaint(); req(); pop.hidden = true; }); pop.appendChild(rs);
    pop.appendChild(btn("primary", T("Hotovo", "Done"), () => { pop.hidden = true; }));
  }
  function panelDrag(grip){
    let st = null; grip.addEventListener("pointerdown", e => { e.preventDefault(); grip.setPointerCapture(e.pointerId); const p = ui.panel, br = ui.box.getBoundingClientRect(), pr = p.getBoundingClientRect(); st = {x: e.clientX, y: e.clientY, l: pr.left - br.left, t: pr.top - br.top, bw: br.width, bh: br.height, w: pr.width, h: pr.height}; });
    grip.addEventListener("pointermove", e => { if (!st) return; const l = clamp(st.l + e.clientX - st.x, 4, st.bw - st.w - 4), t = clamp(st.t + e.clientY - st.y, 4, st.bh - st.h - 4); ui.panel.style.left = l + "px"; ui.panel.style.top = t + "px"; ui.panel.style.right = "auto"; set.panel = {l: l / st.bw, t: t / st.bh}; });
    grip.addEventListener("pointerup", () => { if (st){ st = null; saveSet(); } });
  }
  function placePanel(){ if (!set.panel || !ui) return; const br = ui.box.getBoundingClientRect(), p = ui.panel; if (!br.width) return; p.style.left = clamp(set.panel.l * br.width, 4, br.width - p.offsetWidth - 4) + "px"; p.style.top = clamp(set.panel.t * br.height, 4, br.height - p.offsetHeight - 4) + "px"; p.style.right = "auto"; }

  function build(root){
    root.innerHTML = ""; const wrap = mk("div", "rp-studio"); root.appendChild(wrap);
    // top bar: title, ohlc
    const head = mk("div", "rp-head"), ttl = mk("div", "rp-ttl"), t1 = mk("b"), ohlc = mk("div", "rp-ohlc"), clock = mk("span", "rp-clock"); const ileg = mk("div", "rp-ileg"); ttl.appendChild(t1); ttl.appendChild(ohlc); ttl.appendChild(ileg); head.appendChild(ttl); head.appendChild(clock);
    // controls
    const bar = mk("div", "rp-bar"), daySel = mk("select", "rp-day"); daySel.setAttribute("aria-label", T("Den", "Day"));
    daySel.addEventListener("change", () => { const d = lib().find(x => x.day === daySel.value); if (d) loadDay(d); });
    const dnav = mk("div", "rp-grp"); dnav.appendChild(ibtn("prev", T("Předchozí den", "Previous day"), () => { const L = lib(), i = L.findIndex(x => x.day === S.day); if (i > 0) loadDay(L[i - 1]); }));
    dnav.appendChild(daySel); dnav.appendChild(ibtn("next", T("Další den", "Next day"), () => { const L = lib(), i = L.findIndex(x => x.day === S.day); if (i >= 0 && i < L.length - 1) loadDay(L[i + 1]); else if (L.length && i < 0) loadDay(L[0]); }));
    dnav.appendChild(btn("chip rp-rand", T("Náhodný den", "Random day"), () => { const L = lib(); if (L.length > 1) loadDay(L[Math.floor(Math.random() * L.length)]); else runDemo(); }));
    const tfs = mk("div", "rp-seg rp-tfs"); TFS.forEach(x => { const b = btn("", x[1], () => { S.tf = x[0]; set.tf = x[0]; saveSet(); aggC = null; S.yMan = null; S.follow = true; ctlPaint(); legend(); req(); saveSess(); }); b.dataset.tf = x[0]; tfs.appendChild(b); });
    const pl = mk("div", "rp-grp"), bk = ibtn("prev", T("Zpět o svíčku (←)", "Back one candle (←)"), () => { stop(); back(); }), playB = ibtn("play", "", () => play(), "rp-play"), nx = ibtn("next", T("Další svíčka (→)", "Next candle (→)"), () => { stop(); stepTF(1); });
    const sp = mk("select", "rp-sp"); sp.setAttribute("aria-label", T("Rychlost", "Speed")); SPEEDS.forEach(x => { const o = mk("option", null, x[1]); o.value = x[0]; if (+x[0] === +set.speed) o.selected = true; sp.appendChild(o); }); sp.addEventListener("change", () => { set.speed = +sp.value; saveSet(); if (S.playing){ stop(); play(); } });
    const jt = mk("input", "rp-jt"); jt.type = "time"; jt.step = 60; jt.setAttribute("aria-label", T("Skočit na čas", "Jump to time")); jt.title = T("Skočit na čas (newyorský)", "Jump to time (New York)"); jt.addEventListener("change", () => { const m = jt.value.match(/(\d+):(\d+)/); if (m) jump(+m[1] * 60 + +m[2]); });
    const gt = ibtn("goto", T("Přejít na seanci", "Go to session"), ev => gotoMenu(ev.currentTarget)), pk = ibtn("cut", T("Vybrat start replaye na grafu", "Pick the replay start on the chart"), () => { S.pick = !S.pick; ui.pickHint.hidden = !S.pick; req(); });
    pl.appendChild(bk); pl.appendChild(playB); pl.appendChild(nx); pl.appendChild(sp); pl.appendChild(jt); pl.appendChild(gt); pl.appendChild(pk);
    const right = mk("div", "rp-grp"); const fxb = btn("chip rp-fxb", null, () => indDialog(), T("Indikátory", "Indicators")); fxb.innerHTML = svgI("fx") + "<span>" + T("Indikátory", "Indicators") + "</span>"; right.appendChild(fxb); right.appendChild(ibtn("cam", T("Uložit obrázek grafu", "Save chart image"), shot)); right.appendChild(ibtn("help", T("Klávesové zkratky (?)", "Keyboard shortcuts (?)"), helpPop)); right.appendChild(ibtn("gear", T("Nastavení rizika a replaye", "Risk and replay settings"), () => settingsPop())); const fsb = ibtn("full", T("Celá obrazovka", "Full screen"), () => fullscreen()); right.appendChild(fsb);
    const ses = mk("div", "rp-seg rp-ses"); [["eth", "ETH", T("Elektronická seance: celý den 18:00–17:00, mimo hlavní seanci podbarvená", "Electronic trading hours: the full 18:00–17:00 session, extended hours shaded")], ["rth", "RTH", T("Jen hlavní seance 9:30–16:00 New York", "Regular trading hours only, 9:30–16:00 New York")]].forEach(x => { const b = btn(set.sess === x[0] ? "on" : "", x[1], () => { if (set.sess === x[0]) return; set.sess = x[0]; saveSet(); ses.querySelectorAll("button").forEach(z => z.classList.toggle("on", z === b)); const at = last() ? last().t : null, d = lib().find(z => z.day === S.day) || lib()[lib().length - 1]; if (d) loadDay(d, at); }, x[2]); ses.appendChild(b); });
    bar.appendChild(dnav); bar.appendChild(tfs); bar.appendChild(ses); bar.appendChild(pl); bar.appendChild(right);
    // chart area
    const area = mk("div", "rp-area"), tools = mk("div", "rp-tools"), box = mk("div", "rp-box"), cv = mk("canvas"); cv.setAttribute("aria-label", T("Graf replaye", "Replay chart")); cv.setAttribute("role", "img");
    [["cur", T("Kurzor (V)", "Cursor (V)")], ["line", T("Trendová čára (T)", "Trend line (T)")], ["ray", T("Paprsek", "Ray")], ["h", T("Horizontální čára (H)", "Horizontal line (H)")], ["rect", T("Obdélník (R)", "Rectangle (R)")], ["fib", T("Fibonacci s OTE (F)", "Fibonacci with OTE (F)")], ["txt", T("Text (X)", "Text (X)")], ["long", T("Long pozice (L)", "Long position (L)")], ["short", T("Short pozice (S)", "Short position (S)")], ["meas", T("Pravítko (M, nebo Shift a táhnout)", "Measure (M, or Shift and drag)")]].forEach(x => { const b = ibtn(x[0], x[1], () => setTool(x[0])); b.dataset.t = x[0]; tools.appendChild(b); });
    tools.appendChild(mk("i", "rp-sep")); tools.appendChild(ibtn("undo", T("Zpět (Ctrl+Z)", "Undo (Ctrl+Z)"), undo)); tools.appendChild(ibtn("redo", T("Znovu (Ctrl+Y)", "Redo (Ctrl+Y)"), redo)); tools.appendChild(ibtn("del", T("Smazat vybrané (Del)", "Delete selected (Del)"), delSel)); tools.appendChild(ibtn("clr", T("Smazat všechny kresby", "Delete all drawings"), () => { S.draws = S.draws.filter(d => d.k === "pos" && d.st && d.st !== "plan"); S.sel = null; saveDraw(); req(); }));
    box.appendChild(cv);
    // corner order panel (draggable)
    const panel = mk("div", "rp-panel"), grip = mk("span", "rp-grip"); grip.innerHTML = svgI("grip"); grip.title = T("Přetáhni panel", "Drag the panel");
    const pr = mk("div", "rp-prow2"), pSell = btn("rp-sell", null, () => draft(-1), T("Short: návrh pozice", "Short: draft a position")), pBuy = btn("rp-buy", null, () => draft(1), T("Long: návrh pozice", "Long: draft a position"));
    pSell.innerHTML = "<span>SHORT</span><b>–</b>"; pBuy.innerHTML = "<span>LONG</span><b>–</b>"; pr.appendChild(grip); pr.appendChild(pSell); pr.appendChild(pBuy);
    const colB = btn("rp-pcol", null, () => { set.pcol = !panel.classList.contains("col"); panel.classList.toggle("col", set.pcol); saveSet(); setTimeout(placePanel, 0); }, T("Sbalit nebo rozbalit volby pokynu", "Collapse or expand order options")); colB.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>'; pr.appendChild(colB);
    if (set.pcol == null ? window.innerWidth < 700 : set.pcol) panel.classList.add("col");
    const pRisk = btn("rp-risk", "", () => settingsPop(), T("Změnit riziko", "Change risk")), pConf = mk("div", "rp-conf"), pOk = btn("rp-ok", "", () => { const d = S.draws.find(x => x.st === "draft"); if (d) confirm(d); }), pNo = btn("rp-no", T("Zrušit", "Cancel"), () => { S.draws = S.draws.filter(x => x.st !== "draft"); S.sel = null; posList(); req(); });
    const pOT = mk("div", "rp-seg rp-ot"); ["mkt", "lim", "stp"].forEach(k => { const b = btn(k === set.ot ? "on" : "", otName(k), () => setOT(k), k === "mkt" ? T("Za trh: vstup hned za aktuální cenu", "Market: fill now at the current price") : k === "lim" ? T("Limit: long pod cenou, short nad cenou", "Limit: buy below, sell above the price") : T("Stop: long nad cenou, short pod cenou, vstup při průrazu", "Stop: buy above, sell below the price, fills on the break")); b.dataset.ot = k; pOT.appendChild(b); });
    const pSize = mk("div", "rp-seg rp-ot"); [["risk", T("Podle rizika", "By risk")], ["qty", T("Kontrakty", "Contracts")]].forEach(x => { const b = btn(x[0] === set.size ? "on" : "", x[1], () => { set.size = x[0]; saveSet(); posList(); req(); }); b.dataset.sz = x[0]; pSize.appendChild(b); });
    const pQty = mk("div", "rp-qty"), pQm = btn("", "−", () => { set.qty = Math.max(inst().step, Math.round((+set.qty - inst().step) * 1000) / 1000); saveSet(); posList(); req(); }), pQtyI = mk("input"), pQp = btn("", "+", () => { set.qty = Math.round((+set.qty + inst().step) * 1000) / 1000; saveSet(); posList(); req(); }), pQtyU = mk("span", "small muted");
    pQtyI.type = "number"; pQtyI.min = "0"; pQtyI.inputMode = "decimal"; pQtyI.setAttribute("aria-label", T("Počet kontraktů", "Number of contracts")); pQtyI.addEventListener("input", () => { const v = parseFloat(String(pQtyI.value).replace(",", ".")); if (v > 0){ set.qty = v; saveSet(); req(); panelPaint(); } });
    pQty.appendChild(pQm); pQty.appendChild(pQtyI); pQty.appendChild(pQp); pQty.appendChild(pQtyU);
    pConf.appendChild(pOk); pConf.appendChild(pNo); pConf.hidden = true; panel.appendChild(pr); panel.appendChild(pOT); panel.appendChild(pSize); panel.appendChild(pQty); panel.appendChild(pRisk); panel.appendChild(pConf); box.appendChild(panel);
    const setp = mk("div", "rp-setp"); setp.hidden = true; box.appendChild(setp);
    const indp = mk("div", "rp-setp rp-indp"); indp.hidden = true; box.appendChild(indp); const helpp = mk("div", "rp-setp rp-help"); helpp.hidden = true; box.appendChild(helpp);
    const rtb = btn("rp-rt", null, () => { S.follow = true; S.off = 14; req(); }, T("Zpět na aktuální svíčku", "Back to the latest candle")); rtb.innerHTML = svgI("rt"); rtb.hidden = true; box.appendChild(rtb);
    const pickHint = mk("div", "rp-hint", T("Klikni na svíčku, od které chceš replay spustit. Esc zruší.", "Click the candle to start the replay from. Esc cancels.")); pickHint.hidden = true; box.appendChild(pickHint);
    const gmenu = mk("div", "rp-cm rp-gm"); gmenu.hidden = true; wrap.appendChild(gmenu);
    const otb = mk("div", "rp-otb"); otb.hidden = true; box.appendChild(otb); const cm = mk("div", "rp-cm"); cm.hidden = true; box.appendChild(cm);
    document.addEventListener("pointerdown", e => { if (!cm.hidden && !cm.contains(e.target)) cm.hidden = true; if (!gmenu.hidden && !gmenu.contains(e.target) && !(e.target.closest && e.target.closest("[aria-label='" + T("Přejít na seanci", "Go to session") + "']"))) gmenu.hidden = true; const pp = otb.querySelector(".rp-pal"); if (pp && !otb.contains(e.target)) pp.remove(); const cp = box.querySelector(".rp-cpal"); if (cp && !cp.contains(e.target) && !(e.target.closest && e.target.closest(".rp-csw"))) cp.remove(); }, true);
    const empty = mk("div", "rp-empty"); box.appendChild(empty);
    area.appendChild(tools); area.appendChild(box);
    const prog = mk("div", "rp-prog"), pi = mk("i"); prog.appendChild(pi);
    const pos = mk("div", "rp-pos"); pos.hidden = true; const quiz = mk("div", "box exam rp-quiz"); quiz.hidden = true;
    // library bar
    const libB = mk("div", "rp-lib"), up = mk("label", "chip rp-up"), fi = mk("input"); fi.type = "file"; fi.accept = ".csv,.txt,text/csv"; fi.multiple = true; fi.hidden = true; up.appendChild(mk("span", null, T("Nahrát CSV (1m svíčky)", "Upload CSV (1m candles)"))); up.appendChild(fi);
    fi.addEventListener("change", () => upload(fi.files).then(() => { fi.value = ""; }));
    const libInfo = mk("span", "small muted"); libB.appendChild(up); libB.appendChild(btn("chip", T("Ukázka zdarma", "Free demo"), () => runDemo())); libB.appendChild(libInfo);
    const wipe = btn("chip rp-wipe", T("Smazat data", "Delete data"), null); let arm = false; wipe.addEventListener("click", () => { if (!arm){ arm = true; wipe.textContent = T("Opravdu smazat?", "Really delete?"); setTimeout(() => { arm = false; wipe.textContent = T("Smazat data", "Delete data"); }, 3000); return; } libWipe().then(() => { S.days = []; S.B = []; S.day = ""; LS("tape-rp-sess", null); libPaint(); emptyPaint(); req(); toast(T("Data jsou smazaná.", "Data deleted.")); }); }); libB.appendChild(wipe);
    // stats
    const stH = mk("div", "rp-sth"), stT = mk("h3", null, T("Výsledky replaye", "Replay results")), scope = mk("div", "rp-accts"); stH.appendChild(stT); stH.appendChild(scope);
    const stats = mk("div", "rp-stats");
    const exb = mk("div", "rp-exam"); exb.hidden = true;
    wrap.appendChild(head); wrap.appendChild(bar); wrap.appendChild(exb); wrap.appendChild(prog); wrap.appendChild(area); wrap.appendChild(pos); wrap.appendChild(quiz); wrap.appendChild(libB); wrap.appendChild(stH); wrap.appendChild(stats);
    ui = {fsb: fsb, ileg: ileg, indp: indp, helpp: helpp, rt: rtb, pickHint: pickHint, gmenu: gmenu, wrap: wrap, ttl: t1, ohlc: ohlc, clock: clock, daySel: daySel, tfs: tfs, play: playB, jt: jt, tools: tools, box: box, cv: cv, otb: otb, cm: cm, panel: panel, pSell: pSell, pBuy: pBuy, pRisk: pRisk, pOT: pOT, pSize: pSize, pQty: pQty, pQtyI: pQtyI, pQtyU: pQtyU, pConf: pConf, pOk: pOk, setp: setp, empty: empty, prog: pi, pos: pos, quiz: quiz, libInfo: libInfo, stats: stats, scope: "all"};
    ui.exb = exb; ui.dnav = dnav; ui.libB = libB;
    dnav.appendChild(btn("chip rp-examb", T("Zkouška", "Exam"), () => examIntro(), T("Zkušební den: náhodný den bez data a pevná pravidla. Hodnotí se proces, ne zisk.", "Exam day: a random day with no date and fixed rules. The process is graded, not the profit.")));
    acctBar(scope);
    panelDrag(grip); setTool("cur");
    cv.addEventListener("pointerdown", onDown); cv.addEventListener("pointermove", onMove); cv.addEventListener("pointerup", onUp); cv.addEventListener("pointercancel", onUp); cv.addEventListener("pointerleave", () => { S.mouse = null; req(); }); cv.addEventListener("wheel", onWheel, {passive: false}); cv.addEventListener("dblclick", onDbl);
    cv.addEventListener("contextmenu", ctxMenu);
    if (window.ResizeObserver) new ResizeObserver(() => { placePanel(); req(); }).observe(box); else window.addEventListener("resize", req);
    window.addEventListener("resize", fitBox); setTimeout(fitBox, 0); setTimeout(fitBox, 400);
    if (window.ResizeObserver){ const ro = new ResizeObserver(() => fitBox()); Array.prototype.forEach.call(wrap.children, c => { if (c !== area && c.offsetParent !== undefined) ro.observe(c); }); if (wrap.parentElement) Array.prototype.forEach.call(wrap.parentElement.children, c => { if (c !== wrap) ro.observe(c); }); }
    document.addEventListener("keydown", key);
    const exitFs = btn("rp-exitfs", null, () => fullscreen(), T("Ukončit celou obrazovku", "Exit full screen")); exitFs.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg><span>' + T("Ukončit celou obrazovku", "Exit full screen") + "</span><kbd>Esc</kbd>"; wrap.appendChild(exitFs);
    document.addEventListener("fullscreenchange", () => { wrap.classList.toggle("rp-fs", !!document.fullscreenElement); fsIcon(); fitBox(); setTimeout(() => { placePanel(); req(); }, 60); });
    window.addEventListener("hashchange", () => setTimeout(fitBox, 80));
    window.addEventListener("hashchange", stop);
    ctlPaint(); libPaint(); statsPaint(); emptyPaint(); setTimeout(placePanel, 30);
  }
  function promo(){
    const sub = document.getElementById("rp-pm-sub"), go = document.getElementById("rp-pm-go"); if (!sub) return;
    const ss = LS("tape-rp-sess"), TT = tradesOf(), n = TT.length, tr = TT.reduce((a, h) => a + h.r, 0);
    if (ss && ss.day){ const b = S.day === ss.day && last() ? hm(last().t) : ""; sub.textContent = T("Rozehraný den ", "Session in progress: ") + ss.day + (b ? " · " + b : "") + (n ? " · " + n + T(" obchodů · ", " trades · ") + rr(tr) : "") + "."; if (go) go.textContent = T("Pokračovat v replayi", "Continue replay"); }
  }
  function fsIcon(){ const b = ui && ui.fsb; if (!b) return; const on = ui.wrap.classList.contains("rp-fs"); b.innerHTML = svgI(on ? "unfull" : "full"); b.title = on ? T("Ukončit celou obrazovku (Esc)", "Exit full screen (Esc)") : T("Celá obrazovka", "Full screen"); b.setAttribute("aria-label", b.title); }
  // the chart fills the window below its controls, so it is whole on screen without scrolling
  function fitBox(){ if (!ui || !ui.box) return; const box = ui.box, area = box.parentElement, fs = ui.wrap.classList.contains("rp-fs");
    if (fs || window.innerWidth < 860 || !ui.wrap.offsetParent){ box.style.height = ""; if (area) area.style.removeProperty("--rp-h"); return; }
    const top = box.getBoundingClientRect().top + (window.scrollY || 0), h = Math.round(Math.max(380, Math.min(1100, window.innerHeight - top - 16)));
    box.style.height = h + "px"; if (area) area.style.setProperty("--rp-h", h + "px"); }
  // full screen without the Fullscreen API (iPhone): the studio moves to <body> for the time, so no parent box can hold it in
  let fsHome = null;
  function fsFake(on){ const w = ui.wrap; if (on){ if (!fsHome){ fsHome = document.createComment("rp"); w.parentNode.insertBefore(fsHome, w); document.body.appendChild(w); } w.classList.add("rp-fs"); document.body.classList.add("rp-fsbody"); }
    else { w.classList.remove("rp-fs"); document.body.classList.remove("rp-fsbody"); if (fsHome && fsHome.parentNode){ fsHome.parentNode.insertBefore(w, fsHome); fsHome.remove(); } fsHome = null; }
    fsIcon(); fitBox(); setTimeout(() => { placePanel(); req(); }, 60); }
  function fullscreen(){ const w = ui.wrap; if (document.fullscreenElement){ document.exitFullscreen(); return; } if (w.classList.contains("rp-fs")){ fsFake(false); return; } if (w.requestFullscreen) w.requestFullscreen().catch(() => fsFake(true)); else fsFake(true); }
  function emptyPaint(){
    const e = ui.empty; e.innerHTML = ""; e.hidden = !!S.B.length; ui.panel.hidden = !S.B.length; if (S.B.length) return;
    e.appendChild(mk("b", null, T("Backtest na skutečných svíčkách", "Backtest on real candles")));
    e.appendChild(mk("p", "small", T("Nahraj minutové svíčky NQ nebo ES (CSV z Dukascopy nebo export z TradingView). Tape si dny uloží jen do tohoto zařízení. Nebo si to hned vyzkoušej na ukázce.", "Upload 1-minute NQ or ES candles (CSV from Dukascopy or a TradingView export). Tape keeps the days on this device only. Or try it right away on the demo.")));
    const r = mk("div", "rp-qrow"), up = mk("label", "primary rp-upb"), fi = mk("input"); fi.type = "file"; fi.accept = ".csv,.txt,text/csv"; fi.multiple = true; fi.hidden = true; up.appendChild(mk("span", null, T("Nahrát CSV", "Upload CSV"))); up.appendChild(fi); fi.addEventListener("change", () => upload(fi.files));
    r.appendChild(up); r.appendChild(btn("chip", T("Spustit ukázku", "Start the demo"), () => runDemo())); e.appendChild(r);
  }
  async function upload(files){
    if (!files || !files.length) return; if (window.TapePlan && !window.TapePlan.need("pro")) return; let got = [], epoch = false;
    for (const f of files){ const txt = await f.text(); const r = parseCSV(txt); got = got.concat(r.days); epoch = epoch || r.epoch; }
    if (!got.length){ toast(T("V souboru jsem nenašel minutové svíčky (čas, open, high, low, close).", "No 1-minute candles found (time, open, high, low, close).")); return; }
    if (epoch){ set.tz = 0; saveSet(); }
    const map = {}; S.days.forEach(d => map[d.day] = d); got.forEach(d => map[d.day] = d); S.days = Object.keys(map).sort().map(k => map[k]);
    libSave(got).catch(() => toast(T("Data se nepodařilo uložit do zařízení.", "Could not store the data on this device.")));
    toast(T("Načteno dní: ", "Days loaded: ") + got.length); S.demo = ""; loadDay(S.days.find(x => x.day === got[got.length - 1].day)); emptyPaint();
  }
  async function runDemo(){
    toast(T("Načítám ukázková data…", "Loading demo data…")); const ds = await demoDays(); S.demoDays = ds; const d = ds[ds.length - 1]; loadDay(d); emptyPaint();
    toast(d.real ? T("Ukázka: skutečné minutové svíčky BTCUSDT z veřejných dat Binance, několik dní zpátky.", "Demo: real 1-minute BTCUSDT candles from Binance public data, several days back.") : T("Ukázka: vymyšlená data, jen na vyzkoušení ovládání.", "Demo: invented data, just to try the controls."));
  }

  // ---------- mount ----------
  function mount(){
    const root = document.getElementById("rp-studio"); if (!root || !API().jr) return false; if (root.dataset.on) return true; root.dataset.on = "1";
    build(root);
    libLoad().then(ds => { S.days = (ds || []).sort((a, b) => a.day.localeCompare(b.day)); libPaint(); const ss = LS("tape-rp-sess"), d = ss && S.days.find(x => x.day === ss.day); if (EX && (!d || d.day !== EX.day || EX.demo)){ EX = null; LS("tape-rp-exam", null); } if (d){ if (ss.tf && TFS.some(x => x[0] === ss.tf)) S.tf = ss.tf; if (EX) EX.loading = 1; loadDay(d, ss.at != null ? ss.at : null); if (EX){ delete EX.loading; examPaint(); legend(); } } else if (S.days.length) loadDay(S.days[S.days.length - 1]); emptyPaint(); req(); }).catch(() => { emptyPaint(); req(); });
    return true;
  }

  // ---------- exam: a random day with the date hidden and fixed rules; the process is graded, not the profit ----------
  let EX = LS("tape-rp-exam") || null;
  const EXR = {max: 3, stop: -2, rr: 1, loss: -1.1, cool: 5, mins: 60};
  function examTrades(){ if (!EX) return []; const g = {}; hist.filter(h => h.acct === EX.acct && h.ts >= EX.ts).forEach(h => { const k = h.id + "|" + h.t1; (g[k] = g[k] || []).push(h); });
    return Object.keys(g).map(k => { const ps = g[k], f = ps[0]; return {t1: f.t1, tx: Math.max.apply(null, ps.map(x => x.tx)), r: Math.round(ps.reduce((a, x) => a + x.r, 0) * 100) / 100, e: f.e, sl: f.sl, tp: ps[ps.length - 1].tp}; }).sort((a, b) => a.t1 - b.t1); }
  function examPaint(){ if (!ui || !ui.exb) return; const on = !!EX; ui.exb.hidden = !on; ui.wrap.classList.toggle("rp-inexam", on); if (ui.dnav) Array.prototype.forEach.call(ui.dnav.children, c => { c.style.display = on ? "none" : ""; }); if (ui.libB) ui.libB.style.display = on ? "none" : "";
    if (!on) return; const tr = examTrades(), open = S.draws.filter(d => d.k === "pos" && (d.st === "open" || d.st === "pending")).length, sum = tr.reduce((a, t) => a + t.r, 0), sig = tr.length + "|" + open + "|" + sum.toFixed(2) + "|" + EN(); if (ui.exb.dataset.sig === sig) return; ui.exb.dataset.sig = sig; ui.exb.innerHTML = "";
    const l = mk("div", "rp-exl"); l.appendChild(mk("b", null, T("Zkouška", "Exam"))); l.appendChild(mk("span", null, T("obchody ", "trades ") + (tr.length + open) + " / " + EXR.max)); l.appendChild(mk("span", sum < 0 ? "neg" : sum > 0 ? "pos" : "", (sum > 0 ? "+" : "") + num(sum, 2) + " R")); l.appendChild(mk("span", "rp-exrule", T("denní stop −2R · poměr aspoň 1:1 · stop se neposouvá dál", "daily stop −2R · at least 1:1 · the stop never moves further")));
    ui.exb.appendChild(l); ui.exb.appendChild(btn("chip", T("Ukončit a vyhodnotit", "Finish and grade"), () => examFinish(false))); }
  function examBox(build){ const ov = mk("div", "rp-exov"), c = mk("div", "rp-exc"); ov.appendChild(c); const close = () => ov.remove(); ov.addEventListener("mousedown", ev => { if (ev.target === ov) close(); }); build(c, close); document.body.appendChild(ov); return close; }
  function examIntro(){ if (window.TapePlan && !window.TapePlan.need("pro")) return; if (EX){ toast(T("Zkouška už běží.", "An exam is already running.")); return; }
    examBox((c, close) => { c.appendChild(mk("span", "kick", T("Replay zkouška", "Replay exam"))); c.appendChild(mk("h2", null, T("Zkušební den", "Exam day")));
      c.appendChild(mk("p", null, T("Dostaneš náhodný den ze svých dat a datum zůstane skryté. Obchoduj svůj model jako naostro. Hodnotí se jen to, jestli držíš pravidla. Zisk ani ztráta výsledek nemění.", "You get a random day from your data and the date stays hidden. Trade your model as if it were live. Only whether you keep the rules is graded. Profit or loss does not change the result.")));
      const ul = mk("ul", "rp-exul"); [T("Nejvýš 3 obchody za den.", "At most 3 trades in the day."), T("Po −2R už žádný další obchod.", "After −2R no further trade."), T("Každý obchod má cíl aspoň tak daleko jako stop (1:1).", "Every trade has a target at least as far as the stop (1:1)."), T("Stop se neposouvá dál od vstupu, ztráta je nejvýš 1R.", "The stop never moves further from the entry; a loss is at most 1R."), T("Po ztrátě aspoň 5 minut trhu pauza.", "After a loss, a break of at least 5 market minutes."), T("Zkouška trvá aspoň hodinu trhu a potřebuje aspoň jeden obchod. Vracet zpět se nedá.", "The exam runs for at least one market hour and needs at least one trade. You cannot rewind.")].forEach(x => ul.appendChild(mk("li", null, x))); c.appendChild(ul);
      if (!S.days.length) c.appendChild(mk("p", "small muted", T("Nemáš nahraná vlastní data, zkouška proto poběží na ukázkovém dni. Pro zkoušku na NQ nebo ES nahraj CSV s minutovými svíčkami.", "You have no data of your own uploaded, so the exam will run on a demo day. For an exam on NQ or ES, upload a CSV with 1-minute candles.")));
      const row = mk("div", "rp-exrow"); row.appendChild(btn("", T("Zpět", "Back"), close)); row.appendChild(btn("primary", T("Začít zkoušku", "Start the exam"), () => { close(); examStart(); })); c.appendChild(row); }); }
  async function examStart(){ let d = null;
    if (S.days.length){ S.demo = ""; const used = {}; AH().forEach(h => { used[h.day] = 1; }); const fresh = S.days.filter(x => !used[x.day]), pool = fresh.length ? fresh : S.days; d = pool[Math.floor(Math.random() * pool.length)]; }
    else { if (!S.demoDays || !S.demoDays.length){ toast(T("Načítám ukázková data…", "Loading demo data…")); S.demoDays = await demoDays(); } const L = S.demoDays || []; d = L[Math.floor(Math.random() * L.length)]; }
    if (!d){ toast(T("Zkoušku se nepodařilo připravit, chybí data.", "The exam could not be prepared, there is no data.")); return; }
    EX = {day: d.day, ts: new Date().toISOString(), acct: set.acct, demo: d.demo || "", loading: 1}; loadDay(d); delete EX.loading; EX.day = S.day; EX.t0 = last() ? last().t : 0; LS("tape-rp-exam", EX); emptyPaint(); examPaint(); legend(); req();
    toast(T("Zkouška běží. Den je skrytý, hodně štěstí s pravidly.", "The exam is running. The day is hidden; keep to the rules.")); }
  function examFinish(auto){ if (!EX) return; const lb = last(), ran = lb ? lb.t - (EX.t0 || 0) : 0;
    if (!auto && ran < EXR.mins){ toast(T("Zkouška musí běžet aspoň hodinu trhu. Zatím uběhlo ", "The exam must run for at least one market hour. So far: ") + Math.max(0, Math.round(ran)) + " min."); return; }
    stop(); S.draws.forEach(d => { if (d.k === "pos" && d.st === "open") close(d, lb.c, lb.t, "eod"); if (d.k === "pos" && d.st === "pending") d.st = "cancel"; }); S.draws = S.draws.filter(d => d.st !== "cancel");
    const tr = examTrades(), n = tr.length, sum = Math.round(tr.reduce((a, t) => a + t.r, 0) * 100) / 100; let cum = 0, late = 0, quick = 0;
    tr.forEach((t, i) => { const before = tr.filter(q => q.tx <= t.t1); cum = before.reduce((a, q) => a + q.r, 0); if (cum <= EXR.stop) late++; const pv = before.length ? before[before.length - 1] : null; if (pv && pv.r < 0 && t.t1 - pv.tx < EXR.cool) quick++; });
    const rrBad = tr.filter(t => !(t.tp != null && Math.abs(t.e - t.sl) > 0 && Math.abs(t.tp - t.e) / Math.abs(t.e - t.sl) >= EXR.rr - .001)).length, big = tr.filter(t => t.r < EXR.loss).length;
    const rules = [[n <= EXR.max, T("Nejvýš 3 obchody", "At most 3 trades"), n + T(n === 1 ? " obchod" : n >= 2 && n <= 4 ? " obchody" : " obchodů", n === 1 ? " trade" : " trades")], [late === 0, T("Denní stop −2R", "Daily stop −2R"), late ? late + T("× obchod po dosažení −2R", "× a trade after reaching −2R") : T("dodržen", "kept")],
      [rrBad === 0, T("Cíl aspoň 1:1", "Target at least 1:1"), rrBad ? rrBad + T("× menší cíl než stop", "× a target smaller than the stop") : T("dodrženo", "kept")], [big === 0, T("Ztráta nejvýš 1R", "Loss at most 1R"), big ? big + T("× ztráta větší než 1R", "× a loss bigger than 1R") : T("dodrženo", "kept")],
      [quick === 0, T("Pauza po ztrátě", "Break after a loss"), quick ? quick + T("× vstup do 5 minut po ztrátě", "× an entry within 5 minutes of a loss") : T("dodržena", "kept")]];
    const kept = rules.filter(r => r[0]).length, pass = n >= 1 && kept === rules.length, day = EX.day, demo = EX.demo, rec = {ts: new Date().toISOString(), day: day, demo: demo || "", n: n, r: sum, kept: kept, of: rules.length, pass: pass};
    try { if (API().examSave) API().examSave(rec); } catch(e){} try { API().touchDay(); } catch(e){}
    EX = null; LS("tape-rp-exam", null); examPaint(); legend(); libPaint(); statsPaint(); req();
    examBox((c, close) => { c.appendChild(mk("span", "kick", T("Replay zkouška", "Replay exam"))); c.appendChild(mk("h2", pass ? "pos" : "", pass ? T("Zkouška splněna", "Exam passed") : n ? T("Tentokrát ne", "Not this time") : T("Bez obchodu", "No trade")));
      c.appendChild(mk("p", null, !n ? T("Neobchodoval jsi. Zůstat venku bývá správně, ale zkouška potřebuje aspoň jeden obchod, aby bylo co hodnotit.", "You did not trade. Staying out is often right, but the exam needs at least one trade to grade.") : pass ? T("Dodržel jsi všech pět pravidel. Přesně tohle má deník ukazovat i naostro.", "You kept all five rules. This is exactly what your journal should show live as well.") : T("Dodržel jsi ", "You kept ") + kept + T(" z ", " of ") + rules.length + T(" pravidel. Podívej se, které chybělo, a zkus to znovu na jiném dni.", " rules. See which one was missing and try again on another day.")));
      const ul = mk("div", "rp-exres"); rules.forEach(r => { const li = mk("div", "rp-exr " + (r[0] ? "ok" : "no")); li.appendChild(mk("i", null, r[0] ? "✓" : "✕")); li.appendChild(mk("b", null, r[1])); li.appendChild(mk("span", null, r[2])); ul.appendChild(li); }); c.appendChild(ul);
      c.appendChild(mk("p", "small muted", T("Výsledek dne: ", "Result of the day: ") + (sum > 0 ? "+" : "") + num(sum, 2) + " R · " + (demo ? T("ukázkový den", "demo day") : T("den ", "day ") + day) + T(". Do hodnocení se nepočítá.", ". It does not count towards the grade.")));
      const row = mk("div", "rp-exrow"); row.appendChild(btn("", T("Zavřít", "Close"), close)); row.appendChild(btn("primary", T("Další zkouška", "Another exam"), () => { close(); examStart(); })); c.appendChild(row); }); }
  window.TapeReplay = {mount: mount, summary: () => { const ss = LS("tape-rp-sess"), n = hist.length, tr = hist.reduce((a, h) => a + h.r, 0), w = hist.filter(h => h.r > .02).length; return {sess: ss, n: n, r: tr, win: n ? Math.round(100 * w / n) : null, usd: hist.reduce((a, h) => a + h.usd, 0)}; }};
  if (!mount()){ let k = 0; const iv = setInterval(() => { if (mount() || ++k > 100) clearInterval(iv); }, 100); }
})();
