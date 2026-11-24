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
  const TFS = [[1, "1m"], [3, "3m"], [5, "5m"], [15, "15m"], [60, "1h"]];
  const SPEEDS = [[1, "1×"], [3, "3×"], [10, "10×"], [30, "30×"], [60, "60×"]];
  const CYC = [420, 510, 600, 690, 780, 870, 960];

  // ---------- settings and storage ----------
  const DEF = {ot: "mkt", size: "risk", qty: 1, bal: 50000, mode: "%", risk: 1, inst: "NQ", comm: 0, tf: 1, speed: 3, panel: null, cyc: false, tz: 0, magnet: true};
  const set = Object.assign({}, DEF, LS("tape-rp-set") || {});
  try { const s = (API().sym && API().sym()) || ""; if (!LS("tape-rp-set") && INSTR[s]) set.inst = s; } catch(e){}
  const saveSet = () => LS("tape-rp-set", set);
  let hist = LS("tape-rp-hist") || [];
  const saveHist = () => LS("tape-rp-hist", hist.slice(-2000));
  const drawStore = LS("tape-rp-draw") || {};
  let drawTm = null;
  const saveDraw = () => { clearTimeout(drawTm); drawTm = setTimeout(() => { if (!S.day || S.demo) return; drawStore[S.day] = S.draws.filter(d => d.k !== "pos" || !d.st || d.st === "plan").map(d => Object.assign({}, d, {id: undefined})); const ks = Object.keys(drawStore); if (ks.length > 120) delete drawStore[ks.sort()[0]]; LS("tape-rp-draw", drawStore); }, 300); };

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
        const w = new Date(ms + offC[dk] * 6e4), mn = w.getUTCHours() * 60 + w.getUTCMinutes(), wd = w.getUTCDay(); if (mn < 420 || mn >= 960 || wd === 0 || wd === 6) continue;
        ts = w.toISOString().slice(0, 16).replace("T", " "); epoch = true; }
      else if (/^\d{4}[-./]\d{2}[-./]\d{2}T\d{2}:\d{2}/.test(ts)) ts = ts.replace("T", " ");
      else if (/^\d{8}\s/.test(ts)) ts = ts.slice(0, 4) + "-" + ts.slice(4, 6) + "-" + ts.slice(6, 8) + ts.slice(8);
      if (/^\d{1,2}:\d{2}/.test((c[1] || "").trim())){ ts += " " + c[1].trim(); k = 2; }
      const o = parseFloat(c[k]), h = parseFloat(c[k + 1]), l = parseFloat(c[k + 2]), cl = parseFloat(c[k + 3]);
      if (![o, h, l, cl].every(isFinite)) continue;
      const m = ts.match(/^(\d{4})[-./](\d{2})[-./](\d{2})\s+(\d{1,2}):(\d{2})/); if (!m) continue;
      const day = m[1] + "-" + m[2] + "-" + m[3];
      (out[day] = out[day] || []).push([day + " " + m[4].padStart(2, "0") + ":" + m[5], o, h, l, cl]);
    }
    return {epoch: epoch, days: Object.keys(out).filter(d => out[d].length >= (epoch ? 60 : 120) && !(new Set(out[d].map(b => b[4])).size < out[d].length / 3)).sort().map(d => ({day: d, bars: out[d].sort((a, b) => a[0] < b[0] ? -1 : 1)}))};
  }

  // demo: a real BTCUSDT day from Binance's public market-data endpoint, or an invented random walk if that fails
  async function demoDay(){
    const now = Date.now();
    for (let tries = 0; tries < 3; tries++){
      const d = new Date(now - (3 + Math.floor(Math.random() * 50)) * 864e5); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const day = d.toISOString().slice(0, 10), noon = Date.parse(day + "T17:00:00Z"), off = zoneOff(noon, "America/New_York"), start = Date.parse(day + "T07:00:00Z") - off * 6e4;
      try {
        const r = await fetch("https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=540&startTime=" + start);
        if (!r.ok) throw 0; const k = await r.json(); if (!Array.isArray(k) || k.length < 300) throw 0;
        return {day: day, demo: "BTCUSDT", real: true, bars: k.map(x => { const w = new Date(x[0] + off * 6e4); return [day + " " + w.toISOString().slice(11, 16), +x[1], +x[2], +x[3], +x[4]]; })};
      } catch(e){ break; }
    }
    const day = new Date(now - 864e5 * 7).toISOString().slice(0, 10), bars = []; let p = 21000, v = 6;
    for (let m = 420; m < 960; m++){ v = clamp(v * (0.97 + Math.random() * .06) + (m === 570 ? 8 : 0), 3, 18); const o = p, c = Math.round((o + (Math.random() - .5) * v * 1.6) * 4) / 4, h = Math.max(o, c) + Math.round(Math.random() * v * 2) / 4, l = Math.min(o, c) - Math.round(Math.random() * v * 2) / 4; bars.push([day + " " + hm(m), o, h, l, c]); p = c; }
    return {day: day, demo: "SIM", real: false, bars: bars};
  }

  // ---------- state ----------
  const S = {day: "", demo: "", B: [], pos: 0, tf: set.tf, bw: 9, follow: true, off: 8, R: 0, yMan: null, draws: [], tool: "cur", sel: null, hover: null, mouse: null, playing: false, timer: null, days: [], quiz: null, creating: null};
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
  let aggC = null;
  function agg(){
    const key = S.pos + "|" + S.tf + "|" + S.B.length + "|" + S.day; if (aggC && aggC.key === key) return aggC;
    const tf = S.tf, out = []; let cur = null; const t0 = S.B.length ? Math.floor(S.B[0].t / tf) * tf : 0;
    for (let i = 0; i < S.pos; i++){ const b = S.B[i], g = Math.floor(b.t / tf) * tf; if (!cur || cur.t !== g){ cur = {t: g, i: (g - t0) / tf, o: b.o, h: b.h, l: b.l, c: b.c}; out.push(cur); } else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; } }
    aggC = {key: key, a: out, t0: t0}; return aggC;
  }
  const idxT = t => (t - agg().t0) / S.tf;
  const tIdx = i => agg().t0 + i * S.tf;
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
    a.forEach(b => { if (b.i >= i0 && b.i <= i1){ lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); } });
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
      up: "#16b67f", dn: "#f0475a", acc: v("--accent") || "#8ab4ff", axis: light ? "rgba(30,20,60,.12)" : "rgba(255,255,255,.09)", draw: light ? "#5b3fd6" : "#a98bff"};
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
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240], mins = steps.find(s => s / S.tf * S.bw >= 74) || 240;
    const i0 = Math.floor(iOf(0)) - 1, i1 = Math.ceil(iOf(PW)) + 1; c.textAlign = "center"; c.textBaseline = "middle";
    for (let i = i0; i <= i1; i++){ const t = tIdx(i); if (t % mins) continue; const x = Math.round(xOf(i)) + .5; if (x < 0 || x > PW) continue; c.strokeStyle = P.grid; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, PH); c.stroke(); c.fillStyle = P.muted; c.fillText(hm(t), x, PH + AXH / 2); }
    // cycles (training)
    if (set.cyc) cycPaint(c, P);
    // candles
    const bw = Math.max(1, S.bw * .7);
    c.save(); c.beginPath(); c.rect(0, 0, PW, PH); c.clip();
    a.forEach(b => { if (b.i < i0 || b.i > i1) return; const x = xOf(b.i), up = b.c >= b.o, col = up ? P.up : P.dn; c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1;
      c.beginPath(); c.moveTo(Math.round(x) + .5, yOf(b.h)); c.lineTo(Math.round(x) + .5, yOf(b.l)); c.stroke();
      const t = yOf(Math.max(b.o, b.c)), bt = yOf(Math.min(b.o, b.c)); c.fillRect(Math.round(x - bw / 2), t, Math.max(1, Math.round(bw)), Math.max(1, bt - t)); });
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
    const lb = last(); if (lb){ const y = yOf(lb.c); if (y > 0 && y < PH){ const col = lb.c >= lb.o ? P.up : P.dn; c.setLineDash([2, 3]); c.strokeStyle = col; c.globalAlpha = .6; c.beginPath(); c.moveTo(0, Math.round(y) + .5); c.lineTo(PW, Math.round(y) + .5); c.stroke(); c.setLineDash([]); c.globalAlpha = 1; tag(c, PW, y, num(lb.c, dec || (tick() < 1 ? 2 : 0)), col, "#fff"); } }
    // labels for open trades on the axis
    S.draws.forEach(d => { if (d.k !== "pos" || !(d.st === "open" || d.st === "draft" || d.st === "pending")) return; tag(c, PW, yOf(d.sl), num(d.sl, 2), P.dn, "#fff"); tag(c, PW, yOf(d.tp), num(d.tp, 2), P.up, "#fff"); });
    if (m && m.x < PW && m.y < PH && m.y >= 0){ tag(c, PW, m.y, num(rt(pOf(m.y)), 2), P.light ? "#2b2440" : "#e9e9ee", P.light ? "#fff" : "#111"); const t = tIdx(Math.round(iOf(m.x))); const tw = 46; c.fillStyle = P.light ? "#2b2440" : "#e9e9ee"; rrect(c, m.x - tw / 2, PH + 3, tw, AXH - 6, 4); c.fill(); c.fillStyle = P.light ? "#fff" : "#111"; c.textAlign = "center"; c.fillText(hm(t), m.x, PH + AXH / 2); }
    legend();
    panelPaint();
  }
  function rrect(c, x, y, w, h, r){ c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function tag(c, x, y, txt, bg, fg){ if (y < -8 || y > PH + 8) return; c.font = "600 11px Inter,system-ui,sans-serif"; const w = AXW - 4; c.fillStyle = bg; rrect(c, x + 2, y - 9, w, 18, 4); c.fill(); c.fillStyle = fg; c.textAlign = "left"; c.textBaseline = "middle"; c.fillText(txt, x + 7, y); }
  function label(c, x, y, txt, bg, fg){ c.font = "600 11.5px Inter,system-ui,sans-serif"; const w = c.measureText(txt).width + 14; c.fillStyle = bg; rrect(c, x - w / 2, y - 10, w, 20, 6); c.fill(); c.fillStyle = fg; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(txt, x, y + .5); }

  function drawObj(c, P, d){
    const sel = S.sel === d, col = d.col || P.draw; c.lineWidth = sel ? 2 : 1.5; c.strokeStyle = col; c.fillStyle = col;
    if (d.k === "h"){ const y = Math.round(yOf(d.p)) + .5; c.beginPath(); c.moveTo(0, y); c.lineTo(PW, y); c.stroke(); c.font = "600 10.5px Inter,system-ui,sans-serif"; c.textAlign = "right"; c.textBaseline = "bottom"; c.fillText(num(d.p, 2), PW - 6, y - 3); if (sel) hdl(c, PW / 2, y, P); return; }
    if (d.k === "line" || d.k === "ray"){ const x1 = xOf(idxT(d.a.t)), y1 = yOf(d.a.p), x2 = xOf(idxT(d.b.t)), y2 = yOf(d.b.p); c.beginPath(); c.moveTo(x1, y1); if (d.k === "ray" && x2 !== x1){ const k = (y2 - y1) / (x2 - x1), xe = x2 > x1 ? PW : 0; c.lineTo(xe, y1 + k * (xe - x1)); } else c.lineTo(x2, y2); c.stroke(); if (sel){ hdl(c, x1, y1, P); hdl(c, x2, y2, P); } return; }
    if (d.k === "rect"){ const x1 = xOf(idxT(d.a.t)), y1 = yOf(d.a.p), x2 = xOf(idxT(d.b.t)), y2 = yOf(d.b.p); c.globalAlpha = .13; c.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); c.globalAlpha = 1; c.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); if (sel){ hdl(c, x1, y1, P); hdl(c, x2, y2, P); } return; }
    if (d.k === "fib"){ const x1 = xOf(idxT(d.a.t)), x2 = xOf(idxT(d.b.t)), xl = Math.min(x1, x2), xr = Math.max(x1, x2) + 60, lv = [[0, "0"], [.5, "0.5"], [.62, "0.62"], [.705, "0.705"], [.79, "0.79"], [1, "1"]];
      c.font = "600 10px Inter,system-ui,sans-serif"; c.textBaseline = "bottom"; c.textAlign = "left";
      const pAt = f => d.b.p + (d.a.p - d.b.p) * f; c.globalAlpha = .1; c.fillRect(xl, yOf(pAt(.62)), xr - xl, yOf(pAt(.79)) - yOf(pAt(.62))); c.globalAlpha = 1;
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
  function cycOf(t){ for (let k = 0; k < 6; k++) if (t >= CYC[k] && t < CYC[k + 1]) return k; return -1; }
  function cycRange(k, upto){ let hi = -Infinity, lo = Infinity, any = false; for (let i = 0; i < upto; i++){ const b = S.B[i]; if (cycOf(b.t) === k){ hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); any = true; } } return any ? {hi: hi, lo: lo} : null; }
  function cycPaint(c, P){
    CYC.forEach(t => { const x = Math.round(xOf(idxT(t))) + .5; if (x < 0 || x > PW) return; c.strokeStyle = P.acc; c.globalAlpha = .35; c.setLineDash([2, 4]); c.beginPath(); c.moveTo(x, 0); c.lineTo(x, PH); c.stroke(); c.setLineDash([]); c.globalAlpha = 1; });
    const lb = last(); if (!lb) return; const k = cycOf(lb.t); if (k < 1) return; const pv = cycRange(k - 1, S.pos); if (!pv) return;
    const xs = Math.max(0, xOf(idxT(CYC[k - 1]))); c.font = "600 10px Inter,system-ui,sans-serif"; c.textAlign = "left"; c.textBaseline = "bottom";
    [[pv.hi, "PCH"], [pv.lo, "PCL"]].forEach(l => { const y = Math.round(yOf(l[0])) + .5; c.strokeStyle = "#c58aff"; c.fillStyle = "#c58aff"; c.setLineDash([5, 4]); c.beginPath(); c.moveTo(xs, y); c.lineTo(PW, y); c.stroke(); c.setLineDash([]); c.fillText(l[1], xs + 4, y - 2); });
  }
  function cycQuiz(k){
    const pv = cycRange(k - 1, S.pos), cur = cycRange(k, S.pos); if (!pv || !cur || !ui) return false;
    let iH = -1, iL = -1, a = -1, b = -1; for (let i = 0; i < S.pos; i++){ const x = S.B[i]; if (cycOf(x.t) !== k) continue; if (a < 0) a = i; b = i; if (iH < 0 && x.h > pv.hi) iH = i; if (iL < 0 && x.l < pv.lo) iL = i; }
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
    const rec = {id: d.id, day: S.day, sym: inst().n, demo: S.demo || "", dir: d.dir, e: d.e, sl: d.sl0, tp: d.tp, ex: px, t1: d.t1, tx: t, q: d.q, r: d.r, usd: d.usd, why: why, ts: new Date().toISOString(), tf: S.tf};
    hist.push(rec); saveHist();
    try { const j = API().jr(); j.paper = j.paper || []; j.paper.push({ts: rec.ts, r: rec.r, setup: "Replay", usd: rec.usd}); API().store(); API().touchDay(); } catch(e){}
    promo(); toast((d.r >= 0 ? "✓ " : "✕ ") + (why === "tp" ? T("Cíl zasažen", "Target hit") : why === "sl" ? T("Stop zasažen", "Stop hit") : T("Pozice zavřena", "Position closed")) + " · " + rr(d.r) + " · " + usd(d.usd));
    statsPaint(); posList();
  }
  function step1(){
    if (S.pos >= S.B.length){ stop(); return false; }
    const prevC = last() ? cycOf(last().t) : -1, b = S.B[S.pos]; S.pos++;
    S.draws.forEach(d => { if (d.k === "pos") fillOrTrigger(d, b); });
    S.draws.forEach(d => { if (d.k === "pos" && d.st === "draft" && d.follow){ const dp = b.c - d.e, dt = Math.floor(b.t / S.tf) * S.tf - d.t1; d.e = b.c; d.sl = rt(d.sl + dp); d.tp = rt(d.tp + dp); if (dt > 0){ d.t1 += dt; d.t2 += dt; } } });
    if (set.cyc && prevC >= 1 && cycOf(b.t) !== prevC && cycQuiz(prevC)){ stop(); return false; }
    return true;
  }
  function stepTF(n){ for (let k = 0; k < n; k++){ const lb = last(); if (!lb){ step1(); continue; } const g = Math.floor(lb.t / S.tf); while (S.pos < S.B.length && Math.floor(S.B[S.pos].t / S.tf) === g){ if (!step1()) return after(); } if (!step1()) return after(); } after(); }
  let sessT = 0;
  function after(){ const now = Date.now(); if (now - sessT > 800){ sessT = now; saveSess(); } posList(); ctlPaint(); req(); if (S.pos >= S.B.length && !S.ended){ S.ended = true; toast(T("Konec dne. Otevřené pozice zavírám za poslední cenu.", "End of day. Closing open positions at the last price.")); S.draws.forEach(d => { if (d.k === "pos" && d.st === "open") close(d, last().c, last().t, "eod"); if (d.k === "pos" && d.st === "pending") d.st = "cancel"; }); S.draws = S.draws.filter(d => d.st !== "cancel"); req(); } }
  function back(){
    if (S.pos <= 2) return; const b = S.B[S.pos - 1];
    if (S.draws.some(d => d.k === "pos" && (d.st === "open" || ["win", "loss", "be", "closed"].indexOf(d.st) >= 0) && (d.t1 >= b.t || (d.tx != null && d.tx >= b.t)))){ toast(T("Zpátky před vstup nebo výstup obchodu to nejde.", "You can't rewind past a trade entry or exit.")); return; }
    S.pos--; S.ended = false; after();
  }
  function play(){ if (S.playing){ stop(); return; } if (S.pos >= S.B.length) return; S.playing = true; ctlPaint(); const ms = Math.max(16, 1000 / (+set.speed || 1)); S.timer = setInterval(() => { const ok = step1(); after(); if (!ok) stop(); }, ms); }
  function stop(){ if (S.timer){ clearInterval(S.timer); S.timer = null; } if (S.playing){ S.playing = false; ctlPaint(); } }
  function jump(t){
    stop(); const target = S.B.findIndex(b => b.t >= t); const want = target < 0 ? S.B.length : target + 1;
    if (want >= S.pos){ while (S.pos < want){ if (!step1()) break; } after(); return; }
    const first = S.B[want - 1].t; if (S.draws.some(d => d.k === "pos" && d.st && d.st !== "plan" && d.st !== "draft" && (d.t1 >= first || (d.tx != null && d.tx >= first)))){ toast(T("Zpátky před obchod to nejde. Vyber jiný den.", "Can't rewind before a trade. Pick another day.")); return; }
    S.pos = Math.max(2, want); S.ended = false; after();
  }
  const saveSess = () => { if (!S.demo && S.day) LS("tape-rp-sess", {day: S.day, pos: S.pos, tf: S.tf}); };

  function loadDay(d, startPos){
    stop(); S.day = d.day; S.demo = d.demo || ""; S.sym = d.demo || set.inst;
    S.B = d.bars.map(x => { const t = +String(x[0]).slice(11, 13) * 60 + +String(x[0]).slice(14, 16) + (d.demo ? 0 : (+set.tz || 0)); return {t: t, o: x[1], h: x[2], l: x[3], c: x[4]}; }).sort((a, b) => a.t - b.t);
    S.draws = (S.demo ? [] : (drawStore[S.day] || [])).map(x => Object.assign({}, x, {id: uid++}));
    hist.filter(h => h.day === S.day && !h.demo && !S.demo).forEach(h => S.draws.push({k: "pos", id: uid++, dir: h.dir, e: h.e, sl: h.sl, sl0: h.sl, tp: h.tp, t1: h.t1, t2: Math.max(h.tx, h.t1 + 20), q: h.q, ex: h.ex, tx: h.tx, r: h.r, usd: h.usd, st: h.r > .02 ? "win" : h.r < -.02 ? "loss" : "be"}));
    const i9 = S.B.findIndex(b => b.t >= 540); S.pos = clamp(startPos || (i9 > 30 ? i9 : Math.floor(S.B.length * .3)), 2, S.B.length);
    if (startPos && !S.demo && hist.some(h => h.day === S.day && !h.demo)){ const lx = Math.max.apply(null, hist.filter(h => h.day === S.day && !h.demo).map(h => h.tx)); const k = S.B.findIndex(b => b.t > lx); if (k > S.pos) S.pos = k; }
    S.sel = null; S.yMan = null; S.follow = true; S.off = 14; S.bw = window.innerWidth < 700 ? 6 : 9; S.ended = false; aggC = null; if (ui && ui.quiz) ui.quiz.hidden = true;
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
        const top = Math.min(g.ys, g.yt), bot = Math.max(g.ys, g.yt); if (x >= g.x1 && x <= g.x2 && y >= top && y <= bot) return {d: d, h: editable && (d.st === "open") ? "sel" : editable ? "move" : "sel"};
        if (editable && Math.abs(y - g.ys) < 5 && x >= g.x1 - 4 && x <= g.x2) return {d: d, h: "sl"}; if (editable && Math.abs(y - g.yt) < 5 && x >= g.x1 - 4 && x <= g.x2) return {d: d, h: "tp"};
        continue; }
      if (d.k === "h"){ if (Math.abs(y - yOf(d.p)) < 6) return {d: d, h: "move"}; continue; }
      const x1 = xOf(idxT(d.a.t)), y1 = yOf(d.a.p), x2 = xOf(idxT(d.b.t)), y2 = yOf(d.b.p);
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
  function newPos(dir, t, p, st){
    const d0 = Math.max(rt(atr(14) * 1.5), tick() * 4), d = {k: "pos", id: uid++, dir: dir, t1: t, t2: t + 30 * S.tf, e: rt(p), sl: rt(p - dir * d0), tp: rt(p + dir * d0 * 2), st: st};
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
      if (tool === "h"){ const d = {k: "h", id: uid++, p: pt.p}; S.draws.push(d); S.sel = d; setTool("cur"); saveDraw(); req(); return; }
      if (tool === "long" || tool === "short"){ const d = newPos(tool === "long" ? 1 : -1, pt.t, pt.p, "plan"); S.draws.push(d); S.sel = d; setTool("cur"); saveDraw(); req(); return; }
      S.creating = {d: {k: tool, id: uid++, a: pt, b: Object.assign({}, pt)}, x: x, y: y, stage: 1}; req(); return;
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
    const d = D.d, o = D.orig, p = rt(pOf(y)), dt = (iOf(x) - iOf(D.x)) * S.tf, dp = pOf(y) - pOf(D.y), lb = last();
    if (d.k === "pos"){
      if (D.h === "sl"){ let v = p; if (d.st === "open" && lb) v = d.dir > 0 ? Math.min(v, lb.c - tick()) : Math.max(v, lb.c + tick()); else v = d.dir > 0 ? Math.min(v, d.e - tick()) : Math.max(v, d.e + tick()); d.sl = rt(v); }
      else if (D.h === "tp"){ let v = p; if (d.st === "open" && lb) v = d.dir > 0 ? Math.max(v, lb.c + tick()) : Math.min(v, lb.c - tick()); else v = d.dir > 0 ? Math.max(v, d.e + tick()) : Math.min(v, d.e - tick()); d.tp = rt(v); }
      else if (D.h === "e"){ const ne = rt(clamp(p, Math.min(d.sl, d.tp) + tick(), Math.max(d.sl, d.tp) - tick())); if (d.st === "draft" && lb){ if (d.ot === "mkt" && Math.abs(ne - lb.c) >= tick()){ d.ot = d.dir * (ne - lb.c) < 0 ? "lim" : "stp"; set.ot = d.ot; saveSet(); if (ui) ui.pOT.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.ot === d.ot)); } } d.e = ne; d.follow = d.ot === "mkt" && Math.abs(ne - (lb ? lb.c : ne)) < tick(); if (d.st === "draft" && d.ot === "mkt") d.e = lb.c; }
      else if (D.h === "w"){ d.t2 = Math.max(d.t1 + S.tf * 3, o.t2 + dt); }
      else if (D.h === "move" && (!d.st || d.st === "plan")){ d.t1 = o.t1 + dt; d.t2 = o.t2 + dt; d.e = rt(o.e + dp); d.sl = rt(o.sl + dp); d.tp = rt(o.tp + dp); }
      if (d.st === "open" || d.st === "pending" || d.st === "draft") posList();
      return; }
    if (d.k === "h"){ d.p = rt(o.p + dp); return; }
    if (D.h === "a"){ d.a = ptAt(x, y, true); return; } if (D.h === "b"){ d.b = ptAt(x, y, true); return; }
    d.a = {t: o.a.t + dt, p: rt(o.a.p + dp)}; d.b = {t: o.b.t + dt, p: rt(o.b.p + dp)};
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
    else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey){ const m = {t: "line", h: "h", r: "rect", f: "fib", l: "long", s: "short", v: "cur"}[ev.key.toLowerCase()]; if (m) setTool(m); }
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
    if (b){ const dc = I.tick < 1 && I.tick >= .25 ? 2 : 2, ch = b.c - b.o; ui.ohlc.innerHTML = ""; [["O", b.o], ["H", b.h], ["L", b.l], ["C", b.c]].forEach(x => { const s = mk("span", null, x[0] + " "); const v = mk("b", ch >= 0 ? "up" : "dn", num(x[1], dc)); s.appendChild(v); ui.ohlc.appendChild(s); }); ui.ohlc.appendChild(mk("span", ch >= 0 ? "up" : "dn", (ch >= 0 ? "+" : "") + num(ch, 2))); ui.clock.textContent = hm(last() ? last().t : 0) + T(" NY", " NY"); }
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
    if (!S.days.length){ const o = mk("option", null, S.demo ? T("Ukázkový den", "Demo day") : T("Žádná data", "No data")); sel.appendChild(o); sel.disabled = true; }
    else { sel.disabled = false; S.days.forEach(d => { const o = mk("option", null, d.day); o.value = d.day; if (d.day === S.day) o.selected = true; sel.appendChild(o); }); if (S.demo){ const o = mk("option", null, T("Ukázkový den", "Demo day")); o.value = ""; o.selected = true; sel.insertBefore(o, sel.firstChild); } }
    ui.libInfo.textContent = S.days.length ? T("V zařízení ", "Stored on this device: ") + S.days.length + T(" dní · ", " days · ") + S.days[0].day + " – " + S.days[S.days.length - 1].day : T("Data zůstávají jen v tomto zařízení.", "Data stays on this device only.");
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
    const tz = mk("select"); [["0", T("Časy v souboru: New York", "File times: New York")], ["-300", T("UTC, zimní čas", "UTC, winter time")], ["-240", T("UTC, letní čas", "UTC, summer time")], ["-360", T("Praha", "Prague")]].forEach(x => { const o = mk("option", null, x[1]); o.value = x[0]; if (+x[0] === +set.tz) o.selected = true; tz.appendChild(o); }); tz.addEventListener("change", () => { set.tz = +tz.value; saveSet(); const d = S.days.find(x => x.day === S.day); if (d) loadDay(d, S.pos); }); row(T("Časové pásmo CSV", "CSV time zone"), tz);
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
    daySel.addEventListener("change", () => { const d = S.days.find(x => x.day === daySel.value); if (d) loadDay(d); });
    const dnav = mk("div", "rp-grp"); dnav.appendChild(ibtn("prev", T("Předchozí den", "Previous day"), () => { const i = S.days.findIndex(x => x.day === S.day); if (i > 0) loadDay(S.days[i - 1]); }));
    dnav.appendChild(daySel); dnav.appendChild(ibtn("next", T("Další den", "Next day"), () => { const i = S.days.findIndex(x => x.day === S.day); if (i >= 0 && i < S.days.length - 1) loadDay(S.days[i + 1]); else if (S.days.length && i < 0) loadDay(S.days[0]); }));
    dnav.appendChild(btn("chip rp-rand", T("Náhodný den", "Random day"), () => { if (S.days.length) loadDay(S.days[Math.floor(Math.random() * S.days.length)]); else runDemo(); }));
    const tfs = mk("div", "rp-seg rp-tfs"); TFS.forEach(x => { const b = btn("", x[1], () => { S.tf = x[0]; set.tf = x[0]; saveSet(); aggC = null; S.yMan = null; S.follow = true; ctlPaint(); legend(); req(); saveSess(); }); b.dataset.tf = x[0]; tfs.appendChild(b); });
    const pl = mk("div", "rp-grp"), bk = ibtn("prev", T("Zpět o svíčku (←)", "Back one candle (←)"), () => { stop(); back(); }), playB = ibtn("play", "", () => play(), "rp-play"), nx = ibtn("next", T("Další svíčka (→)", "Next candle (→)"), () => { stop(); stepTF(1); });
    const sp = mk("select", "rp-sp"); sp.setAttribute("aria-label", T("Rychlost", "Speed")); SPEEDS.forEach(x => { const o = mk("option", null, x[1]); o.value = x[0]; if (+x[0] === +set.speed) o.selected = true; sp.appendChild(o); }); sp.addEventListener("change", () => { set.speed = +sp.value; saveSet(); if (S.playing){ stop(); play(); } });
    const jt = mk("input", "rp-jt"); jt.type = "time"; jt.step = 60; jt.setAttribute("aria-label", T("Skočit na čas", "Jump to time")); jt.title = T("Skočit na čas (newyorský)", "Jump to time (New York)"); jt.addEventListener("change", () => { const m = jt.value.match(/(\d+):(\d+)/); if (m) jump(+m[1] * 60 + +m[2]); });
    pl.appendChild(bk); pl.appendChild(playB); pl.appendChild(nx); pl.appendChild(sp); pl.appendChild(jt);
    const right = mk("div", "rp-grp"); right.appendChild(ibtn("gear", T("Nastavení rizika a replaye", "Risk and replay settings"), () => settingsPop())); right.appendChild(ibtn("full", T("Celá obrazovka", "Full screen"), () => fullscreen()));
    bar.appendChild(dnav); bar.appendChild(tfs); bar.appendChild(pl); bar.appendChild(right);
    // chart area
    const area = mk("div", "rp-area"), tools = mk("div", "rp-tools"), box = mk("div", "rp-box"), cv = mk("canvas"); cv.setAttribute("aria-label", T("Graf replaye", "Replay chart")); cv.setAttribute("role", "img");
    [["cur", T("Kurzor (V)", "Cursor (V)")], ["line", T("Trendová čára (T)", "Trend line (T)")], ["ray", T("Paprsek", "Ray")], ["h", T("Horizontální čára (H)", "Horizontal line (H)")], ["rect", T("Obdélník (R)", "Rectangle (R)")], ["fib", T("Fibonacci s OTE (F)", "Fibonacci with OTE (F)")], ["long", T("Long pozice (L)", "Long position (L)")], ["short", T("Short pozice (S)", "Short position (S)")]].forEach(x => { const b = ibtn(x[0], x[1], () => setTool(x[0])); b.dataset.t = x[0]; tools.appendChild(b); });
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
    const empty = mk("div", "rp-empty"); box.appendChild(empty);
    area.appendChild(tools); area.appendChild(box);
    const prog = mk("div", "rp-prog"), pi = mk("i"); prog.appendChild(pi);
    const pos = mk("div", "rp-pos"); pos.hidden = true; const quiz = mk("div", "box exam rp-quiz"); quiz.hidden = true;
    // library bar
    const lib = mk("div", "rp-lib"), up = mk("label", "chip rp-up"), fi = mk("input"); fi.type = "file"; fi.accept = ".csv,.txt,text/csv"; fi.multiple = true; fi.hidden = true; up.appendChild(mk("span", null, T("Nahrát CSV (1m svíčky)", "Upload CSV (1m candles)"))); up.appendChild(fi);
    fi.addEventListener("change", () => upload(fi.files).then(() => { fi.value = ""; }));
    const libInfo = mk("span", "small muted"); lib.appendChild(up); lib.appendChild(btn("chip", T("Ukázka zdarma", "Free demo"), () => runDemo())); lib.appendChild(libInfo);
    const wipe = btn("chip rp-wipe", T("Smazat data", "Delete data"), null); let arm = false; wipe.addEventListener("click", () => { if (!arm){ arm = true; wipe.textContent = T("Opravdu smazat?", "Really delete?"); setTimeout(() => { arm = false; wipe.textContent = T("Smazat data", "Delete data"); }, 3000); return; } libWipe().then(() => { S.days = []; S.B = []; S.day = ""; LS("tape-rp-sess", null); libPaint(); emptyPaint(); req(); toast(T("Data jsou smazaná.", "Data deleted.")); }); }); lib.appendChild(wipe);
    // stats
    const stH = mk("div", "rp-sth"), stT = mk("h3", null, T("Výsledky replaye", "Replay results")), scope = mk("div", "rp-seg"); stH.appendChild(stT); stH.appendChild(scope);
    const stats = mk("div", "rp-stats");
    wrap.appendChild(head); wrap.appendChild(bar); wrap.appendChild(prog); wrap.appendChild(area); wrap.appendChild(pos); wrap.appendChild(quiz); wrap.appendChild(lib); wrap.appendChild(stH); wrap.appendChild(stats);
    ui = {wrap: wrap, ttl: t1, ohlc: ohlc, clock: clock, daySel: daySel, tfs: tfs, play: playB, jt: jt, tools: tools, box: box, cv: cv, panel: panel, pSell: pSell, pBuy: pBuy, pRisk: pRisk, pOT: pOT, pSize: pSize, pQty: pQty, pQtyI: pQtyI, pQtyU: pQtyU, pConf: pConf, pOk: pOk, setp: setp, empty: empty, prog: pi, pos: pos, quiz: quiz, libInfo: libInfo, stats: stats, scope: "all"};
    [["all", T("Vše", "All")], ["day", T("Tento den", "This day")]].forEach(x => { const b = btn(x[0] === "all" ? "on" : "", x[1], () => { ui.scope = x[0]; scope.querySelectorAll("button").forEach(z => z.classList.toggle("on", z === b)); statsPaint(); }); scope.appendChild(b); });
    panelDrag(grip); setTool("cur");
    cv.addEventListener("pointerdown", onDown); cv.addEventListener("pointermove", onMove); cv.addEventListener("pointerup", onUp); cv.addEventListener("pointercancel", onUp); cv.addEventListener("pointerleave", () => { S.mouse = null; req(); }); cv.addEventListener("wheel", onWheel, {passive: false}); cv.addEventListener("dblclick", onDbl);
    cv.addEventListener("contextmenu", e => { e.preventDefault(); });
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
    toast(T("Načteno dní: ", "Days loaded: ") + got.length); loadDay(got[got.length - 1]); emptyPaint();
  }
  async function runDemo(){
    toast(T("Načítám ukázkový den…", "Loading a demo day…")); const d = await demoDay(); loadDay(d); emptyPaint();
    toast(d.real ? T("Ukázka: skutečný den BTCUSDT z veřejných dat Binance, 7:00–16:00 newyorského času.", "Demo: a real BTCUSDT day from Binance public data, 7:00–16:00 New York time.") : T("Ukázka: vymyšlená data, jen na vyzkoušení ovládání.", "Demo: invented data, just to try the controls."));
  }

  // ---------- mount ----------
  function mount(){
    const root = document.getElementById("rp-studio"); if (!root || !API().jr) return false; if (root.dataset.on) return true; root.dataset.on = "1";
    build(root);
    libLoad().then(ds => { S.days = (ds || []).sort((a, b) => a.day.localeCompare(b.day)); libPaint(); const ss = LS("tape-rp-sess"), d = ss && S.days.find(x => x.day === ss.day); if (d){ if (ss.tf) S.tf = ss.tf; loadDay(d, ss.pos); } else if (S.days.length) loadDay(S.days[S.days.length - 1]); emptyPaint(); req(); }).catch(() => { emptyPaint(); req(); });
    return true;
  }
  window.TapeReplay = {mount: mount, summary: () => { const ss = LS("tape-rp-sess"), n = hist.length, tr = hist.reduce((a, h) => a + h.r, 0), w = hist.filter(h => h.r > .02).length; return {sess: ss, n: n, r: tr, win: n ? Math.round(100 * w / n) : null, usd: hist.reduce((a, h) => a + h.usd, 0)}; }};
  if (!mount()){ let k = 0; const iv = setInterval(() => { if (mount() || ++k > 100) clearInterval(iv); }, 100); }
})();
