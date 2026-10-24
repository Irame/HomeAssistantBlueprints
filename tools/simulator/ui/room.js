// One room, one device: replay a day of prices and outdoor temperatures.
import { $, HOUR, MIN, fmt, hhmm, dayStart, store, tile, delta, copyText, readFile } from './util.js';
import { frame, niceTicks, extent, stepPath, linePath, every, strip, stripLabel, legend, quarterMeans, quarterPath, svgEl, hover, tipRow, M } from './charts.js';
import { writeForm, readForm, showMode, yamlFor } from './form.js';
import { ROOM_DEFAULTS, simulateRoom } from '../src/room.js';
import { detectInterval } from '../src/blueprint.js';

// Hourly anchor prices (EUR/kWh incl. fees), stretched into 15-minute
// intervals with the small zig-zag the quarter-hour market shows.
const EXAMPLES = [
  { id: 'ex-autumn', name: 'Example: autumn day, midday solar dip', lo: 2, hi: 10,
    p: [0.27, 0.265, 0.26, 0.26, 0.265, 0.28, 0.31, 0.34, 0.345, 0.32, 0.28, 0.24, 0.21, 0.195, 0.20, 0.23, 0.27, 0.32, 0.37, 0.38, 0.35, 0.32, 0.30, 0.285] },
  { id: 'ex-winter', name: 'Example: winter day, evening peak, cheap night', lo: -5, hi: 1,
    p: [0.29, 0.27, 0.255, 0.245, 0.24, 0.25, 0.29, 0.34, 0.36, 0.345, 0.33, 0.32, 0.31, 0.31, 0.32, 0.34, 0.37, 0.41, 0.42, 0.39, 0.35, 0.33, 0.31, 0.30] },
  { id: 'ex-windy', name: 'Example: windy spring day, slowly falling', lo: 5, hi: 13,
    p: [0.26, 0.255, 0.25, 0.25, 0.25, 0.255, 0.25, 0.24, 0.23, 0.22, 0.21, 0.20, 0.19, 0.185, 0.18, 0.175, 0.19, 0.23, 0.29, 0.31, 0.29, 0.27, 0.26, 0.255] },
  { id: 'ex-summer', name: 'Example: summer heat, cooling day', lo: 20, hi: 33,
    p: [0.27, 0.26, 0.25, 0.25, 0.26, 0.27, 0.29, 0.31, 0.28, 0.23, 0.19, 0.16, 0.14, 0.13, 0.14, 0.17, 0.22, 0.28, 0.33, 0.36, 0.34, 0.31, 0.29, 0.28] },
];
function buildExample(ex) {
  const d0 = dayStart(Date.now()) - 24 * HOUR;
  const price = [], outdoor = [];
  for (let d = 0; d < 2; d++) for (let q = 0; q < 96; q++) {
    const h = q / 4, i = Math.floor(h), f = h - i;
    const a = ex.p[i % 24], b = ex.p[(i + 1) % 24];
    const zig = ((q % 4) - 1.5) * 0.0012 * Math.sign(b - a);
    const drift = d === 1 ? 0.006 * Math.sin(i / 3) : 0;
    price.push({ t: d0 + d * 24 * HOUR + q * 15 * MIN, v: +(a + (b - a) * f + zig + drift).toFixed(4) });
  }
  for (let m = 0; m < 48 * 4; m++) {
    const t = d0 + m * 15 * MIN, h = (m / 4) % 24;
    const ph = Math.cos((h - 15) / 24 * 2 * Math.PI);
    outdoor.push({ t, v: +((ex.lo + ex.hi) / 2 + (ex.hi - ex.lo) / 2 * ph + 0.3 * Math.sin(m / 5)).toFixed(2) });
  }
  return { series: { price, outdoor }, map: { price: 'price', outdoor: 'outdoor', indoor: '' }, days: [d0], label: ex.name, example: true };
}

