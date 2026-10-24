// Reading the export written by tools/ha_export_snippet.js, guessing which
// entity plays which role, and laying everything onto one 5-minute grid.

import { ZONE_IDS, AC_ZONES, WINDOW_ZONES, modeCode, hourWave } from './apartment.js';
import { irradiance } from './solar.js';

const MIN = 60e3;
const ts = v => typeof v === 'number' ? v : Date.parse(v);
const fnum = v => { const x = typeof v === 'number' ? v : parseFloat(v); return isFinite(x) ? x : NaN; };

export function parseExport(json) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  if (!j || !j.meta || !(j.stats_5min || j.history)) throw new Error('This is not an apartment export from ha_export_snippet.js.');
  const out = { location: j.location || null, meta: j.meta, exported: j.exported, num: {}, kind: {}, climate: {}, binary: {}, person: {}, weather: {} };
  for (const id in (j.stats_5min || {})) {
    const rows = j.stats_5min[id].map(([t, v]) => ({ t: ts(t), v: fnum(v) })).filter(p => isFinite(p.t) && isFinite(p.v));
    if (rows.length > 1) { out.num[id] = rows.sort((a, b) => a.t - b.t); out.kind[id] = 'mean5'; }
  }
  for (const id in (j.history || {})) {
    const rows = j.history[id];
    if (id.startsWith('climate.')) {
      out.climate[id] = rows.map(([t, s, set, cur, action]) => ({ t: ts(t), mode: modeCode(s), state: s, set: set === null ? NaN : fnum(set), cur: cur === null ? NaN : fnum(cur), action }))
        .filter(r => isFinite(r.t)).sort((a, b) => a.t - b.t);
    } else if (id.startsWith('weather.')) {
      out.weather[id] = rows.map(([t, s, temp, cloud]) => ({ t: ts(t), temp: temp === null ? NaN : fnum(temp), cloud: cloud === null ? NaN : fnum(cloud) / 100 }))
        .filter(r => isFinite(r.t)).sort((a, b) => a.t - b.t);
    } else if (id.startsWith('binary_sensor.')) {
      out.binary[id] = rows.map(([t, s]) => ({ t: ts(t), on: s === 'on' ? 1 : s === 'off' ? 0 : NaN })).filter(r => isFinite(r.t)).sort((a, b) => a.t - b.t);
    } else if (id.startsWith('person.')) {
      out.person[id] = rows.map(([t, s]) => ({ t: ts(t), home: s === 'home' ? 1 : 0 })).filter(r => isFinite(r.t)).sort((a, b) => a.t - b.t);
    } else if (!out.num[id]) {
      const pts = rows.map(([t, v]) => ({ t: ts(t), v: fnum(v) })).filter(p => isFinite(p.t)).sort((a, b) => a.t - b.t);
      if (pts.filter(p => isFinite(p.v)).length > 1) { out.num[id] = pts; out.kind[id] = 'state'; }
    }
  }
  return out;
}

// ---- which entity is what ----------------------------------------------------
const norm = s => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
const ZONE_RE = {
  office: /buero|office|arbeitszimmer|study/,
  bedroom: /schlaf|bedroom|sleep/,
  living: /wohn|living|lounge|kueche|kitchen/,
  bath: /(^|[^a-z])bad([^a-z]|$)|badezimmer|bath|dusche|shower/,
  hall: /flur|diele|hallway|(^|[^a-z])hall([^a-z]|$)|korridor|corridor/,
};
const OUTDOOR_RE = /aussen|outdoor|outside|exterior|balkon|garten|garden|terrasse/;
const DEVICEISH_RE = /klima|aircon|(^|[^a-z])ac([^a-z]|$)|split|daikin|mitsubishi|midea|gree|toshiba|panasonic|fujitsu|lg_|samsung|inside|room_temp|innengeraet|indoor_unit/;

function text(parsed, id) { const m = parsed.meta[id] || {}; return norm(id + ' ' + (m.name || '')); }
function areaText(parsed, id) { return norm((parsed.meta[id] || {}).area || ''); }
function zoneOf(parsed, id) {
  const a = areaText(parsed, id), t = text(parsed, id);
  for (const z of ZONE_IDS) if (a && ZONE_RE[z].test(a)) return z;
  for (const z of ZONE_IDS) if (ZONE_RE[z].test(t)) return z;
  return null;
}
const unitOf = (parsed, id) => ((parsed.meta[id] || {}).unit || '');
const dcOf = (parsed, id) => ((parsed.meta[id] || {}).device_class || '');
const meanOf = s => { let a = 0, n = 0; for (const p of s) if (isFinite(p.v)) { a += p.v; n++; } return n ? a / n : NaN; };

