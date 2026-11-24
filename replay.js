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
  const DEF = {sess: "eth", cup: "", cdn: "", hollow: false, ot: "mkt", size: "risk", qty: 1, bal: 50000, mode: "%", risk: 1, inst: "NQ", comm: 0, tf: 1, speed: 3, panel: null, cyc: false, tz: 0, magnet: true};
  const set = Object.assign({}, DEF, LS("tape-rp-set") || {});
  try { const s = (API().sym && API().sym()) || ""; if (!LS("tape-rp-set") && INSTR[s]) set.inst = s; } catch(e){}
  const saveSet = () => LS("tape-rp-set", set);
  let hist = LS("tape-rp-hist") || [];
  const saveHist = () => LS("tape-rp-hist", hist.slice(-2000));
  const drawStore = LS("tape-rp-draw") || {};
  (function migrate(){ const all = drawStore.all || []; Object.keys(drawStore).forEach(k => { if (k === "all" || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return; const b = dayBase(k); (drawStore[k] || []).forEach(d => { const f = t => t < 2880 ? t + b : t; if (d.a) d.a.t = f(d.a.t); if (d.b) d.b.t = f(d.b.t); if (d.t1 != null){ d.t1 = f(d.t1); d.t2 = f(d.t2); } d.t = d.t != null ? f(d.t) : (d.a ? d.a.t : d.t1 != null ? d.t1 : b + 540); all.push(d); }); delete drawStore[k]; }); drawStore.all = all; })();
  hist.forEach(h => { if (h.t1 < 2880){ const b = dayBase(h.day); h.t1 += b; h.tx += b; } });
  const anchor = d => d.t != null ? d.t : d.a ? d.a.t : d.t1;
  let drawTm = null;
  const saveDraw = () => { clearTimeout(drawTm); drawTm = setTimeout(() => { if (S.demo || !S.B.length) return; const mine = S.draws.filter(d => d.k !== "pos" || !d.st || d.st === "plan").map(d => Object.assign({}, d, {id: undefined})); drawStore.all = (S.drawOut || []).concat(mine).slice(-600); LS("tape-rp-draw", drawStore); }, 300); };

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
      const o = parseFloat(c[k]), h = parseFloat(c[k + 1]), l = parseFloat(c[k + 2]), cl = parseFloat(c[k + 3]);
      if (![o, h, l, cl].every(isFinite)) continue;
      const m = ts.match(/^(\d{4})[-./](\d{2})[-./](\d{2})\s+(\d{1,2}):(\d{2})(?:\|(\S+))?/); if (!m) continue;
      const day = m[6] || (m[1] + "-" + m[2] + "-" + m[3]);
      (out[day] = out[day] || []).push([m[1] + "-" + m[2] + "-" + m[3] + " " + m[4].padStart(2, "0") + ":" + m[5], o, h, l, cl]);
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
        k.forEach(x => { const w = new Date(x[0] + off * 6e4), td = new Date(x[0] + off * 6e4 + 216e5).toISOString().slice(0, 10); (out[td] = out[td] || []).push([w.toISOString().slice(0, 16).replace("T", " "), +x[1], +x[2], +x[3], +x[4]]); });
        return Object.keys(out).sort().filter(t => out[t].length > 200).map(t => ({day: t, ny: true, demo: "BTCUSDT", real: true, bars: out[t]}));
      } catch(e){ break; }
    }
    const res = []; let p = 21000;
    for (let k = 4; k >= 0; k--){ const dd = new Date(now - 864e5 * (8 + k)); if (dd.getUTCDay() === 0 || dd.getUTCDay() === 6) continue; const day = dd.toISOString().slice(0, 10), bars = []; let v = 6;
      for (let m = 420; m < 960; m++){ v = clamp(v * (0.97 + Math.random() * .06) + (m === 570 ? 8 : 0), 3, 18); const o = p, c = Math.round((o + (Math.random() - .5) * v * 1.6) * 4) / 4, h = Math.max(o, c) + Math.round(Math.random() * v * 2) / 4, l = Math.min(o, c) - Math.round(Math.random() * v * 2) / 4; bars.push([day + " " + hm(m), o, h, l, c]); p = c; }
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
  const equity = () => set.bal + hist.reduce((a, t) => a + (t.usd || 0), 0);
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
    for (let i = AG.n; i < S.pos; i++){ const b = S.B[i], g = grp(b.t, tf), L = a[a.length - 1]; if (!L || L.t !== g) a.push({t: g, i: a.length, o: b.o, h: b.h, l: b.l, c: b.c}); else { if (b.h > L.h) L.h = b.h; if (b.l < L.l) L.l = b.l; L.c = b.c; } }
    AG.n = S.pos; return AG;
  }
  let aggC = null;
  function idxT(t){ const a = agg().a, n = a.length; if (!n) return 0; if (t < a[0].t) return (t - a[0].t) / S.tf; if (t >= a[n - 1].t) return n - 1 + (t - a[n - 1].t) / S.tf;
    let lo = 0, hi = n - 1; while (hi - lo > 1){ const m = (lo + hi) >> 1; if (a[m].t <= t) lo = m; else hi = m; } return lo + Math.min(.999, (t - a[lo].t) / S.tf); }
  function tIdx(i){ const a = agg().a, n = a.length; if (!n) return 0; if (i < 0) return a[0].t + i * S.tf; if (i >= n - 1) return a[n - 1].t + (i - (n - 1)) * S.tf; const k = Math.floor(i); return a[k].t + (i - k) * S.tf; }
  function atr(n){ const a = agg().a, k = Math.min(n, a.length - 1); if (k < 2) return tick() * 16; let s = 0; for (let i = a.length - k; i < a.length; i++) s += Math.max(a[i].h - a[i].l, Math.abs(a[i].h - a[i - 1].c), Math.abs(a[i].l - a[i - 1].c)); return s / k; }

  // ---------- geometry ----------
  const AXW = 64, AXH = 26;
  let W = 800, H = 480, PW = 736, PH = 454;
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
      up: "#16b67f", dn: "#f0475a", cu: set.cup || "#16b67f", cd: set.cdn || "#f0475a", acc: v("--accent") || "#8ab4ff", axis: light ? "rgba(30,20,60,.12)" : "rgba(255,255,255,.09)", draw: light ? "#5b3fd6" : "#a98bff"};
  }

  // ---------- drawing ----------
  function req(){ if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); }
  function paint(){
    if (!ui) return; const cv = ui.cv, dpr = window.devicePixelRatio || 1, r = ui.box.getBoundingClientRect();
    W = Math.max(280, Math.floor(r.width)); H = Math.max(260, Math.floor(r.height)); PW = W - AXW; PH = H - AXH;
    if (cv.width !== W * dpr || cv.height !== H * dpr){ cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px"; }
    const c = cv.getContext("2d"), P = pal(), A = agg(), a = A.a; c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = P.bg; c.fillRect(0, 0, W, H);
    if (!S.B.length){ c.fillStyle = P.muted; c.font = "500 14px Inter,system-ui,sans-serif"; c.textAlign = "center"; c.fillText(T("Nahraj data nebo spusť ukázku", "Load data or start the demo"), W / 2, H / 2); return; }
    fitY();
    // grid and price axis
    const step = nice((yHi - yLo) / Math.max(3, PH / 70)); c.font = "500 11px Inter,system-ui,sans-serif"; c.textBaseline = "middle";
    const dec = step < .1 ? 2 : step < 1 ? 2 : 0;
    for (let p = Math.ceil(yLo / step) * step; p <= yHi; p += step){ const y = Math.round(yOf(p)) + .5; c.strokeStyle = P.grid; c.lineWidth = 1; c.beginPath(); c.moveTo(0, y); c.lineTo(PW, y); c.stroke(); c.fillStyle = P.muted; c.textAlign = "left"; c.fillText(num(p, dec), PW + 8, y); }
    // time axis
    const i0 = Math.floor(iOf(0)) - 1, i1 = Math.ceil(iOf(PW)) + 1; c.textAlign = "center"; c.textBaseline = "middle";
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240, 360, 720], mins = S.tf >= 1440 ? 0 : (steps.find(s => s / S.tf * S.bw >= 70) || 1440), gap = 64; let lastX = -1e9;
    const dlab = t => { const d = new Date(t * 6e4); return d.getUTCDate() + ". " + (d.getUTCMonth() + 1) + "."; };
    for (let i = Math.max(0, i0); i <= Math.min(a.length - 1, i1); i++){ const t = a[i].t, x = Math.round(xOf(i)) + .5; if (x < 0 || x > PW) continue;
      const prev = i > 0 ? a[i - 1].t : null, newDay = prev == null || tdOf(prev) !== tdOf(t), newMon = prev != null && new Date(prev * 6e4).getUTCMonth() !== new Date(t * 6e4).getUTCMonth();
      let txt = null, bold = false;
      if (S.tf >= 1440){ if (x - lastX >= gap){ txt = newMon ? new Date(t * 6e4).toLocaleDateString(loc(), {month: "short", timeZone: "UTC"}) : dlab(t + 360); bold = newMon; } }
      else if (newDay && x - lastX >= gap * .8){ txt = dlab(t + 360); bold = true; }
      else if (mins && modOf(t) % mins === 0 && x - lastX >= gap){ txt = hm(t); }
      if (newDay && S.tf < 1440 && i > 0){ c.strokeStyle = P.axis; c.beginPath(); c.moveTo(x - S.bw / 2, 0); c.lineTo(x - S.bw / 2, PH); c.stroke(); }
      if (!txt) continue; lastX = x; c.strokeStyle = P.grid; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, PH); c.stroke(); c.fillStyle = bold ? P.ink : P.muted; c.font = (bold ? "700 " : "500 ") + "11px Inter,system-ui,sans-serif"; c.fillText(txt, x, PH + AXH / 2); }
    c.font = "500 11px Inter,system-ui,sans-serif";
    // cycles (training)
    if (set.cyc) cycPaint(c, P);
    // extended hours shading (outside 9:30-16:00 New York)
    if (set.sess === "eth" && S.tf < 240){ c.fillStyle = P.light ? "rgba(40,25,80,.035)" : "rgba(255,255,255,.025)"; let st = null;
      for (let k = Math.max(0, i0); k <= Math.min(a.length - 1, i1) + 1; k++){ const b = a[k], out = b ? (modOf(b.t) < 570 || modOf(b.t) >= 960) : false; if (out && st == null) st = k; if ((!out || !b) && st != null){ const xa = xOf(st) - S.bw / 2, xb = xOf(k) - S.bw / 2; c.fillRect(Math.max(0, xa), 0, Math.min(PW, xb) - Math.max(0, xa), PH); st = null; } } }
    // candles
    const bw = Math.max(1, S.bw * .7);
    c.save(); c.beginPath(); c.rect(0, 0, PW, PH); c.clip();
    for (let k = Math.max(0, i0); k <= Math.min(a.length - 1, i1); k++){ const b = a[k], x = xOf(b.i), up = b.c >= b.o, col = up ? P.cu : P.cd; c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1;
      const t = yOf(Math.max(b.o, b.c)), bt = yOf(Math.min(b.o, b.c)), bx = Math.round(x - bw / 2), bwp = Math.max(1, Math.round(bw)), xm = Math.round(x) + .5;
      if (up && set.hollow && bwp > 2){ c.beginPath(); c.moveTo(xm, yOf(b.h)); c.lineTo(xm, t); c.moveTo(xm, bt); c.lineTo(xm, yOf(b.l)); c.stroke(); c.strokeRect(bx + .5, t + .5, bwp - 1, Math.max(1, bt - t - 1)); }
      else { c.beginPath(); c.moveTo(xm, yOf(b.h)); c.lineTo(xm, yOf(b.l)); c.stroke(); c.fillRect(bx, t, bwp, Math.max(1, bt - t)); } }
    // drawings
    S.draws.forEach(d => drawObj(c, P, d));
    if (S.creating && S.creating.d) drawObj(c, P, S.creating.d);
    // crosshair
    const m = S.mouse;
    if (m && m.x < PW && m.y < PH && m.y >= 0){ c.setLineDash([4, 4]); c.strokeStyle = P.muted; c.globalAlpha = .7; c.beginPath(); c.moveTo(0, Math.round(m.y) + .5); c.lineTo(PW, Math.round(m.y) + .5); c.moveTo(Math.round(m.x) + .5, 0); c.lineTo(Math.round(m.x) + .5, PH); c.stroke(); c.setLineDash([]); c.globalAlpha = 1; }
    c.restore();
    // axis lines
    c.strokeStyle = P.axis; c.beginPath(); c.moveTo(PW + .5, 0); c.lineTo(PW + .5, H); c.moveTo(0, PH + .5); c.lineTo(W, PH + .5); c.stroke();
    // last price tag
    const lb = last(); if (lb){ const y = yOf(lb.c); if (y > 0 && y < PH){ const col = lb.c >= lb.o ? P.cu : P.cd; c.setLineDash([2, 3]); c.strokeStyle = col; c.globalAlpha = .6; c.beginPath(); c.moveTo(0, Math.round(y) + .5); c.lineTo(PW, Math.round(y) + .5); c.stroke(); c.setLineDash([]); c.globalAlpha = 1; tag(c, PW, y, num(lb.c, dec || (tick() < 1 ? 2 : 0)), col, "#fff"); } }
    // labels for open trades on the axis
    S.draws.forEach(d => { if (d.k !== "pos" || !(d.st === "open" || d.st === "draft" || d.st === "pending")) return; tag(c, PW, yOf(d.sl), num(d.sl, 2), P.dn, "#fff"); tag(c, PW, yOf(d.tp), num(d.tp, 2), P.up, "#fff"); });
    if (m && m.x < PW && m.y < PH && m.y >= 0){ tag(c, PW, m.y, num(rt(pOf(m.y)), 2), P.light ? "#2b2440" : "#e9e9ee", P.light ? "#fff" : "#111"); const t = tIdx(Math.round(iOf(m.x))); const tw = S.tf >= 1440 ? 62 : 92; c.fillStyle = P.light ? "#2b2440" : "#e9e9ee"; rrect(c, m.x - tw / 2, PH + 3, tw, AXH - 6, 4); c.fill(); c.fillStyle = P.light ? "#fff" : "#111"; c.textAlign = "center"; c.fillText(S.tf >= 1440 ? new Date((t + 360) * 6e4).toLocaleDateString(loc(), {day: "numeric", month: "numeric", year: "2-digit", timeZone: "UTC"}) : new Date((t + 360) * 6e4).toLocaleDateString(loc(), {day: "numeric", month: "numeric", timeZone: "UTC"}) + " " + hm(t), m.x, PH + AXH / 2); }
    legend();
    panelPaint(); otbPaint();
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
    const slHit = d.dir > 0 ? b.l <= d.sl : b.h >= d.sl, tpHit = d.dir > 0 ? b.h >= d.tp : b.l <= d.tp;
    if (slHit){ let px = d.sl; if (d.dir > 0 ? b.o < d.sl : b.o > d.sl) px = b.o; close(d, px, b.t, "sl"); }
    else if (tpHit){ let px = d.tp; if (d.dir > 0 ? b.o > d.tp : b.o < d.tp) px = b.o; close(d, px, b.t, "tp"); }
  }
  function close(d, px, t, why){
    const I = inst(), r = d.dir * (px - d.e) / Math.abs(d.e - d.sl0), $ = d.dir * (px - d.e) * d.q * I.pv - (+set.comm || 0) * d.q;
    d.ex = px; d.tx = t; d.r = Math.round(r * 100) / 100; d.usd = Math.round($ * 100) / 100; d.st = d.r > .02 ? "win" : d.r < -.02 ? "loss" : "be";
    const rec = {id: d.id, day: tdOf(d.t1), sym: inst().n, demo: S.demo || "", dir: d.dir, e: d.e, sl: d.sl0, tp: d.tp, ex: px, t1: d.t1, tx: t, q: d.q, r: d.r, usd: d.usd, why: why, ts: new Date().toISOString(), tf: S.tf};
    hist.push(rec); saveHist();
    try { const j = API().jr(); j.paper = j.paper || []; j.paper.push({ts: rec.ts, r: rec.r, setup: "Replay", usd: rec.usd}); API().store(); API().touchDay(); } catch(e){}
    promo(); toast((d.r >= 0 ? "✓ " : "✕ ") + (why === "tp" ? T("Cíl zasažen", "Target hit") : why === "sl" ? T("Stop zasažen", "Stop hit") : T("Pozice zavřena", "Position closed")) + " · " + rr(d.r) + " · " + usd(d.usd));
    statsPaint(); posList();
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
  function after(){ const now = Date.now(); if (now - sessT > 800){ sessT = now; saveSess(); } posList(); ctlPaint(); req(); if (S.pos >= S.B.length && !S.ended){ S.ended = true; toast(T("Konec nahraných dat. Otevřené pozice zavírám za poslední cenu.", "End of the loaded data. Closing open positions at the last price.")); S.draws.forEach(d => { if (d.k === "pos" && d.st === "open") close(d, last().c, last().t, "eod"); if (d.k === "pos" && d.st === "pending") d.st = "cancel"; }); S.draws = S.draws.filter(d => d.st !== "cancel"); req(); } }
  function back(){
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
    stop(); S.demo = d.demo || ""; const L = lib(), k = Math.max(0, L.findIndex(x => x.day === d.day)), win = L.slice(Math.max(0, k - 60), k + 16);
    const B = []; win.forEach(w => { const sh = w.ny || w.demo ? 0 : (+set.tz || 0); w.bars.forEach(x => { const ts = String(x[0]); B.push({t: dayBase(ts.slice(0, 10)) + +ts.slice(11, 13) * 60 + +ts.slice(14, 16) + sh, o: x[1], h: x[2], l: x[3], c: x[4]}); }); });
    B.sort((a, b) => a.t - b.t); const B2 = []; S.ethData = false; B.forEach(b => { const m = modOf(b.t); if (m < 420 || m >= 960) S.ethData = true; if (set.sess === "rth" && (m < 570 || m >= 960)) return; if (!B2.length || b.t !== B2[B2.length - 1].t) B2.push(b); }); S.B = B2;
    const t0 = S.B.length ? S.B[0].t : 0, t1 = S.B.length ? S.B[S.B.length - 1].t + 1440 * 3 : 0;
    const all = S.demo ? [] : (drawStore.all || []); S.drawOut = all.filter(x => { const a = anchor(x); return !(a >= t0 && a <= t1); });
    S.draws = all.filter(x => { const a = anchor(x); return a >= t0 && a <= t1; }).map(x => Object.assign({}, x, {id: uid++}));
    hist.filter(h => !h.demo && !S.demo && h.t1 >= t0 && h.t1 <= t1).forEach(h => S.draws.push({k: "pos", id: uid++, dir: h.dir, e: h.e, sl: h.sl, sl0: h.sl, tp: h.tp, t1: h.t1, t2: Math.max(h.tx, h.t1 + 20 * (h.tf || 1)), q: h.q, ex: h.ex, tx: h.tx, r: h.r, usd: h.usd, st: h.r > .02 ? "win" : h.r < -.02 ? "loss" : "be", ot: "mkt"}));
    const base = dayBase(d.day); let p0 = S.B.findIndex(b => b.t >= base + 540); if (p0 < 0) p0 = S.B.findIndex(b => tdOf(b.t) === d.day) + 1; if (p0 <= 0) p0 = Math.floor(S.B.length * .5);
    if (startAt != null){ const q = S.B.findIndex(b => b.t > startAt); p0 = q < 0 ? S.B.length : q; }
    if (!S.demo){ const done = hist.filter(h => !h.demo && h.tx >= t0 && h.tx <= t1).map(h => h.tx); if (startAt != null && done.length){ const lx = Math.max.apply(null, done), q = S.B.findIndex(b => b.t > lx); if (q > p0) p0 = q; } }
    S.pos = clamp(p0, 2, S.B.length); S.day = tdOf(S.B[S.pos - 1].t);
    S.sel = null; S.yMan = null; S.follow = true; S.off = 14; S.bw = window.innerWidth < 700 ? 6 : 9; S.ended = false; if (ui && ui.quiz) ui.quiz.hidden = true;
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
    if (y > PH){ S.drag = {k: "xs", x: x, bw: S.bw, R: rightIdx()}; return; }
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
    if (!D){ const h = S.B.length && x < PW && y < PH ? hit(x, y) : null; ui.cv.style.cursor = x > PW ? "ns-resize" : y > PH ? "ew-resize" : S.tool !== "cur" ? "crosshair" : h ? (h.h === "sl" || h.h === "tp" || h.h === "e" ? "ns-resize" : h.h === "w" ? "ew-resize" : h.h === "sel" ? "pointer" : "move") : "crosshair"; req(); return; }
    if (D.k === "pan"){ setR(D.R - (x - D.x) / S.bw); if (S.yMan || Math.abs(y - D.y) > 12){ const rng = D.hi - D.lo, dp = (y - D.y) / PH * rng; S.yMan = {lo: D.lo + dp, hi: D.hi + dp}; } req(); return; }
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
    S.drag = null;
  }
  function finishCreate(){ const d = S.creating.d; S.creating = null; if (Math.abs(d.a.t - d.b.t) < 1e-6 && Math.abs(d.a.p - d.b.p) < 1e-9){ req(); return; } S.draws.push(d); S.sel = d; setTool("cur"); saveDraw(); req(); }
  function onWheel(ev){
    if (!S.B.length) return; ev.preventDefault(); const r = ui.cv.getBoundingClientRect(), x = ev.clientX - r.left;
    if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) && !ev.ctrlKey){ setR(rightIdx() + ev.deltaX / S.bw); req(); return; }
    const f = Math.exp(-ev.deltaY * (ev.ctrlKey ? .01 : .0018)), im = iOf(Math.min(x, PW)); S.bw = clamp(S.bw * f, 1.5, 70); setR(im + (PW - Math.min(x, PW)) / S.bw); req();
  }
  function onDbl(ev){ const r = ui.cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top; if (x > PW || y > PH){ S.yMan = null; S.follow = true; S.off = 8; S.bw = 9; req(); } }
  function setTool(t){ S.tool = t; S.creating = null; if (ui) ui.tools.querySelectorAll("button[data-t]").forEach(b => b.classList.toggle("on", b.dataset.t === t)); }
  function delSel(){ const d = S.sel; if (!d) return; if (d.k === "pos" && (d.st === "open")){ toast(T("Otevřenou pozici zavři tlačítkem Zavřít.", "Close an open position with the Close button.")); return; } if (d.k === "pos" && ["win", "loss", "be", "closed"].indexOf(d.st) >= 0){ toast(T("Hotový obchod zůstává v historii.", "A finished trade stays in the history.")); return; } S.draws = S.draws.filter(x => x !== d); S.sel = null; saveDraw(); posList(); req(); }
  function key(ev){
    if (!ui || !S.B.length) return; const tg = ev.target; if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || tg.isContentEditable)) return;
    if (location.hash !== "#backtest") return;
    if (ev.key === " "){ ev.preventDefault(); play(); } else if (ev.key === "ArrowRight"){ ev.preventDefault(); stop(); stepTF(ev.shiftKey ? 10 : 1); } else if (ev.key === "ArrowLeft"){ ev.preventDefault(); stop(); back(); }
    else if (ev.key === "Delete" || ev.key === "Backspace"){ if (S.sel){ ev.preventDefault(); delSel(); } } else if (ev.key === "Escape"){ setTool("cur"); S.sel = null; S.draws = S.draws.filter(d => d.st !== "draft"); posList(); req(); }
    else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey){ const m = {t: "line", h: "h", r: "rect", f: "fib", x: "txt", l: "long", s: "short", v: "cur"}[ev.key.toLowerCase()]; if (m) setTool(m); }
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
    d.q = sz.q; d.sl0 = d.sl;
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
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>', pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor"/>', next: '<path d="M5 4l10 8-10 8zM17 4h2v16h-2z" fill="currentColor"/>', prev: '<path d="M19 4L9 12l10 8zM5 4h2v16H5z" fill="currentColor"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>', grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>'
  };
  const svgI = n => '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[n] + '</svg>';
  function ibtn(n, title, fn, cls){ const b = btn("rp-ib" + (cls ? " " + cls : ""), null, fn, title); b.innerHTML = svgI(n); return b; }

  function legend(){
    if (!ui) return; const a = agg().a, m = S.mouse; let b = a[a.length - 1];
    if (m && m.x < PW && m.y < PH){ const k = Math.round(iOf(m.x)); b = a.find(z => z.i === k) || b; }
    const I = inst(), d = new Date(S.day + "T12:00:00"), ds = isNaN(d) ? S.day : d.toLocaleDateString(loc(), {weekday: "short", day: "numeric", month: "numeric", year: "numeric"});
    ui.ttl.textContent = (S.demo ? (S.demo === "SIM" ? T("Ukázka (vymyšlená data)", "Demo (invented data)") : "BTCUSDT · Binance") : I.n + " · " + I.full) + " · " + (TFS.find(x => x[0] === S.tf) || [0, S.tf + "m"])[1] + " · " + ds;
    if (b){ const dc = I.tick < 1 && I.tick >= .25 ? 2 : 2, ch = b.c - b.o; ui.ohlc.innerHTML = ""; [["O", b.o], ["H", b.h], ["L", b.l], ["C", b.c]].forEach(x => { const s = mk("span", null, x[0] + " "); const v = mk("b", ch >= 0 ? "up" : "dn", num(x[1], dc)); s.appendChild(v); ui.ohlc.appendChild(s); }); ui.ohlc.appendChild(mk("span", ch >= 0 ? "up" : "dn", (ch >= 0 ? "+" : "") + num(ch, 2))); if (m && m.x < PW) ui.ohlc.appendChild(mk("span", null, S.tf >= 1440 ? new Date((b.t + 360) * 6e4).toLocaleDateString(loc(), {day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC"}) : new Date(b.t * 6e4).toLocaleDateString(loc(), {day: "numeric", month: "numeric", timeZone: "UTC"}) + " " + hm(b.t))); ui.clock.textContent = (last() ? new Date((last().t) * 6e4).toLocaleDateString(loc(), {day: "numeric", month: "numeric", timeZone: "UTC"}) + " " + hm(last().t) : "") + " NY"; }
  }
  // ---------- object toolbar (like TradingView): colour, width, style, fill, lock, clone, delete ----------
  const COLS = ["#a98bff", "#7c4dff", "#2962ff", "#2196f3", "#00bcd4", "#26a69a", "#16b67f", "#8bc34a", "#ffeb3b", "#ffb300", "#ff9800", "#ff5722", "#f0475a", "#e91e63", "#ec407a", "#9c27b0", "#ffffff", "#9e9e9e", "#1d1530"];
  function palette(anchor, d, upd){
    let pp = ui.otb.querySelector(".rp-pal"); if (pp){ pp.remove(); return; } pp = mk("div", "rp-pal");
    COLS.forEach(c => { const b = btn("rp-sw" + ((d.col || "") === c ? " on" : ""), null, () => { d.col = c; anchor.firstChild.style.background = c; pp.remove(); upd(); }, c); b.style.background = c; pp.appendChild(b); });
    const ci = mk("input"); ci.type = "color"; ci.value = /^#[0-9a-f]{6}$/i.test(d.col || "") ? d.col : "#a98bff"; ci.title = T("Vlastní barva", "Custom colour"); ci.addEventListener("input", () => { d.col = ci.value; anchor.firstChild.style.background = ci.value; upd(); }); pp.appendChild(ci);
    ui.otb.appendChild(pp);
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
    if (!live.length){ box.hidden = true; panelPaint(); return; } box.hidden = false;
    live.forEach(d => { const row = mk("div", "rp-prow"), pnl = d.st === "open" && lb ? d.dir * (lb.c - d.e) * d.q * I.pv : 0, r = d.st === "open" && lb ? d.dir * (lb.c - d.e) / Math.abs(d.e - d.sl0) : 0;
      row.appendChild(mk("span", "rp-dir " + (d.dir > 0 ? "buy" : "sell"), d.dir > 0 ? "Long" : "Short"));
      row.appendChild(mk("span", "small", num(d.q, I.step < 1 ? 3 : 0) + " " + I.n + " @ " + num(d.e, 2) + (d.st === "pending" ? " · " + otName(d.ot || "lim") + T(" čeká", " pending") : "")));
      row.appendChild(mk("span", "small muted", "SL " + num(d.sl, 2) + " · TP " + num(d.tp, 2)));
      if (d.st === "open") row.appendChild(mk("b", pnl >= 0 ? "pos" : "neg", rr(r) + " · " + usd(pnl)));
      const act = mk("div", "rp-pact"); if (d.st === "open") act.appendChild(btn("chip", T("Stop na nulu", "Stop to BE"), () => toBE(d))); act.appendChild(btn("chip", d.st === "pending" ? T("Zrušit", "Cancel") : T("Zavřít", "Close"), () => closeNow(d))); row.appendChild(act);
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
  function statsPaint(){
    if (!ui) return; const box = ui.stats; box.innerHTML = "";
    const all = hist.filter(h => ui.scope === "all" || (ui.scope === "day" ? h.day === S.day : true));
    const n = all.length, w = all.filter(h => h.r > .02), l = all.filter(h => h.r < -.02), tr = all.reduce((a, h) => a + h.r, 0), tu = all.reduce((a, h) => a + h.usd, 0);
    const gw = w.reduce((a, h) => a + h.usd, 0), gl = -l.reduce((a, h) => a + h.usd, 0); let pk = 0, cum = 0, dd = 0; all.forEach(h => { cum += h.r; pk = Math.max(pk, cum); dd = Math.min(dd, cum - pk); });
    const tiles = mk("div", "rp-tiles"), tl = (k, v, cls) => { const t = mk("div", "rp-tile"); t.appendChild(mk("span", null, k)); t.appendChild(mk("b", cls || null, v)); tiles.appendChild(t); };
    tl(T("Obchodů", "Trades"), String(n)); tl("Winrate", n ? Math.round(100 * w.length / n) + " %" : "–"); tl(T("Celkem", "Total"), n ? rr(tr) : "–", tr >= 0 ? "pos" : "neg"); tl("P&L", n ? usd(tu) : "–", tu >= 0 ? "pos" : "neg");
    tl("Profit factor", gl > 0 ? num(gw / gl, 2) : n ? "∞" : "–"); tl(T("Průměr", "Average"), n ? rr(tr / n) : "–"); tl("Max DD", n ? rr(dd) : "–", "neg"); tl(T("Účet", "Account"), "$" + num(equity(), 0));
    box.appendChild(tiles);
    if (n >= 2){ const cv = mk("canvas", "rp-eq"); box.appendChild(cv); requestAnimationFrame(() => { const dpr = window.devicePixelRatio || 1, w2 = cv.clientWidth || 600, h2 = 110; cv.width = w2 * dpr; cv.height = h2 * dpr; const c = cv.getContext("2d"), P = pal(); c.scale(dpr, dpr); let s = 0; const pts = [0].concat(all.map(h => (s += h.r))); const lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts), Y = v => 8 + (hi - v) / ((hi - lo) || 1) * (h2 - 16), X = i => 4 + i / (pts.length - 1) * (w2 - 8);
      c.strokeStyle = P.axis; c.setLineDash([3, 4]); c.beginPath(); c.moveTo(0, Y(0)); c.lineTo(w2, Y(0)); c.stroke(); c.setLineDash([]); const g = c.createLinearGradient(0, 0, 0, h2); g.addColorStop(0, s >= 0 ? "rgba(22,182,127,.28)" : "rgba(240,71,90,.28)"); g.addColorStop(1, "rgba(0,0,0,0)");
      c.beginPath(); pts.forEach((v, i) => i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))); c.lineTo(X(pts.length - 1), h2); c.lineTo(X(0), h2); c.closePath(); c.fillStyle = g; c.fill(); c.beginPath(); pts.forEach((v, i) => i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v))); c.strokeStyle = s >= 0 ? P.up : P.dn; c.lineWidth = 2; c.stroke(); }); }
    if (n){ const tb = mk("div", "rp-hist"); all.slice(-60).reverse().forEach(h => { const r = mk("div", "rp-hrow"); r.appendChild(mk("span", "small muted", h.day + " " + hm(h.t1))); r.appendChild(mk("span", "rp-dir " + (h.dir > 0 ? "buy" : "sell"), h.dir > 0 ? "Long" : "Short")); r.appendChild(mk("span", "small", num(h.e, 2) + " → " + num(h.ex, 2))); r.appendChild(mk("span", "small muted", h.why === "tp" ? T("cíl", "target") : h.why === "sl" ? "stop" : h.why === "eod" ? T("konec dne", "end of day") : T("ručně", "manual"))); r.appendChild(mk("b", h.r >= 0 ? "pos" : "neg", rr(h.r) + " · " + usd(h.usd))); tb.appendChild(r); }); box.appendChild(tb); }
    else box.appendChild(mk("p", "small muted", T("Zatím žádný obchod. Klikni na Long nebo Short v rohu grafu, natáhni stop a cíl a potvrď vstup.", "No trades yet. Click Long or Short in the chart corner, drag the stop and target and confirm.")));
  }
  function settingsPop(){
    const pop = ui.setp; if (!pop.hidden){ pop.hidden = true; return; } pop.innerHTML = ""; pop.hidden = false;
    const row = (lab, el2) => { const l = mk("label", "rp-f"); l.appendChild(mk("span", null, lab)); l.appendChild(el2); pop.appendChild(l); return el2; };
    const ni = (v, fn, st) => { const i = mk("input"); i.type = "number"; i.step = st || "any"; i.value = v; i.addEventListener("change", () => { fn(parseFloat(String(i.value).replace(",", "."))); saveSet(); panelPaint(); req(); statsPaint(); }); return i; };
    const s1 = mk("select"); Object.keys(INSTR).filter(k => k !== "BTC").forEach(k => { const o = mk("option", null, k + " · $" + INSTR[k].pv + T(" za bod", " per point")); o.value = k; if (k === set.inst) o.selected = true; s1.appendChild(o); }); s1.addEventListener("change", () => { set.inst = s1.value; saveSet(); legend(); panelPaint(); req(); }); row(T("Kontrakt", "Contract"), s1);
    row(T("Účet ($)", "Account ($)"), ni(set.bal, v => { if (v > 0) set.bal = v; }, "100"));
    const rw = mk("div", "rp-rw"), ri = ni(set.risk, v => { if (v > 0) set.risk = v; }), ms = mk("div", "rp-seg"); ["%", "$"].forEach(m => { const b = btn(m === set.mode ? "on" : "", m, () => { set.mode = m; if (m === "$" && set.risk < 20) { set.risk = Math.round(equity() * set.risk / 100); ri.value = set.risk; } if (m === "%" && set.risk > 20){ set.risk = Math.round(100 * set.risk / equity() * 100) / 100; ri.value = set.risk; } ms.querySelectorAll("button").forEach(x => x.classList.toggle("on", x.textContent === m)); saveSet(); panelPaint(); req(); }); ms.appendChild(b); }); rw.appendChild(ri); rw.appendChild(ms); row(T("Riziko na obchod (1R)", "Risk per trade (1R)"), rw);
    row(T("Poplatek za kontrakt ($)", "Commission per contract ($)"), ni(set.comm, v => { set.comm = v >= 0 ? v : 0; }, ".1"));
    const tz = mk("select"); [["0", T("Časy v souboru: New York", "File times: New York")], ["-300", T("UTC, zimní čas", "UTC, winter time")], ["-240", T("UTC, letní čas", "UTC, summer time")], ["-360", T("Praha", "Prague")]].forEach(x => { const o = mk("option", null, x[1]); o.value = x[0]; if (+x[0] === +set.tz) o.selected = true; tz.appendChild(o); }); tz.addEventListener("change", () => { set.tz = +tz.value; saveSet(); const d = lib().find(x => x.day === S.day); if (d) loadDay(d, last() ? last().t : null); }); row(T("Časové pásmo CSV", "CSV time zone"), tz);
    const cb = mk("div", "rp-f"); cb.appendChild(mk("span", null, T("Barvy svíček", "Candle colours"))); const pr = mk("div", "rp-cpre"), ci = mk("div", "rp-cin");
    const PRE = [[T("Klasické", "Classic"), "#16b67f", "#f0475a"], ["TradingView", "#089981", "#f23645"], [T("Modrá a oranžová", "Blue and orange"), "#2962ff", "#ff9800"], [T("Tyrkys a růžová", "Teal and pink"), "#26c6da", "#ec407a"], [T("Černobílé", "Mono"), pal().light ? "#1d1530" : "#e8e8ee", pal().light ? "#a59fb8" : "#5c5c68"]];
    const cu = mk("input"), cd = mk("input"); cu.type = cd.type = "color"; cu.value = set.cup || "#16b67f"; cd.value = set.cdn || "#f0475a"; cu.setAttribute("aria-label", T("Rostoucí svíčka", "Up candle")); cd.setAttribute("aria-label", T("Klesající svíčka", "Down candle"));
    const apply = () => { set.cup = cu.value; set.cdn = cd.value; saveSet(); req(); };
    cu.addEventListener("input", apply); cd.addEventListener("input", apply);
    PRE.forEach(x => { const b = btn("rp-cp", null, () => { cu.value = x[1]; cd.value = x[2]; apply(); }, x[0]); b.innerHTML = '<i style="background:' + x[1] + '"></i><i style="background:' + x[2] + '"></i>'; pr.appendChild(b); });
    const l1 = mk("label", "rp-cl"); l1.appendChild(cu); l1.appendChild(mk("span", "small", T("Rostoucí", "Up"))); const l2 = mk("label", "rp-cl"); l2.appendChild(cd); l2.appendChild(mk("span", "small", T("Klesající", "Down")));
    const hl = mk("label", "rp-cl"), hc = mk("input"); hc.type = "checkbox"; hc.checked = !!set.hollow; hc.addEventListener("change", () => { set.hollow = hc.checked; saveSet(); req(); }); hl.appendChild(hc); hl.appendChild(mk("span", "small", T("Duté rostoucí", "Hollow up")));
    ci.appendChild(l1); ci.appendChild(l2); ci.appendChild(hl); cb.appendChild(pr); cb.appendChild(ci); pop.appendChild(cb);
    const cy = mk("label", "chk"), cc = mk("input"); cc.type = "checkbox"; cc.checked = !!set.cyc; cc.addEventListener("change", () => { set.cyc = cc.checked; saveSet(); req(); }); cy.appendChild(cc); cy.appendChild(mk("span", null, T("Trénink 90minutových cyklů: PCH, PCL a otázky", "90-minute cycle training: PCH, PCL and questions"))); pop.appendChild(cy);
    const mg = mk("label", "chk"), mc = mk("input"); mc.type = "checkbox"; mc.checked = !!set.magnet; mc.addEventListener("change", () => { set.magnet = mc.checked; saveSet(); }); mg.appendChild(mc); mg.appendChild(mk("span", null, T("Magnet: kreslení se přichytí k high a low svíček", "Magnet: drawings snap to candle highs and lows"))); pop.appendChild(mg);
    pop.appendChild(mk("p", "small muted", T("Klávesy: mezerník přehrát, → další svíčka, Shift+→ deset, ← zpět, T čára, H horizontála, R obdélník, F fibo, L long, S short, Del smazat, Esc zrušit.", "Keys: space play, → next candle, Shift+→ ten, ← back, T line, H horizontal, R rectangle, F fib, L long, S short, Del delete, Esc cancel.")));
    const rs = btn("danger", T("Vynulovat účet a historii", "Reset account and history"), null); let armed = false; rs.addEventListener("click", () => { if (!armed){ armed = true; rs.textContent = T("Opravdu? Klikni znovu", "Sure? Click again"); setTimeout(() => { armed = false; rs.textContent = T("Vynulovat účet a historii", "Reset account and history"); }, 3000); return; } hist = []; saveHist(); S.draws = S.draws.filter(d => !(d.k === "pos" && ["win", "loss", "be", "closed"].indexOf(d.st) >= 0)); statsPaint(); panelPaint(); req(); pop.hidden = true; }); pop.appendChild(rs);
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
    const head = mk("div", "rp-head"), ttl = mk("div", "rp-ttl"), t1 = mk("b"), ohlc = mk("div", "rp-ohlc"), clock = mk("span", "rp-clock"); ttl.appendChild(t1); ttl.appendChild(ohlc); head.appendChild(ttl); head.appendChild(clock);
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
    pl.appendChild(bk); pl.appendChild(playB); pl.appendChild(nx); pl.appendChild(sp); pl.appendChild(jt);
    const right = mk("div", "rp-grp"); right.appendChild(ibtn("gear", T("Nastavení rizika a replaye", "Risk and replay settings"), () => settingsPop())); right.appendChild(ibtn("full", T("Celá obrazovka", "Full screen"), () => fullscreen()));
    const ses = mk("div", "rp-seg rp-ses"); [["eth", "ETH", T("Elektronická seance: celý den 18:00–17:00, mimo hlavní seanci podbarvená", "Electronic trading hours: the full 18:00–17:00 session, extended hours shaded")], ["rth", "RTH", T("Jen hlavní seance 9:30–16:00 New York", "Regular trading hours only, 9:30–16:00 New York")]].forEach(x => { const b = btn(set.sess === x[0] ? "on" : "", x[1], () => { if (set.sess === x[0]) return; set.sess = x[0]; saveSet(); ses.querySelectorAll("button").forEach(z => z.classList.toggle("on", z === b)); const at = last() ? last().t : null, d = lib().find(z => z.day === S.day) || lib()[lib().length - 1]; if (d) loadDay(d, at); }, x[2]); ses.appendChild(b); });
    bar.appendChild(dnav); bar.appendChild(tfs); bar.appendChild(ses); bar.appendChild(pl); bar.appendChild(right);
    // chart area
    const area = mk("div", "rp-area"), tools = mk("div", "rp-tools"), box = mk("div", "rp-box"), cv = mk("canvas"); cv.setAttribute("aria-label", T("Graf replaye", "Replay chart")); cv.setAttribute("role", "img");
    [["cur", T("Kurzor (V)", "Cursor (V)")], ["line", T("Trendová čára (T)", "Trend line (T)")], ["ray", T("Paprsek", "Ray")], ["h", T("Horizontální čára (H)", "Horizontal line (H)")], ["rect", T("Obdélník (R)", "Rectangle (R)")], ["fib", T("Fibonacci s OTE (F)", "Fibonacci with OTE (F)")], ["txt", T("Text (X)", "Text (X)")], ["long", T("Long pozice (L)", "Long position (L)")], ["short", T("Short pozice (S)", "Short position (S)")]].forEach(x => { const b = ibtn(x[0], x[1], () => setTool(x[0])); b.dataset.t = x[0]; tools.appendChild(b); });
    tools.appendChild(mk("i", "rp-sep")); tools.appendChild(ibtn("del", T("Smazat vybrané (Del)", "Delete selected (Del)"), delSel)); tools.appendChild(ibtn("clr", T("Smazat všechny kresby", "Delete all drawings"), () => { S.draws = S.draws.filter(d => d.k === "pos" && d.st && d.st !== "plan"); S.sel = null; saveDraw(); req(); }));
    box.appendChild(cv);
    // corner order panel (draggable)
    const panel = mk("div", "rp-panel"), grip = mk("span", "rp-grip"); grip.innerHTML = svgI("grip"); grip.title = T("Přetáhni panel", "Drag the panel");
    const pr = mk("div", "rp-prow2"), pSell = btn("rp-sell", null, () => draft(-1), T("Short: návrh pozice", "Short: draft a position")), pBuy = btn("rp-buy", null, () => draft(1), T("Long: návrh pozice", "Long: draft a position"));
    pSell.innerHTML = "<span>SHORT</span><b>–</b>"; pBuy.innerHTML = "<span>LONG</span><b>–</b>"; pr.appendChild(grip); pr.appendChild(pSell); pr.appendChild(pBuy);
    const pRisk = btn("rp-risk", "", () => settingsPop(), T("Změnit riziko", "Change risk")), pConf = mk("div", "rp-conf"), pOk = btn("rp-ok", "", () => { const d = S.draws.find(x => x.st === "draft"); if (d) confirm(d); }), pNo = btn("rp-no", T("Zrušit", "Cancel"), () => { S.draws = S.draws.filter(x => x.st !== "draft"); S.sel = null; posList(); req(); });
    const pOT = mk("div", "rp-seg rp-ot"); ["mkt", "lim", "stp"].forEach(k => { const b = btn(k === set.ot ? "on" : "", otName(k), () => setOT(k), k === "mkt" ? T("Za trh: vstup hned za aktuální cenu", "Market: fill now at the current price") : k === "lim" ? T("Limit: long pod cenou, short nad cenou", "Limit: buy below, sell above the price") : T("Stop: long nad cenou, short pod cenou, vstup při průrazu", "Stop: buy above, sell below the price, fills on the break")); b.dataset.ot = k; pOT.appendChild(b); });
    const pSize = mk("div", "rp-seg rp-ot"); [["risk", T("Podle rizika", "By risk")], ["qty", T("Kontrakty", "Contracts")]].forEach(x => { const b = btn(x[0] === set.size ? "on" : "", x[1], () => { set.size = x[0]; saveSet(); posList(); req(); }); b.dataset.sz = x[0]; pSize.appendChild(b); });
    const pQty = mk("div", "rp-qty"), pQm = btn("", "−", () => { set.qty = Math.max(inst().step, Math.round((+set.qty - inst().step) * 1000) / 1000); saveSet(); posList(); req(); }), pQtyI = mk("input"), pQp = btn("", "+", () => { set.qty = Math.round((+set.qty + inst().step) * 1000) / 1000; saveSet(); posList(); req(); }), pQtyU = mk("span", "small muted");
    pQtyI.type = "number"; pQtyI.min = "0"; pQtyI.inputMode = "decimal"; pQtyI.setAttribute("aria-label", T("Počet kontraktů", "Number of contracts")); pQtyI.addEventListener("input", () => { const v = parseFloat(String(pQtyI.value).replace(",", ".")); if (v > 0){ set.qty = v; saveSet(); req(); panelPaint(); } });
    pQty.appendChild(pQm); pQty.appendChild(pQtyI); pQty.appendChild(pQp); pQty.appendChild(pQtyU);
    pConf.appendChild(pOk); pConf.appendChild(pNo); pConf.hidden = true; panel.appendChild(pr); panel.appendChild(pOT); panel.appendChild(pSize); panel.appendChild(pQty); panel.appendChild(pRisk); panel.appendChild(pConf); box.appendChild(panel);
    const setp = mk("div", "rp-setp"); setp.hidden = true; box.appendChild(setp);
    const otb = mk("div", "rp-otb"); otb.hidden = true; box.appendChild(otb); const cm = mk("div", "rp-cm"); cm.hidden = true; box.appendChild(cm);
    document.addEventListener("pointerdown", e => { if (!cm.hidden && !cm.contains(e.target)) cm.hidden = true; const pp = otb.querySelector(".rp-pal"); if (pp && !otb.contains(e.target)) pp.remove(); }, true);
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
    const stH = mk("div", "rp-sth"), stT = mk("h3", null, T("Výsledky replaye", "Replay results")), scope = mk("div", "rp-seg"); stH.appendChild(stT); stH.appendChild(scope);
    const stats = mk("div", "rp-stats");
    wrap.appendChild(head); wrap.appendChild(bar); wrap.appendChild(prog); wrap.appendChild(area); wrap.appendChild(pos); wrap.appendChild(quiz); wrap.appendChild(libB); wrap.appendChild(stH); wrap.appendChild(stats);
    ui = {wrap: wrap, ttl: t1, ohlc: ohlc, clock: clock, daySel: daySel, tfs: tfs, play: playB, jt: jt, tools: tools, box: box, cv: cv, otb: otb, cm: cm, panel: panel, pSell: pSell, pBuy: pBuy, pRisk: pRisk, pOT: pOT, pSize: pSize, pQty: pQty, pQtyI: pQtyI, pQtyU: pQtyU, pConf: pConf, pOk: pOk, setp: setp, empty: empty, prog: pi, pos: pos, quiz: quiz, libInfo: libInfo, stats: stats, scope: "all"};
    [["all", T("Vše", "All")], ["day", T("Tento den", "This day")]].forEach(x => { const b = btn(x[0] === "all" ? "on" : "", x[1], () => { ui.scope = x[0]; scope.querySelectorAll("button").forEach(z => z.classList.toggle("on", z === b)); statsPaint(); }); scope.appendChild(b); });
    panelDrag(grip); setTool("cur");
    cv.addEventListener("pointerdown", onDown); cv.addEventListener("pointermove", onMove); cv.addEventListener("pointerup", onUp); cv.addEventListener("pointercancel", onUp); cv.addEventListener("pointerleave", () => { S.mouse = null; req(); }); cv.addEventListener("wheel", onWheel, {passive: false}); cv.addEventListener("dblclick", onDbl);
    cv.addEventListener("contextmenu", ctxMenu);
    if (window.ResizeObserver) new ResizeObserver(() => { placePanel(); req(); }).observe(box); else window.addEventListener("resize", req);
    document.addEventListener("keydown", key);
    document.addEventListener("fullscreenchange", () => { wrap.classList.toggle("rp-fs", !!document.fullscreenElement); setTimeout(() => { placePanel(); req(); }, 60); });
    window.addEventListener("hashchange", stop);
    ctlPaint(); libPaint(); statsPaint(); emptyPaint(); setTimeout(placePanel, 30);
  }
  function promo(){
    const sub = document.getElementById("rp-pm-sub"), go = document.getElementById("rp-pm-go"); if (!sub) return;
    const ss = LS("tape-rp-sess"), n = hist.length, tr = hist.reduce((a, h) => a + h.r, 0);
    if (ss && ss.day){ const b = S.day === ss.day && last() ? hm(last().t) : ""; sub.textContent = T("Rozehraný den ", "Session in progress: ") + ss.day + (b ? " · " + b : "") + (n ? " · " + n + T(" obchodů · ", " trades · ") + rr(tr) : "") + "."; if (go) go.textContent = T("Pokračovat v replayi", "Continue replay"); }
  }
  function fullscreen(){ const w = ui.wrap; if (document.fullscreenElement){ document.exitFullscreen(); return; } if (w.requestFullscreen) w.requestFullscreen().catch(() => w.classList.toggle("rp-fs")); else { w.classList.toggle("rp-fs"); req(); } }
  function emptyPaint(){
    const e = ui.empty; e.innerHTML = ""; e.hidden = !!S.B.length; ui.panel.hidden = !S.B.length; if (S.B.length) return;
    e.appendChild(mk("b", null, T("Backtest na skutečných svíčkách", "Backtest on real candles")));
    e.appendChild(mk("p", "small", T("Nahraj minutové svíčky NQ nebo ES (CSV z Dukascopy nebo export z TradingView). Tape si dny uloží jen do tohoto zařízení. Nebo si to hned vyzkoušej na ukázce.", "Upload 1-minute NQ or ES candles (CSV from Dukascopy or a TradingView export). Tape keeps the days on this device only. Or try it right away on the demo.")));
    const r = mk("div", "rp-qrow"), up = mk("label", "primary rp-upb"), fi = mk("input"); fi.type = "file"; fi.accept = ".csv,.txt,text/csv"; fi.multiple = true; fi.hidden = true; up.appendChild(mk("span", null, T("Nahrát CSV", "Upload CSV"))); up.appendChild(fi); fi.addEventListener("change", () => upload(fi.files));
    r.appendChild(up); r.appendChild(btn("chip", T("Spustit ukázku", "Start the demo"), () => runDemo())); e.appendChild(r);
  }
  async function upload(files){
    if (!files || !files.length) return; let got = [], epoch = false;
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
    libLoad().then(ds => { S.days = (ds || []).sort((a, b) => a.day.localeCompare(b.day)); libPaint(); const ss = LS("tape-rp-sess"), d = ss && S.days.find(x => x.day === ss.day); if (d){ if (ss.tf && TFS.some(x => x[0] === ss.tf)) S.tf = ss.tf; loadDay(d, ss.at != null ? ss.at : null); } else if (S.days.length) loadDay(S.days[S.days.length - 1]); emptyPaint(); req(); }).catch(() => { emptyPaint(); req(); });
    return true;
  }
  window.TapeReplay = {mount: mount, summary: () => { const ss = LS("tape-rp-sess"), n = hist.length, tr = hist.reduce((a, h) => a + h.r, 0), w = hist.filter(h => h.r > .02).length; return {sess: ss, n: n, r: tr, win: n ? Math.round(100 * w / n) : null, usd: hist.reduce((a, h) => a + h.usd, 0)}; }};
  if (!mount()){ let k = 0; const iv = setInterval(() => { if (mount() || ++k > 100) clearInterval(iv); }, 100); }
})();