// ---- parsing a plain history export
function num(s) {
  if (s === undefined || s === null) return NaN;
  s = String(s).trim().replace(/^"|"$/g, '');
  if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  return s === '' ? NaN : Number(s);
}
function time(s) {
  s = String(s).trim().replace(/^"|"$/g, '');
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) { const [h, m] = s.split(':').map(Number); return dayStart(Date.now()) + h * HOUR + m * MIN; }
  const t = Date.parse(s.includes('T') || !/^\d{4}-\d{2}-\d{2} /.test(s) ? s : s.replace(' ', 'T'));
  return isNaN(t) ? null : t;
}
export function parseText(text) {
  text = text.replace(/^﻿/, '').trim();
  if (!text) throw new Error('The file is empty.');
  const out = {};
  const add = (name, t, v) => { if (t === null || !isFinite(v)) return; (out[name] = out[name] || []).push({ t, v }); };
  if (text[0] === '[' || text[0] === '{') {
    let j = JSON.parse(text);
    if (j && j.meta && (j.stats_5min || j.history)) throw new Error('This is an apartment export. Switch to Whole apartment to load it.');
    if (!Array.isArray(j)) j = Object.values(j);
    const flat = j.flat ? j.flat(2) : [].concat.apply([], j);
    for (const s of flat) if (s && s.entity_id) add(s.entity_id, time(s.last_changed || s.last_updated || s.lu || ''), num(s.state));
  } else {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const head = lines[0];
    const delim = (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ';' : (head.includes('\t') ? '\t' : ',');
    const cols = head.split(delim).map(c => c.trim().replace(/^"|"$/g, ''));
    const lc = cols.map(c => c.toLowerCase());
    const ie = lc.indexOf('entity_id'), is = lc.indexOf('state');
    const it = ['last_changed', 'last_updated', 'time', 'timestamp'].map(k => lc.indexOf(k)).find(i => i >= 0);
    if (ie >= 0 && is >= 0 && it !== undefined) {
      for (const l of lines.slice(1)) { const c = l.split(delim); add(c[ie].trim().replace(/^"|"$/g, ''), time(c[it]), num(c[is])); }
    } else {
      for (const l of lines.slice(1)) {
        const c = l.split(delim); const t = time(c[0]);
        for (let k = 1; k < cols.length; k++) add(cols[k] || ('column ' + k), t, num(c[k]));
      }
    }
  }
  for (const k of Object.keys(out)) { out[k].sort((a, b) => a.t - b.t); if (out[k].length < 2) delete out[k]; }
  if (!Object.keys(out).length) throw new Error('No numeric series found. Expected Home Assistant history (CSV or JSON) or a table with a time column.');
  return out;
}
const median = a => { const s = a.map(p => p.v).sort((x, y) => x - y); return s[s.length >> 1]; };
function guessMap(series) {
  const names = Object.keys(series);
  const pick = (re, not, ok) => names.find(n => re.test(n.toLowerCase()) && !(not && not.test(n.toLowerCase())) && (!ok || ok(series[n])));
  const price = pick(/price|preis|tibber|strom|electric|energy|epex|nordpool|awattar/, /next|avg|average|⌀|trend|level|rating|outlook|trajectory|min|max|rank/)
    || names.find(n => { const m = median(series[n]); return m > -0.5 && m < 1.5; }) || names[0];
  const temp = s => { const m = median(s); return m > -40 && m < 50; };
  const outdoor = pick(/outdoor|outside|aussen|außen|exterior|weather|balkon|garten|garden|terrasse/, null, temp)
    || names.find(n => n !== price && temp(series[n])) || '';
  const indoor = pick(/indoor|room|innen|wohn|flur|hallway|living|zimmer|bed|schlaf|kitchen|küche|office|buero|büro/, /outdoor|outside|aussen|außen/, temp) || '';
  return { price, outdoor: outdoor === price ? '' : outdoor, indoor: indoor === outdoor || indoor === price ? '' : indoor };
}

export function createRoomView({ form }) {
  let P = Object.assign({}, ROOM_DEFAULTS, store.get('acs-sim-params-v1') || {});
  let pinned = store.get('acs-sim-baseline-v1');
  let DATA = null, loaded = null, RES = null, BRES = null, RANGE = null, IND = null, GEO = [];
  let active = false, pending = false;
  const sourceSel = $('source'), daySel = $('day'), stage = $('stage');

  const hv = hover({
    stage, tip: $('tip'), charts: () => GEO, count: () => RES ? RES.rows.length : 0, start: () => RANGE.start,
    fill: (i, tip) => fillTip(i, tip),
  });

  function fillSources() {
    sourceSel.textContent = '';
    for (const ex of EXAMPLES) { const o = document.createElement('option'); o.value = ex.id; o.textContent = ex.name; sourceSel.appendChild(o); }
    if (loaded) { const o = document.createElement('option'); o.value = 'file'; o.textContent = 'Loaded: ' + loaded.label; sourceSel.appendChild(o); }
  }
  function setSource(id) {
    if (id === 'file' && loaded) DATA = loaded;
    else DATA = buildExample(EXAMPLES.find(e => e.id === id) || EXAMPLES[0]);
    sourceSel.value = id === 'file' && loaded ? 'file' : (EXAMPLES.find(e => e.id === id) || EXAMPLES[0]).id;
    $('mapping').hidden = !!DATA.example;
    if (!DATA.example) fillMapping();
    fillDays();
    schedule();
  }
  function fillMapping() {
    const names = Object.keys(DATA.series);
    for (const role of ['price', 'outdoor', 'indoor']) {
      const sel = $('map-' + role); sel.textContent = '';
      if (role !== 'price') { const o = document.createElement('option'); o.value = ''; o.textContent = role === 'indoor' ? '(none)' : '(none, assume 10 °C)'; sel.appendChild(o); }
      for (const n of names) { const o = document.createElement('option'); o.value = n; o.textContent = n + ' (' + DATA.series[n].length + ' values)'; sel.appendChild(o); }
      sel.value = DATA.map[role] || '';
    }
  }
  function priceSeries() {
    const raw = DATA.series[DATA.map.price] || [];
    DATA.scale = (raw.length ? median(raw) : 0) > 3 ? 100 : 1;
    return DATA.scale === 1 ? raw : raw.map(p => ({ t: p.t, v: p.v / 100 }));
  }
  function fillDays() {
    const pr = priceSeries();
    daySel.textContent = '';
    if (!pr.length) return;
    const first = dayStart(pr[0].t), last = pr[pr.length - 1].t;
    const days = [];
    for (let d = first; d <= last; d = dayStart(d + 26 * HOUR)) days.push(d);
    let pick = days[0];
    for (const d of days) { if (pr[0].t <= d + HOUR && last >= d + 20 * HOUR) { pick = d; break; } }
    if (DATA.example) pick = DATA.days[0];
    for (const d of days) {
      const o = document.createElement('option'); o.value = d;
      o.textContent = new Date(d).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
      daySel.appendChild(o);
    }
    daySel.value = pick;
    $('dayfield').hidden = !!DATA.example;
  }
  function loadText(text, label) {
    const info = $('datainfo');
    try {
      const series = parseText(text);
      loaded = { series, map: guessMap(series), label, example: false };
      fillSources(); setSource('file');
    } catch (e) {
      info.textContent = 'Could not read that data: ' + e.message;
      info.classList.add('err');
    }
  }

  function baselineParams() {
    if (pinned) return Object.assign({}, ROOM_DEFAULTS, pinned);
    return Object.assign({}, P, { use_near: false });
  }
  function run() {
    const price = priceSeries();
    const outdoor = DATA.series[DATA.map.outdoor] || [];
    IND = DATA.map.indoor ? DATA.series[DATA.map.indoor] : null;
    const d0 = +daySel.value || (price.length ? dayStart(price[0].t) : dayStart(Date.now()));
    const start = Math.max(d0, price.length ? price[0].t : d0);
    // history records changes, so the last price holds for at least one more interval
    const end = Math.min(d0 + 24 * HOUR, price.length ? price[price.length - 1].t + detectInterval(price) * MIN : d0 + 24 * HOUR);
    const outd = outdoor.length ? outdoor : [{ t: start - HOUR, v: 10 }, { t: end + 24 * HOUR, v: 10 }];
    RANGE = { start: Math.floor(start / MIN) * MIN, end: Math.ceil(end / MIN) * MIN };
    const data = { price, outdoor: outd, indoor: IND };
    if (RANGE.end - RANGE.start < 30 * MIN) { RES = BRES = null; return; }
    RES = simulateRoom(data, P, RANGE);
    BRES = simulateRoom(data, baselineParams(), RANGE);
    const info = $('datainfo'); info.classList.remove('err');
    const span = (RANGE.end - RANGE.start) / HOUR;
    const hl = RES.rows.length ? RES.rows[0] : null;
    info.textContent = (DATA.example ? 'Made-up example prices, not your data. ' : '') +
      (RES.intervalMin === 15 ? '15-minute' : 'Hourly') + ' prices' +
      (DATA.scale === 100 ? ', converted from ct/kWh' : '') +
      ' · ' + (span >= 23.9 ? 'full day' : span.toFixed(1) + ' h') +
      (hl ? ' · ' + (hl.day_type === 'heat' ? 'heating' : hl.day_type === 'cool' ? 'cooling' : 'dead-band') + ' day (high ' + fmt(hl.high, 1) + ' °C, low ' + fmt(hl.low, 1) + ' °C)' : '');
  }
  function schedule() { if (pending || !active) return; pending = true; requestAnimationFrame(() => { pending = false; if (!active) return; run(); render(); }); }

  function render() { renderCompare(); renderTiles(); renderCharts(); $('yaml').textContent = yamlFor(P, DATA && DATA.scale); renderTable(); }
  function renderCompare() {
    const w = $('basewhat'); w.textContent = '';
    w.appendChild(document.createTextNode('Grey lines show the baseline: '));
    const b = document.createElement('b');
    b.textContent = pinned ? 'settings pinned ' + (pinned._at || '') : 'the same settings with the falling-price hold switched off';
    w.appendChild(b);
    $('unpin').disabled = !pinned;
  }
  function renderTiles() {
    const box = $('tiles'); box.textContent = '';
    if (!RES) return;
    const T = s => document.createTextNode(s);
    box.appendChild(tile('Electricity cost', '€' + RES.cost.toFixed(2), '', [[delta(RES.cost, BRES.cost, 2, ' €', true)], [T('baseline €' + BRES.cost.toFixed(2))]]));
    box.appendChild(tile('Average price paid', RES.avgPrice === null ? '–' : RES.avgPrice.toFixed(3), '€/kWh', [[delta(RES.avgPrice, BRES.avgPrice, 3, '', true)], [T('baseline ' + fmt(BRES.avgPrice, 3))]]));
    box.appendChild(tile('Energy used', RES.energy.toFixed(1), 'kWh', [[delta(RES.energy, BRES.energy, 1, ' kWh', true)], [T('baseline ' + BRES.energy.toFixed(1))]]));
    const endC = RES.rows[RES.rows.length - 1].indoor, endB = BRES.rows[BRES.rows.length - 1].indoor;
    box.appendChild(tile('Room, coldest to warmest', RES.minIn.toFixed(1) + '–' + RES.maxIn.toFixed(1), '°C', [
      [T('ends the day at ' + endC.toFixed(1) + ' °C')],
      [T('baseline ' + BRES.minIn.toFixed(1) + '–' + BRES.maxIn.toFixed(1) + ', ends at ' + endB.toFixed(1))],
    ]));
  }
  let powerCur = [], powerBase = [];
  const quarterIndex = t => Math.floor(t / (15 * MIN)) - Math.floor(RANGE.start / (15 * MIN));
  function renderCharts() {
    const ids = ['ch-temp', 'ch-outdoor', 'ch-price', 'ch-power'];
    if (!RES) { ids.forEach(id => $(id).textContent = ''); GEO = []; return; }
    const rows = RES.rows, brows = BRES.rows, night = { start: P.night_start, end: P.night_end };
    // target and room
    const ind = IND ? IND.filter(p => p.t >= RANGE.start && p.t <= RANGE.end) : [];
    let yt = niceTicks(...extent(rows.map(r => r.target).concat(rows.map(r => r.indoor), brows.map(r => r.target), ind.map(p => p.v)), 0.3), 5);
    const gT = frame($('ch-temp'), { height: 286, yt, fmtY: v => v.toFixed(yt.step < 1 ? 1 : 0) + '°', band: 30, range: RANGE, night });
    svgEl('path', { d: stepPath(brows, gT, r => r.target), class: 'ln thin c-base' }, gT.svg);
    if (ind.length) svgEl('path', { d: linePath(ind, gT), class: 'ln thin c-room measured' }, gT.svg);
    svgEl('path', { d: linePath(every(rows, 5, r => r.indoor), gT), class: 'ln c-room' }, gT.svg);
    svgEl('path', { d: stepPath(rows, gT, r => r.target), class: 'ln thin c-target measured' }, gT.svg);
    svgEl('path', { d: stepPath(rows, gT, r => r.mode === 'off' ? null : r.target), class: 'ln c-target' }, gT.svg);
    strip(gT, rows, gT.pb + 14, 'c-target', r => r.mode !== 'off');
    strip(gT, brows, gT.pb + 22, 'c-base', r => r.mode !== 'off');
    stripLabel(gT, gT.pb + 19, 'runs'); stripLabel(gT, gT.pb + 27, 'base');
    legend($('leg-temp'), [['c-target', 'Target (faint while off)'], ['c-base', 'Target, baseline', 'thin'], ['c-room', 'Room (model)']]
      .concat(ind.length ? [['c-room', 'Room (measured)', 'thin fade']] : []));
    // outdoor, one series: the title names it
    yt = niceTicks(...extent(rows.map(r => r.outdoor), 0.5), 3);
    const gO = frame($('ch-outdoor'), { height: 130, yt, fmtY: v => v.toFixed(yt.step < 1 ? 1 : 0) + '°', range: RANGE, night });
    svgEl('path', { d: linePath(every(rows, 5, r => r.outdoor), gO), class: 'ln c-outdoor' }, gO.svg);
    // price
    const pv = rows.map(r => r.price).concat(P.use_forward ? rows.map(r => r.fwdMean) : [], P.use_near ? rows.map(r => r.nearMean) : [], [P.price_cheap, P.price_expensive]);
    const ytp = niceTicks(...extent(pv, 0), 4);
    const gP = frame($('ch-price'), { height: 190, yt: ytp, fmtY: v => v.toFixed(ytp.step < 0.01 ? 3 : 2), range: RANGE, night });
    if (P.use_near) holdBands(gP, rows);
    refLines(gP, ytp, P);
    if (P.use_forward) svgEl('path', { d: stepPath(rows, gP, r => r.fwdMean), class: 'ln thin c-forward' }, gP.svg);
    if (P.use_near) svgEl('path', { d: stepPath(rows, gP, r => r.nearMean), class: 'ln thin c-near' }, gP.svg);
    svgEl('path', { d: stepPath(rows, gP, r => r.price), class: 'ln c-price' }, gP.svg);
    const items = [['c-price', 'Price now']];
    if (P.use_forward) items.push(['c-forward', '⌀ next ' + P.forward_hours + ' h', 'thin']);
    if (P.use_near) { items.push(['c-near', '⌀ next ' + P.near_hours + ' h', 'thin']); items.push(['c-price', 'Holding: price still falling', 'box fade']); }
    legend($('leg-price'), items);
    // power, as 15-minute means
    powerCur = quarterMeans(rows, r => r.pel); powerBase = quarterMeans(brows, r => r.pel);
    const ytw = niceTicks(0, Math.max(0.5, ...powerCur.concat(powerBase).map(p => p.v)), 3);
    const gW = frame($('ch-power'), { height: 150, yt: ytw, fmtY: v => v.toFixed(ytw.step < 1 ? 1 : 0) + ' kW', range: RANGE, night });
    const dc = quarterPath(powerCur, gW);
    if (powerCur.length) svgEl('path', { d: dc + 'V' + gW.Y(0).toFixed(1) + 'H' + gW.X(powerCur[0].t).toFixed(1) + 'Z', class: 'area c-target' }, gW.svg);
    svgEl('path', { d: quarterPath(powerBase, gW), class: 'ln thin c-base' }, gW.svg);
    svgEl('path', { d: dc, class: 'ln c-target' }, gW.svg);
    legend($('leg-power'), [['c-target', 'Current settings'], ['c-base', 'Baseline', 'thin']]);
    GEO = [
      { card: $('card-temp'), g: gT, dots: i => [[rows[i].target, 'c-target'], [rows[i].indoor, 'c-room']] },
      { card: $('card-outdoor'), g: gO, dots: i => [[rows[i].outdoor, 'c-outdoor']] },
      { card: $('card-price'), g: gP, dots: i => [[rows[i].price, 'c-price']] },
      { card: $('card-power'), g: gW },
    ];
    hv.bind();
    if (hv.idx !== null) hv.show(hv.idx);
  }
  function fillTip(i, tip) {
    const r = RES.rows[i], b = BRES.rows[i], q = quarterIndex(r.t), pc = powerCur[q], pb = powerBase[q];
    const head = document.createElement('div'); head.className = 't'; head.textContent = hhmm(r.t); tip.appendChild(head);
    tipRow(tip, 'c-target', 'Target', fmt(r.target, 1) + ' °C · ' + r.mode);
    tipRow(tip, 'c-base', 'Baseline', fmt(b.target, 1) + ' °C · ' + b.mode);
    tipRow(tip, 'c-room', 'Room (model)', fmt(r.indoor, 1) + ' °C');
    tipRow(tip, 'c-outdoor', 'Outdoor', fmt(r.outdoor, 1) + ' °C');
    tipRow(tip, 'c-price', 'Price now', fmt(r.price, 3));
    if (P.use_near) tipRow(tip, 'c-near', '⌀ next ' + P.near_hours + ' h', fmt(r.nearMean, 3));
    if (P.use_forward) tipRow(tip, 'c-forward', '⌀ next ' + P.forward_hours + ' h', fmt(r.fwdMean, 3));
    tipRow(tip, '', 'Signal', (r.signal > 0 ? '+' : '') + fmt(r.signal, 2) + (r.signal !== r.sig_unheld ? '  (was ' + fmt(r.sig_unheld, 2) + ')' : ''));
    tipRow(tip, 'c-target', 'Power', (pc ? pc.v.toFixed(2) : '–') + ' kW');
    tipRow(tip, 'c-base', 'Power, baseline', (pb ? pb.v.toFixed(2) : '–') + ' kW');
    const why = reasons(r, P);
    if (why) { const d = document.createElement('div'); d.className = 'why'; d.textContent = why; tip.appendChild(d); }
  }
  function renderTable() {
    const tb = $('table'); tb.textContent = '';
    if (!RES || !$('p-table').open) return;
    const cols = ['Time', 'Price', '⌀ near', '⌀ fwd', 'Hold', 'Signal', 'Target', 'Base', 'Mode', 'Room', 'Outdoor', 'kW', 'Base kW'];
    const thead = document.createElement('thead'), tr = document.createElement('tr');
    for (const c of cols) { const th = document.createElement('th'); th.textContent = c; tr.appendChild(th); }
    thead.appendChild(tr); tb.appendChild(thead);
    const body = document.createElement('tbody');
    for (let i = 0; i < RES.rows.length; i += 15) {
      const r = RES.rows[i], b = BRES.rows[i], q = quarterIndex(r.t);
      const vals = [hhmm(r.t), fmt(r.price, 3), P.use_near ? fmt(r.nearMean, 3) : '–', P.use_forward ? fmt(r.fwdMean, 3) : '–',
        r.signal !== r.sig_unheld ? Math.round(r.falling * 100) + ' %' : '', fmt(r.signal, 2), fmt(r.target, 1), fmt(b.target, 1),
        r.mode, fmt(r.indoor, 1), fmt(r.outdoor, 1), powerCur[q] ? powerCur[q].v.toFixed(2) : '–', powerBase[q] ? powerBase[q].v.toFixed(2) : '–'];
      const row = document.createElement('tr');
      for (const v of vals) { const td = document.createElement('td'); td.textContent = v; row.appendChild(td); }
      body.appendChild(row);
    }
    tb.appendChild(body);
  }

  $('pin').addEventListener('click', () => {
    pinned = Object.assign({}, P, { _at: 'at ' + new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) });
    store.set('acs-sim-baseline-v1', pinned); schedule();
  });
  $('unpin').addEventListener('click', () => { pinned = null; store.set('acs-sim-baseline-v1', null); schedule(); });
  sourceSel.addEventListener('change', () => setSource(sourceSel.value));
  daySel.addEventListener('change', schedule);
  for (const role of ['price', 'outdoor', 'indoor']) $('map-' + role).addEventListener('change', e => { DATA.map[role] = e.target.value; if (role === 'price') fillDays(); schedule(); });
  $('file').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    readFile(f, t => loadText(t, f.name), msg => { $('datainfo').textContent = msg; $('datainfo').classList.add('err'); });
    e.target.value = '';
  });
  $('usepaste').addEventListener('click', () => loadText($('paste').value, 'pasted data'));
  $('p-table').addEventListener('toggle', renderTable);
  $('copy').addEventListener('click', () => copyText($('yaml').textContent, $('yaml'), $('copied')));
  fillSources();

  return {
    activate() {
      active = true;
      showMode(form, 'room'); writeForm(form, P);
      if (!DATA) setSource(EXAMPLES[0].id); else schedule();
    },
    deactivate() { active = false; hv.hide(); },
    input() { readForm(form, P); store.set('acs-sim-params-v1', P); schedule(); },
    reset() { P = Object.assign({}, ROOM_DEFAULTS); writeForm(form, P); store.set('acs-sim-params-v1', P); schedule(); },
    resize() { if (active && RES) renderCharts(); },
  };
}