export function guessMapping(parsed) {
  const ids = Object.keys(parsed.num);
  const climateDevices = new Set(Object.keys(parsed.climate).map(c => (parsed.meta[c] || {}).device).filter(Boolean));
  const temps = ids.filter(id => dcOf(parsed, id) === 'temperature' || /°c|°f/i.test(unitOf(parsed, id)));
  const power = ids.filter(id => dcOf(parsed, id) === 'power' || /^k?w$/i.test(unitOf(parsed, id)));
  const map = { temp: {}, climate: {}, window: {}, outdoor: '', heater: '', phase: '', phasesOther: [], car: '', price: '', weather: '' };

  // room thermometers: prefer stand-alone sensors over the units' own readings
  for (const z of ZONE_IDS) {
    const cands = temps.filter(id => zoneOf(parsed, id) === z && !OUTDOOR_RE.test(text(parsed, id)));
    cands.sort((a, b) => score(b) - score(a));
    map.temp[z] = cands[0] || '';
  }
  function score(id) {
    let s = 0;
    if (areaText(parsed, id)) s += 1;
    if (DEVICEISH_RE.test(text(parsed, id))) s -= 2;
    if (climateDevices.has((parsed.meta[id] || {}).device)) s -= 3;
    if (parsed.kind[id] === 'mean5') s += 1;
    return s;
  }
  const outs = temps.filter(id => OUTDOOR_RE.test(text(parsed, id) + ' ' + areaText(parsed, id)));
  outs.sort((a, b) => score(b) - score(a));
  map.outdoor = outs[0] || '';

  for (const z of AC_ZONES) map.climate[z] = Object.keys(parsed.climate).find(c => zoneOf(parsed, c) === z) || '';
  for (const z of WINDOW_ZONES) map.window[z] = Object.keys(parsed.binary).filter(b => zoneOf(parsed, b) === z
    && (/window|door|opening|garage_door/.test(dcOf(parsed, b)) || /fenster|window|balkon|terrasse|tuer|door/.test(text(parsed, b))));

  const phaseLike = power.filter(id => /(^|[^a-z0-9])l[123]([^0-9]|$)|phase|phasen/.test(text(parsed, id)));
  map.phasesOther = phaseLike.slice();
  const heaters = power.filter(id => !phaseLike.includes(id) && (zoneOf(parsed, id) === 'bath' || /heiz|heater|luefter|radiator/.test(text(parsed, id))));
  heaters.sort((a, b) => (zoneOf(parsed, b) === 'bath') - (zoneOf(parsed, a) === 'bath') || meanOf(parsed.num[b]) - meanOf(parsed.num[a]));
  map.heater = heaters[0] || '';
  map.car = power.find(id => !phaseLike.includes(id) && /wallbox|(^|[^a-z])car([^a-z]|$)|(^|[^a-z])ev([^a-z]|$)|auto|lade|charg/.test(text(parsed, id))) || '';
  const prices = ids.filter(id => /\/\s*kwh/i.test(unitOf(parsed, id)) && /price|preis|strom|electric|tibber|energy/.test(text(parsed, id))
    && !/next|avg|average|⌀|trend|level|rating|outlook|trajectory|min|max|rank|lowest|highest|leading|trailing|tomorrow|yesterday|today|hour/.test(text(parsed, id)));
  map.price = prices[0] || ids.find(id => /\/\s*kwh/i.test(unitOf(parsed, id))) || '';
  map.weather = Object.keys(parsed.weather)[0] || '';
  return map;
}

// The phase that carries the outdoor unit jumps when a unit switches on.
// Each candidate's average jump across all switch-on moments, against its
// own scatter, picks it; plain correlation is the fallback.
export function pickPhase(grid, parsed, map) {
  const events = [];
  for (let k = 3; k < grid.K - 4; k++) if (grid.unitsOn[k] > grid.unitsOn[k - 1]) events.push(k);
  let best = '', bestS = -Infinity, how = 'jump';
  for (const id of map.phasesOther) {
    const p = resample(parsed, id, grid, 1e15);
    let s;
    if (events.length >= 5) {
      const j = [];
      for (const k of events) {
        const before = (p[k - 3] + p[k - 2] + p[k - 1]) / 3, after = (p[k + 1] + p[k + 2] + p[k + 3]) / 3;
        if (isFinite(before) && isFinite(after)) j.push(after - before);
      }
      const m = j.reduce((a2, b2) => a2 + b2, 0) / Math.max(1, j.length);
      const sd = Math.sqrt(j.reduce((a2, b2) => a2 + (b2 - m) ** 2, 0) / Math.max(1, j.length - 1));
      s = j.length >= 5 && sd > 0 ? m / (sd / Math.sqrt(j.length)) : -Infinity;
    } else { s = corr(p, grid.unitsOn); how = 'corr'; }
    if (s > bestS) { bestS = s; best = id; }
  }
  return { id: best, score: bestS, how, events: events.length };
}
function corr(a, b) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i], y = b[i]; if (!isFinite(x) || !isFinite(y)) continue; n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; }
  if (n < 10) return -Infinity;
  const cov = sab / n - sa * sb / n / n, va = saa / n - sa * sa / n / n, vb = sbb / n - sb * sb / n / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -Infinity;
}

// ---- the grid -------------------------------------------------------------------
// Time-weighted mean of a step function over each grid interval. 5-minute
// statistics already are those means and land on the grid directly.
function resample(parsed, id, grid, maxAge = 6 * 3600e3) {
  const out = new Float64Array(grid.K).fill(NaN);
  const s = parsed.num[id];
  if (!s) return out;
  if (parsed.kind[id] === 'mean5' && grid.stepMin === 5) {
    for (const p of s) { const k = Math.round((p.t - grid.t0) / grid.step); if (k >= 0 && k < grid.K && Math.abs(p.t - (grid.t0 + k * grid.step)) < MIN) out[k] = p.v; }
    return out;
  }
  return stepMeans(s, grid, p => p.v, maxAge);
}
// mean of a step series per interval; values older than maxAge count as missing
function stepMeans(s, grid, get, maxAge) {
  const out = new Float64Array(grid.K).fill(NaN);
  let j0 = -1;
  for (let k = 0; k < grid.K; k++) {
    const a = grid.t0 + k * grid.step, b = a + grid.step;
    while (j0 + 1 < s.length && s[j0 + 1].t <= a) j0++;
    let acc = 0, w = 0, j = j0, t = a;
    while (t < b) {
      const nextT = j + 1 < s.length ? Math.min(b, s[j + 1].t) : b;
      if (j >= 0 && t - s[j].t <= maxAge) {
        const v = get(s[j]);
        if (isFinite(v)) { acc += v * (nextT - t); w += nextT - t; }
      }
      t = nextT;
      if (j + 1 < s.length && s[j + 1].t <= t) j++;
    }
    if (w > grid.step * 0.5) out[k] = acc / w;
  }
  return out;
}
function stepAtGrid(s, grid, get, maxAge) {
  const out = new Array(grid.K).fill(null);
  let i = -1;
  for (let k = 0; k < grid.K; k++) {
    const t = grid.t0 + k * grid.step + grid.step / 2;
    while (i + 1 < s.length && s[i + 1].t <= t) i++;
    if (i >= 0 && t - s[i].t <= maxAge) out[k] = get(s[i]);
  }
  return out;
}
function fillGaps(a, maxSteps) {
  let last = -1;
  for (let k = 0; k < a.length; k++) {
    if (!isFinite(a[k])) continue;
    if (last >= 0 && k - last > 1 && k - last <= maxSteps + 1)
      for (let j = last + 1; j < k; j++) a[j] = a[last] + (a[k] - a[last]) * (j - last) / (k - last);
    last = k;
  }
  return a;
}
const toKW = (parsed, id, a) => { const u = unitOf(parsed, id).toLowerCase(); if (u !== 'kw') for (let k = 0; k < a.length; k++) a[k] /= 1000; return a; };