// Shared with the apartment view.
export function holdBands(g, rows, pick) {
  const get = pick || (r => r);
  let s = null, f = 0;
  const flush = t => { if (s !== null && f > 0.001) svgEl('rect', { x: g.X(s), y: M.t, width: Math.max(0.5, g.X(t) - g.X(s)), height: g.pb - M.t, class: 'hold', opacity: (0.06 + 0.22 * f).toFixed(3) }, g.svg); s = null; };
  for (const r of rows) {
    const d = get(r);
    const held = d && d.signal !== d.sig_unheld ? d.falling : 0;
    if (s === null || held !== f) { flush(r.t); s = r.t; f = held; }
  }
  flush(g.range.end);
}
export function refLines(g, yt, P) {
  for (const [v, name] of [[P.price_cheap, 'cheap'], [P.price_expensive, 'expensive']]) {
    if (v < yt.lo || v > yt.hi) continue;
    svgEl('line', { x1: M.l, x2: g.w - M.r, y1: g.Y(v), y2: g.Y(v), class: 'ref' }, g.svg);
    svgEl('text', { x: g.w - M.r, y: g.Y(v) - 3, 'text-anchor': 'end' }, g.svg).textContent = name;
  }
}
export function reasons(d, P) {
  if (!d) return '';
  const parts = [];
  if (d.near_valid && d.falling > 0 && d.signal !== d.sig_unheld) parts.push('Holding ' + Math.round(d.falling * 100) + ' %: the next ' + P.near_hours + ' h are cheaper.');
  if (d.mode === 'off' && d.reasons && d.reasons.length) parts.push('Off: ' + d.reasons.join(', ') + '.');
  else if (d.mode === 'off' && d.should_be_off === false) parts.push('Off: timing guard.');
  if (d.storage_bypass) parts.push('Charging through night mode.');
  return parts.join(' ');
}