export function buildGrid(parsed, map, opts = {}) {
  const stepMin = opts.stepMin || 5, step = stepMin * MIN;
  const zoneSeries = ZONE_IDS.map(z => parsed.num[map.temp[z]]).filter(Boolean);
  if (!zoneSeries.length) throw new Error('No room thermometer is assigned.');
  let a = Math.max(...zoneSeries.map(s => s[0].t)), b = Math.min(...zoneSeries.map(s => s[s.length - 1].t));
  if (opts.start) a = Math.max(a, opts.start);
  if (opts.end) b = Math.min(b, opts.end);
  const t0 = Math.ceil(a / step) * step, K = Math.max(0, Math.floor((b - t0) / step));
  if (K < 288) throw new Error('Less than a day of overlapping room temperatures.');
  const grid = { t0, step, stepMin, stepH: stepMin / 60, K, t: Float64Array.from({ length: K }, (_, k) => t0 + k * step) };

  grid.T = ZONE_IDS.map(z => fillGaps(resample(parsed, map.temp[z], grid), 6));
  let tout = map.outdoor ? fillGaps(resample(parsed, map.outdoor, grid), 12) : new Float64Array(K).fill(NaN);
  const wx = map.weather ? parsed.weather[map.weather] : null;
  if (wx) {
    const wt = stepMeans(wx, grid, r => r.temp, 3 * 3600e3);
    for (let k = 0; k < K; k++) if (!isFinite(tout[k])) tout[k] = wt[k];
  }
  grid.tout = fillGaps(tout, 36);
  grid.open = WINDOW_ZONES.map(z => {
    const ids = (map.window[z] || []).filter(id => parsed.binary[id]);
    const acc = new Float64Array(K);
    for (const id of ids) {
      const f = stepMeans(parsed.binary[id], grid, r => r.on, 1e15);
      for (let k = 0; k < K; k++) if (isFinite(f[k])) acc[k] = Math.max(acc[k], f[k]);
    }
    return acc;
  });
  grid.mode = AC_ZONES.map(z => Int8Array.from(stepAtGrid(parsed.climate[map.climate[z]] || [], grid, r => r.mode, 1e15), v => v || 0));
  grid.set = AC_ZONES.map(z => Float64Array.from(stepAtGrid(parsed.climate[map.climate[z]] || [], grid, r => r.set, 1e15), v => v === null ? NaN : v));
  grid.cur = AC_ZONES.map(z => Float64Array.from(stepAtGrid(parsed.climate[map.climate[z]] || [], grid, r => r.cur, 1e15), v => v === null ? NaN : v));
  // a unit in heat mode without a known setpoint cannot be simulated; treat it as off
  for (let a2 = 0; a2 < AC_ZONES.length; a2++) for (let k = 0; k < K; k++) if (grid.mode[a2][k] && !isFinite(grid.set[a2][k])) grid.mode[a2][k] = 0;
  grid.unitsOn = Float64Array.from({ length: K }, (_, k) => grid.mode.reduce((s, m) => s + (m[k] ? 1 : 0), 0));

  grid.heater = map.heater ? toKW(parsed, map.heater, resample(parsed, map.heater, grid, 1e15)) : new Float64Array(K);
  for (let k = 0; k < K; k++) if (!isFinite(grid.heater[k])) grid.heater[k] = 0;
  grid.phaseId = map.phase;
  grid.phase = map.phase ? toKW(parsed, map.phase, resample(parsed, map.phase, grid, 1e15)) : new Float64Array(K).fill(NaN);
  grid.others = map.phasesOther.filter(id => id !== map.phase).map(id => toKW(parsed, id, resample(parsed, id, grid, 1e15)));
  grid.car = map.car ? toKW(parsed, map.car, resample(parsed, map.car, grid, 1e15)) : null;

  const cloud = wx ? stepAtGrid(wx, grid, r => r.cloud, 3 * 3600e3) : new Array(K).fill(null);
  const loc = parsed.location || { lat: 51, lon: 10 };
  grid.sol = { D: new Float64Array(K), E: new Float64Array(K), S: new Float64Array(K), W: new Float64Array(K) };
  for (let k = 0; k < K; k++) {
    const r = irradiance(grid.t[k] + step / 2, loc.lat, loc.lon, cloud[k]);
    grid.sol.D[k] = r.D; grid.sol.E[k] = r.E; grid.sol.S[k] = r.S; grid.sol.W[k] = r.W;
  }
  grid.hc = new Float64Array(K); grid.hs = new Float64Array(K);
  for (let k = 0; k < K; k++) { const [c, s2] = hourWave(grid.t[k] + step / 2); grid.hc[k] = c; grid.hs[k] = s2; }
  grid.price = map.price ? parsed.num[map.price].filter(p => isFinite(p.v)) : [];
  grid.outdoorSeries = Array.from(grid.tout, (v, k) => ({ t: grid.t[k], v })).filter(p => isFinite(p.v));
  grid.valid = Uint8Array.from({ length: K }, (_, k) => grid.T.every(T => isFinite(T[k])) && isFinite(grid.tout[k]) ? 1 : 0);
  grid.map = map;
  return grid;
}

// Merge a guessed mapping with the user's corrections and pick the phase if unset.
export function prepare(parsed, map) {
  const m = JSON.parse(JSON.stringify(map));
  let grid = buildGrid(parsed, m);
  if (!m.phase && m.phasesOther.length) {
    const p = pickPhase(grid, parsed, m);
    if (p.id) { m.phase = p.id; m.phasePick = { score: p.score, how: p.how, events: p.events }; grid = buildGrid(parsed, m); }
  }
  return { map: m, grid };
}
