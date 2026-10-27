// The whole apartment: train a model on a Home Assistant export, then replay
// a day with each unit driven by its own blueprint instance.
import { $, HOUR, MIN, fmt, hhmm, dayStart, dayLabel, store, h, tile, delta, copyText, readFile } from './util.js';
import { frame, niceTicks, extent, stepPath, linePath, every, strip, stripLabel, legend, quarterMeans, quarterPath, svgEl, hover, tipRow } from './charts.js';
import { writeForm, readForm, showMode, yamlFor, AXIS } from './form.js';
import { holdBands, refLines, reasons } from './room.js';
import { BLUEPRINT_DEFAULTS } from '../src/blueprint.js';
import { defaultModel, zoneSummary, ZONES, ZONE_IDS, AC_ZONES, WINDOW_ZONES } from '../src/apartment.js';
import { carnotHeat } from '../src/room.js';
import { parseExport, guessMapping, prepare } from '../src/haexport.js';
import { train, powerObservation, freeRun } from '../src/fit.js';
import { simulateDay } from '../src/flatsim.js';
import { syntheticRun, toExport, SYNTHETIC_INSTANCES } from '../src/synthetic.js';

const LABEL = Object.fromEntries(ZONES.map(z => [z.id, z.label]));
const clone = o => JSON.parse(JSON.stringify(o));
const median = a => { const s = a.filter(isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const AUTUMN = [0.27, 0.265, 0.26, 0.26, 0.265, 0.28, 0.31, 0.34, 0.345, 0.32, 0.28, 0.24, 0.21, 0.195, 0.20, 0.23, 0.27, 0.32, 0.37, 0.38, 0.35, 0.32, 0.30, 0.285];

export function createFlatView({ form }) {
  const saved = store.get('acs-flat-v1') || {};
  const units = Object.fromEntries(AC_ZONES.map(z => [z, Object.assign({}, BLUEPRINT_DEFAULTS, SYNTHETIC_INSTANCES[z], (saved.units || {})[z] || {})]));
  let unit = AC_ZONES.includes(saved.unit) ? saved.unit : AC_ZONES[0];
  let baseKind = saved.base || 'recorded';
  let pinned = saved.pinned || null;
  const heater = Object.assign({ kind: 'recorded', set: 22.5, windows: '06:00-07:30, 19:00-21:30' }, saved.heater || {});
  let trained = store.get('acs-flat-model-v1');
  let model = trained && trained.model && trained.model.version === defaultModel().version ? trained.model : defaultModel();
  if (trained && model !== trained.model) trained = null;
  let lastTrain = null, dataset = null, RES = null, BRES = null, RANGE = null, GEO = [], active = false, pending = false, busy = false;
  const persist = () => store.set('acs-flat-v1', { units, unit, base: baseKind, pinned, heater });
  const stage = $('stage');
  const hv = hover({ stage, tip: $('tip'), charts: () => GEO, count: () => RES ? RES.rows.length : 0, start: () => RANGE.start, fill: (i, tip) => fillTip(i, tip) });

  // ---------------------------------------------------------------- data
  function useDataset(ds) {
    dataset = ds;
    const g = ds.grid;
    const raw = g.price || [];
    ds.scale = median(raw.map(p => p.v)) > 3 ? 100 : 1;
    ds.price = ds.scale === 100 ? raw.map(p => ({ t: p.t, v: p.v / 100 })) : raw;
    ds.pw = powerObservation(g);
    ds.days = [];
    const perDay = Math.round(24 * 60 / g.stepMin);
    for (let k = 0; k + perDay < g.K; k++) {
      const d = new Date(g.t[k]); if (d.getHours() || d.getMinutes()) continue;
      let v = 0; for (let j = k; j < k + perDay; j++) v += g.valid[j];
      if (v >= 0.9 * perDay) ds.days.push(k);
    }
    if (!ds.days.length) ds.days.push(0);
    const daySel = $('f-day'); daySel.textContent = '';
    for (const k of ds.days) daySel.appendChild(h('option', { value: k, text: dayLabel(g.t[k]) + (k === 0 ? ' (start of data)' : '') }));
    daySel.value = ds.days[ds.days.length - 1];
    renderModelInfo();
    schedule();
  }
  function exampleDataset() {
    const start = dayStart(Date.now()) - 4 * 24 * HOUR;
    // the example units ran the blueprint without the falling-price hold, so
    // "what the units really did" shows what the hold changes
    const instances = Object.fromEntries(AC_ZONES.map(z => [z, Object.assign({}, SYNTHETIC_INSTANCES[z], { use_near: false })]));
    const run = syntheticRun({ days: 4, seed: 11, start, model: defaultModel(), instances });
    const parsed = parseExport(toExport(run));
    const { map, grid } = prepare(parsed, guessMapping(parsed));
    return { kind: 'example', label: 'made-up example days', parsed, map, grid };
  }
  function loadExport(text, label) {
    const msg = $('f-trainmsg');
    try {
      const parsed = parseExport(text);
      let map = guessMapping(parsed);
      if (trained && trained.map) map = mergeMap(map, trained.map, parsed);
      const prep = prepare(parsed, map);
      useDataset({ kind: 'export', label, parsed, map: prep.map, grid: prep.grid });
      renderMapping();
      $('f-train').hidden = false;
      msg.hidden = true;
    } catch (e) {
      msg.hidden = false; msg.className = 'notice err'; msg.textContent = 'Could not use that file: ' + e.message;
    }
  }
  // keep earlier choices where the entities still exist
  function mergeMap(guess, savedMap, parsed) {
    const has = id => !id || parsed.num[id] || parsed.climate[id] || parsed.binary[id] || parsed.weather[id];
    const m = clone(guess);
    for (const z of ZONE_IDS) if (savedMap.temp && has(savedMap.temp[z])) m.temp[z] = savedMap.temp[z];
    for (const z of AC_ZONES) if (savedMap.climate && has(savedMap.climate[z])) m.climate[z] = savedMap.climate[z];
    for (const z of WINDOW_ZONES) if (savedMap.window && (savedMap.window[z] || []).every(has)) m.window[z] = savedMap.window[z];
    for (const k of ['outdoor', 'heater', 'phase', 'car', 'price', 'weather']) if (savedMap[k] !== undefined && has(savedMap[k])) m[k] = savedMap[k];
    return m;
  }
  function remap() {
    try {
      const prep = prepare(dataset.parsed, dataset.map);
      dataset.map = prep.map;
      useDataset(Object.assign(dataset, { grid: prep.grid }));
      $('f-trainmsg').hidden = true;
    } catch (e) {
      const msg = $('f-trainmsg'); msg.hidden = false; msg.className = 'notice err'; msg.textContent = e.message;
    }
  }

  // ---------------------------------------------------------------- mapping UI
  function renderMapping() {
    const outer = $('f-mapping'); outer.textContent = ''; outer.hidden = false;
    const box = h('div', { class: 'body-inner' });
    outer.append(h('details', { class: 'roles', open: !(trained && trained.map) }, h('summary', { text: 'Which sensor is what' }), box));
    const p = dataset.parsed, map = dataset.map;
    const name = id => ((p.meta[id] || {}).name || id);
    const opt = (id, label) => h('option', { value: id, text: label || (name(id) + ' · ' + id) });
    const nums = Object.keys(p.num), unitOf = id => ((p.meta[id] || {}).unit || '');
    const temps = nums.filter(id => /°/.test(unitOf(id)) || (p.meta[id] || {}).device_class === 'temperature');
    const powers = nums.filter(id => /^k?w$/i.test(unitOf(id)) || (p.meta[id] || {}).device_class === 'power');
    const prices = nums.filter(id => /\/\s*kwh/i.test(unitOf(id)));
    const sel = (label, value, options, set) => {
      const id = 'f-map-' + label.replace(/\W+/g, '-').toLowerCase();
      const s = h('select', { id, onchange: e => { set(e.target.value); remap(); } }, options);
      s.value = value || '';
      return h('div', { class: 'field stack' }, h('label', { for: id, text: label }), s);
    };
    box.append(h('p', { class: 'hint', text: 'Check what plays which role. Guesses come from areas and names.' }));
    for (const z of ZONE_IDS) box.append(sel(LABEL[z] + ' thermometer', map.temp[z], [opt('', '(none)'), ...temps.map(i => opt(i))], v => { map.temp[z] = v; }));
    box.append(sel('Outdoor temperature', map.outdoor, [opt('', '(weather entity)'), ...temps.map(i => opt(i))], v => { map.outdoor = v; }));
    for (const z of AC_ZONES) box.append(sel(LABEL[z] + ' unit', map.climate[z], [opt('', '(none)'), ...Object.keys(p.climate).map(i => opt(i))], v => { map.climate[z] = v; }));
    for (const z of WINDOW_ZONES) {
      const cur = map.window[z] || [];
      const options = [opt('', '(none)'), ...Object.keys(p.binary).map(i => opt(i))];
      if (cur.length > 1) options.push(opt('__multi', cur.length + ' sensors, as found'));
      box.append(sel(LABEL[z] + ' door or window', cur.length > 1 ? '__multi' : (cur[0] || ''), options, v => { if (v !== '__multi') map.window[z] = v ? [v] : []; }));
    }
    box.append(sel('Bath heater power', map.heater, [opt('', '(none)'), ...powers.map(i => opt(i))], v => { map.heater = v; }));
    box.append(sel('Phase with the outdoor unit', map.phase, [opt('', '(pick from the data)'), ...powers.map(i => opt(i))], v => { map.phase = v; delete map.phasePick; }));
    box.append(sel('Car charger power', map.car, [opt('', '(none)'), ...powers.map(i => opt(i))], v => { map.car = v; }));
    box.append(sel('Electricity price', map.price, [opt('', '(none)'), ...prices.map(i => opt(i))], v => { map.price = v; }));
    box.append(sel('Weather', map.weather, [opt('', '(none)'), ...Object.keys(p.weather).map(i => opt(i))], v => { map.weather = v; }));
    if (map.phasePick) box.append(h('p', { class: 'hint', text: map.phasePick.how === 'jump'
      ? 'Picked from the data: this phase jumps most clearly when a unit switches on (' + map.phasePick.events + ' switch-ons). Choose it yourself if that is wrong.'
      : 'Picked from the data: this phase moves most with the units. Choose it yourself if that is wrong.' }));
  }

  // ---------------------------------------------------------------- training
  async function doTrain() {
    if (busy || !dataset || dataset.kind !== 'export') return;
    busy = true;
    const btn = $('f-train'), bar = $('f-progress'), msg = $('f-trainmsg');
    btn.disabled = true; bar.hidden = false; msg.hidden = false; msg.className = 'notice'; msg.textContent = 'Training…';
    const t0 = Date.now();
    try {
      const res = await train(dataset.grid, {
        onProgress: p => {
          if (p.frac !== undefined) bar.firstChild.style.width = Math.round(Math.min(1, p.frac) * 100) + '%';
          if (p.stage === 'fit' && p.iter) msg.textContent = 'Training… pass ' + p.iter;
        },
      });
      model = res.model; lastTrain = res;
      trained = { model, report: res.report, map: dataset.map, label: dataset.label, at: Date.now() };
      store.set('acs-flat-model-v1', trained);
      msg.textContent = 'Trained in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s. See “The model and how well it predicts” below.';
      $('f-p-model').open = true;
      renderModelInfo(); schedule();
    } catch (e) {
      msg.className = 'notice err'; msg.textContent = 'Training failed: ' + e.message;
    } finally {
      busy = false; btn.disabled = false; bar.hidden = true; bar.firstChild.style.width = '0';
    }
  }

  function renderModelInfo() {
    const info = $('f-modelinfo');
    const r = trained && trained.report;
    if (r) {
      const val = r.rmseVal, worst = Math.max(...val), best = Math.min(...val);
      info.textContent = 'Trained on ' + r.days.train.length + ' days from ' + (trained.label || 'your export') + ', ' + dayLabel(r.range.start) + ' to ' + dayLabel(r.range.end)
        + '. On ' + (r.days.val.length || 1) + ' held-out day' + ((r.days.val.length || 1) > 1 ? 's' : '') + ' it was off by ' + best.toFixed(1) + '–' + worst.toFixed(1) + ' K.';
    } else info.textContent = 'Example apartment with made-up rooms. Load your export to train the model on your own data.';
    const dinfo = $('f-dayinfo');
    if (dataset) {
      dinfo.textContent = (dataset.kind === 'example' ? 'Made-up example days, not your data. ' : 'From ' + dataset.label + '. ')
        + (dataset.grid.price && dataset.grid.price.length ? (dataset.scale === 100 ? 'Prices converted from ct/kWh.' : '') : 'No price sensor in the data: made-up autumn prices are used.');
    }
    renderReport();
  }

  // ---------------------------------------------------------------- report
  function renderReport() {
    const box = $('f-report'); box.textContent = '';
    const r = trained && trained.report;
    box.append(h('p', { class: 'hint', text: r
      ? 'Every room has three layers here: its air, which the thermometer reads; its surfaces and furniture, which the air warms within hours; and the walls and floor slab, which take days. The model learned how much each holds and how it leaks to the outside, to the neighbours and to the hallway.'
      : 'This is the made-up example apartment. After training on your export, this shows what the model learned and how well it predicted days it had not seen.' }));
    const rows = ZONE_IDS.map((z, i) => {
      const s = zoneSummary(model, z);
      return h('tr', {}, h('td', { text: LABEL[z] }), h('td', { text: trained && trained.map ? (trained.map.temp[z] || '–') : '–' }),
        h('td', { text: s.C.toFixed(1) }), h('td', { text: (s.Hloss * 1000).toFixed(0) }), h('td', { text: s.tauH.toFixed(0) }),
        h('td', { text: r ? r.rmseVal[i].toFixed(2) : '–' }));
    });
    box.append(h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Zone', 'Thermometer', 'Stores, kWh/K', 'Loses, W/K', 'Time constant, h', 'Held-out error, K'].map(t => h('th', { text: t })))),
      h('tbody', {}, rows))));
    const pl = model.plant;
    box.append(h('p', { class: 'hint', text: 'Heat pump: COP ' + (pl.eta * carnotHeat(21, 7)).toFixed(1) + ' at 21 °C inside and 7 °C outside, at most ' + pl.Qmax.toFixed(1) + ' kW of heat from the outdoor unit. '
      + AC_ZONES.map(z => LABEL[z] + ' up to ' + model.ac[z].Qmax.toFixed(1) + ' kW, its sensor reads ' + (model.ac[z].off >= 0 ? '+' : '') + model.ac[z].off.toFixed(1) + ' K').join('; ') + '.' }));
    if (r && r.warnings.length) box.append(h('ul', { class: 'warn' }, r.warnings.map(w => h('li', { text: w }))));
    if (r && r.energy.observed) box.append(h('p', { class: 'hint', text: 'On the held-out days the model used ' + r.energy.sim.toFixed(1) + ' kWh for the units; the phase showed ' + r.energy.obs.toFixed(1)
      + ' kWh above its usual other loads. The phase also carries whatever else runs while the units do, so expect the model to be lower.' }));
    // the check itself: a held-out day from midnight, nothing but the recorded inputs
    if (lastTrain && dataset && dataset.kind === 'export') {
      const v = lastTrain.validation;
      const dsel = h('select', { id: 'f-chk-day' }, v.map((d, i) => h('option', { value: i, text: dayLabel(d.t0) })));
      const zsel = h('select', { id: 'f-chk-zone' }, ZONE_IDS.map(z => h('option', { value: z, text: LABEL[z] })));
      const svg = svgEl('svg', { class: 'chart', id: 'f-ch-check', role: 'img', 'aria-label': 'Measured and predicted temperature on a held-out day' });
      const leg = h('div', { class: 'legend' });
      box.append(h('div', { class: 'row' }, h('label', { for: 'f-chk-day', class: 'hint', text: 'Check' }), dsel, zsel), h('div', { class: 'card check' }, leg, svg));
      const draw = () => {
        const d = v[+dsel.value], zi = ZONE_IDS.indexOf(zsel.value), g = dataset.grid, n = ZONE_IDS.length;
        const steps = Math.round(24 / g.stepH), pts = [], meas = [];
        for (let j = 0; j <= steps && d.k0 + j < g.K; j++) { pts.push({ t: g.t[d.k0 + j], v: d.run.T[j * n + zi] }); meas.push({ t: g.t[d.k0 + j], v: g.T[zi][d.k0 + j] }); }
        const range = { start: pts[0].t, end: pts[pts.length - 1].t };
        const yt = niceTicks(...extent(pts.map(p => p.v).concat(meas.map(p => p.v)), 0.3), 4);
        const gg = frame(svg, { height: 200, yt, fmtY: x => x.toFixed(yt.step < 1 ? 1 : 0) + '°', range, night: null });
        svgEl('path', { d: linePath(meas, gg), class: 'ln thin c-room measured' }, gg.svg);
        svgEl('path', { d: linePath(pts, gg), class: 'ln c-room' }, gg.svg);
        legend(leg, [['c-room', 'Predicted from midnight'], ['c-room', 'Measured', 'thin fade']]);
      };
      dsel.onchange = draw; zsel.onchange = draw;
      requestAnimationFrame(draw);
    }
    const ta = h('textarea', { id: 'f-model-json', placeholder: 'Paste a model copied from here earlier' });
    const status = h('span', { class: 'hint', role: 'status' });
    box.append(h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', text: 'Copy model', onclick: () => { ta.value = JSON.stringify(trained || { model }); copyText(ta.value, ta, status); } }),
      h('button', { class: 'btn', type: 'button', text: 'Use pasted model', onclick: () => {
        try {
          const j = JSON.parse(ta.value), m = j.model || j;
          if (!m.zones || !m.plant || m.version !== defaultModel().version) throw new Error('not a model from this version of the simulator');
          model = m; trained = j.model ? j : { model: m }; store.set('acs-flat-model-v1', trained); lastTrain = null;
          status.textContent = 'Model loaded.'; renderModelInfo(); schedule();
        } catch (e) { status.textContent = 'That is not a model: ' + e.message + '.'; }
      } }),
      trained ? h('button', { class: 'btn', type: 'button', text: 'Back to the example model', onclick: () => { trained = null; lastTrain = null; model = defaultModel(); store.set('acs-flat-model-v1', null); renderModelInfo(); schedule(); } }) : null,
      status), ta);
  }

  // ---------------------------------------------------------------- run
  function priceFor(k0) {
    if (dataset.price && dataset.price.length) return dataset.price;
    const d0 = dataset.grid.t[k0], out = [];
    for (let q = -96; q < 192; q++) { const hh = ((q / 4) % 24 + 24) % 24, i = Math.floor(hh), f = hh - i; out.push({ t: d0 + q * 15 * MIN, v: AUTUMN[i] + (AUTUMN[(i + 1) % 24] - AUTUMN[i]) * f }); }
    return out;
  }
  function baseSpec() {
    if (baseKind === 'recorded') return Object.fromEntries(AC_ZONES.map(z => [z, { kind: 'recorded' }]));
    return Object.fromEntries(AC_ZONES.map(z => [z, { kind: 'blueprint', P: baseKind === 'pinned' && pinned ? Object.assign({}, BLUEPRINT_DEFAULTS, pinned[z]) : Object.assign({}, units[z], { use_near: false }) }]));
  }
  function run() {
    const g = dataset.grid, k0 = +$('f-day').value || dataset.days[dataset.days.length - 1];
    const price = priceFor(k0);
    RES = simulateDay(model, g, k0, { units: Object.fromEntries(AC_ZONES.map(z => [z, { kind: 'blueprint', P: units[z] }])), heater, price });
    BRES = simulateDay(model, g, k0, { units: baseSpec(), heater: baseKind === 'recorded' ? { kind: 'recorded' } : heater, price });
    RANGE = { start: RES.rows[0].t, end: RES.rows[RES.rows.length - 1].t + MIN };
  }
  function schedule() { if (pending || !active || !dataset) return; pending = true; requestAnimationFrame(() => { pending = false; if (!active) return; run(); render(); }); }

  function render() { renderTabs(); renderCompare(); renderTiles(); renderCharts(); renderYaml(); }
  function renderTabs() {
    for (const b of document.querySelectorAll('#f-units button')) b.setAttribute('aria-selected', b.dataset.unit === unit ? 'true' : 'false');
  }
  function renderCompare() {
    const w = $('f-basewhat'); w.textContent = '';
    w.append('Grey lines show ', h('b', { text: baseKind === 'recorded' ? (dataset.kind === 'example' ? 'what the example units did' : 'what your units really did that day')
      : baseKind === 'pinned' && pinned ? 'the settings pinned ' + (pinned._at || '') : 'the same settings with the falling-price hold switched off' }), ', run through the same model.');
    $('f-unpin').disabled = !pinned;
  }
  function renderTiles() {
    const box = $('f-tiles'); box.textContent = '';
    const T = s => document.createTextNode(s);
    const acIdx = AC_ZONES.map(z => ZONE_IDS.indexOf(z));
    const coldest = r => { let best = Infinity, who = ''; for (const i of acIdx) if (r.minT[i] < best) { best = r.minT[i]; who = LABEL[ZONE_IDS[i]]; } return [best, who]; };
    const [cMin, cWho] = coldest(RES), [bMin] = coldest(BRES);
    box.append(
      tile('Units’ electricity cost', '€' + RES.cost.toFixed(2), '', [[delta(RES.cost, BRES.cost, 2, ' €', true)], [T('baseline €' + BRES.cost.toFixed(2))]]),
      tile('Average price paid', RES.avgPrice === null ? '–' : RES.avgPrice.toFixed(3), '€/kWh', [[delta(RES.avgPrice, BRES.avgPrice, 3, '', true)], [T('baseline ' + fmt(BRES.avgPrice, 3))]]),
      tile('Units’ energy', RES.energy.toFixed(1), 'kWh', [[delta(RES.energy, BRES.energy, 1, ' kWh', true)], [T('baseline ' + BRES.energy.toFixed(1) + ' kWh')], [T('bath heater ' + RES.heaterEnergy.toFixed(1) + ' kWh on top')]]),
      tile('Coldest room with a unit', cMin.toFixed(1), '°C', [[T(cWho)], [T('baseline ' + bMin.toFixed(1) + ' °C')]]),
    );
  }
  function renderCharts() {
    const rows = RES.rows, brows = BRES.rows, P = units[unit], night = { start: P.night_start, end: P.night_end };
    const g = dataset.grid, showMeasured = dataset.kind === 'export';
    const measured = zi => { const out = []; for (let k = rows[0].k; k <= rows[rows.length - 1].k + 1 && k < g.K; k++) out.push({ t: g.t[k], v: g.T[zi][k] }); return out; };
    GEO = [];
    const zbox = $('f-zones');
    if (!zbox.childElementCount) for (const z of ZONE_IDS) zbox.append(h('div', { class: 'card', id: 'f-card-' + z, tabindex: 0, 'aria-label': LABEL[z] + ' over the day' },
      h('div', { class: 'card-head' }, h('h2', { text: LABEL[z] }), h('div', { class: 'legend', id: 'f-leg-' + z })),
      svgEl('svg', { class: 'chart', id: 'f-ch-' + z, role: 'img', 'aria-label': LABEL[z] + ' temperature' })));
    ZONE_IDS.forEach((z, zi) => {
      const a = AC_ZONES.indexOf(z), meas = showMeasured ? measured(zi) : [];
      const vals = rows.map(r => r.Ta[zi]).concat(meas.map(p => p.v));
      if (a >= 0) for (const r of rows.concat(brows)) if (r.unit[a].mode !== 'off') vals.push(r.unit[a].target);
      const yt = niceTicks(...extent(vals, 0.3), 4);
      const band = a >= 0 || z === 'bath' ? 30 : 0;
      const gz = frame($('f-ch-' + z), { height: band ? 210 : 170, yt, fmtY: v => v.toFixed(yt.step < 1 ? 1 : 0) + '°', band, range: RANGE, night });
      if (a >= 0) svgEl('path', { d: stepPath(brows, gz, r => r.unit[a].mode === 'off' ? null : r.unit[a].target), class: 'ln thin c-base' }, gz.svg);
      if (meas.length) svgEl('path', { d: linePath(meas, gz), class: 'ln thin c-room measured' }, gz.svg);
      svgEl('path', { d: linePath(every(rows, 5, r => r.Ta[zi]), gz), class: 'ln c-room' }, gz.svg);
      if (a >= 0) {
        svgEl('path', { d: stepPath(rows, gz, r => r.unit[a].target), class: 'ln thin c-target measured' }, gz.svg);
        svgEl('path', { d: stepPath(rows, gz, r => r.unit[a].mode === 'off' ? null : r.unit[a].target), class: 'ln c-target' }, gz.svg);
        strip(gz, rows, gz.pb + 14, 'c-target', r => r.unit[a].mode !== 'off');
        strip(gz, brows, gz.pb + 22, 'c-base', r => r.unit[a].mode !== 'off');
        stripLabel(gz, gz.pb + 19, 'runs'); stripLabel(gz, gz.pb + 27, 'base');
      } else if (z === 'bath') {
        strip(gz, rows, gz.pb + 14, 'c-target', r => r.heater > 0.05);
        strip(gz, brows, gz.pb + 22, 'c-base', r => r.heater > 0.05);
        stripLabel(gz, gz.pb + 19, 'heater'); stripLabel(gz, gz.pb + 27, 'base');
      }
      const items = [['c-room', 'Room (model)']];
      if (meas.length) items.push(['c-room', 'Measured', 'thin fade']);
      if (a >= 0) items.push(['c-target', 'Target (faint while off)'], ['c-base', 'Target, baseline', 'thin']);
      legend($('f-leg-' + z), items);
      GEO.push({ card: $('f-card-' + z), g: gz, dots: i => [[rows[i].Ta[zi], 'c-room']].concat(a >= 0 && rows[i].unit[a].mode !== 'off' ? [[rows[i].unit[a].target, 'c-target']] : []) });
    });
    // outdoor
    let yt = niceTicks(...extent(rows.map(r => r.tout), 0.5), 3);
    const gO = frame($('f-ch-outdoor'), { height: 130, yt, fmtY: v => v.toFixed(yt.step < 1 ? 1 : 0) + '°', range: RANGE, night });
    svgEl('path', { d: linePath(every(rows, 5, r => r.tout), gO), class: 'ln c-outdoor' }, gO.svg);
    GEO.push({ card: $('f-card-outdoor'), g: gO, dots: i => [[rows[i].tout, 'c-outdoor']] });
    // price, with the selected unit's windows and hold
    const a = AC_ZONES.indexOf(unit), x = r => r.unit[a].x || {};
    const pv = rows.map(r => r.price).concat(P.use_forward ? rows.map(r => x(r).fwdMean) : [], P.use_near ? rows.map(r => x(r).nearMean) : [], [P.price_cheap, P.price_expensive]);
    const ytp = niceTicks(...extent(pv, 0), 4);
    const gP = frame($('f-ch-price'), { height: 190, yt: ytp, fmtY: v => v.toFixed(ytp.step < 0.01 ? 3 : 2), range: RANGE, night });
    if (P.use_near) holdBands(gP, rows, r => r.unit[a].d);
    refLines(gP, ytp, P);
    if (P.use_forward) svgEl('path', { d: stepPath(rows, gP, r => x(r).fwdMean), class: 'ln thin c-forward' }, gP.svg);
    if (P.use_near) svgEl('path', { d: stepPath(rows, gP, r => x(r).nearMean), class: 'ln thin c-near' }, gP.svg);
    svgEl('path', { d: stepPath(rows, gP, r => r.price), class: 'ln c-price' }, gP.svg);
    const items = [['c-price', 'Price now']];
    if (P.use_forward) items.push(['c-forward', '⌀ next ' + P.forward_hours + ' h', 'thin']);
    if (P.use_near) { items.push(['c-near', '⌀ next ' + P.near_hours + ' h', 'thin']); items.push(['c-price', LABEL[unit] + ' holding', 'box fade']); }
    legend($('f-leg-price'), items);
    GEO.push({ card: $('f-card-price'), g: gP, dots: i => [[rows[i].price, 'c-price']] });
    // power
    const cur = quarterMeans(rows, r => r.pel), base = quarterMeans(brows, r => r.pel);
    const obs = [];
    if (showMeasured && dataset.pw.ok.some(v => v)) for (let k = rows[0].k; k <= rows[rows.length - 1].k && k < g.K; k++) obs.push({ t: g.t[k], v: dataset.pw.ok[k] ? Math.max(0, dataset.pw.obs[k]) : null });
    const ytw = niceTicks(0, Math.max(0.5, ...cur.concat(base).map(p => p.v), ...obs.map(p => p.v || 0)), 3);
    const gW = frame($('f-ch-power'), { height: 160, yt: ytw, fmtY: v => v.toFixed(ytw.step < 1 ? 1 : 0) + ' kW', range: RANGE, night });
    const dc = quarterPath(cur, gW);
    if (cur.length) svgEl('path', { d: dc + 'V' + gW.Y(0).toFixed(1) + 'H' + gW.X(cur[0].t).toFixed(1) + 'Z', class: 'area c-target' }, gW.svg);
    if (obs.length) svgEl('path', { d: linePath(obs, gW), class: 'ln thin c-forward measured' }, gW.svg);
    svgEl('path', { d: quarterPath(base, gW), class: 'ln thin c-base' }, gW.svg);
    svgEl('path', { d: dc, class: 'ln c-target' }, gW.svg);
    legend($('f-leg-power'), [['c-target', 'Current settings'], ['c-base', 'Baseline', 'thin']].concat(obs.length ? [['c-forward', 'Phase reading, other loads taken out', 'thin fade']] : []));
    GEO.push({ card: $('f-card-power'), g: gW });
    hv.bind();
    if (hv.idx !== null) hv.show(hv.idx);
  }
  function fillTip(i, tip) {
    const r = RES.rows[i], b = BRES.rows[i];
    tip.append(h('div', { class: 't', text: hhmm(r.t) }));
    ZONE_IDS.forEach((z, zi) => {
      const a = AC_ZONES.indexOf(z), u = a >= 0 ? r.unit[a] : null;
      tipRow(tip, 'c-room', LABEL[z], fmt(r.Ta[zi], 1) + ' °C' + (u ? (u.mode === 'off' ? ' · off' : ' → ' + fmt(u.target, 1) + ' ' + u.mode) : z === 'bath' && r.heater > 0.05 ? ' · heater on' : ''));
    });
    tipRow(tip, 'c-outdoor', 'Outdoor', fmt(r.tout, 1) + ' °C');
    tipRow(tip, 'c-price', 'Price now', fmt(r.price, 3));
    tipRow(tip, 'c-target', 'Units, power', r.pel.toFixed(2) + ' kW');
    tipRow(tip, 'c-base', 'Baseline', b.pel.toFixed(2) + ' kW');
    const a = AC_ZONES.indexOf(unit), d = r.unit[a].d;
    const why = d ? reasons(Object.assign({}, d, { mode: r.unit[a].mode }), units[unit]) : '';
    if (why) tip.append(h('div', { class: 'why', text: LABEL[unit] + ': ' + why }));
  }
  function renderYaml() {
    $('f-yaml').textContent = AC_ZONES.map(z => yamlFor(units[z], dataset.scale, LABEL[z] + (dataset.map.climate[z] ? ' (' + dataset.map.climate[z] + ')' : ''))).join('\n\n');
  }

  // ---------------------------------------------------------------- wiring
  const tabs = $('f-units');
  for (const z of AC_ZONES) tabs.append(h('button', { type: 'button', role: 'tab', 'data-unit': z, text: LABEL[z], onclick: () => { unit = z; writeForm(form, units[unit]); persist(); schedule(); } }));
  $('f-copyall').addEventListener('click', () => {
    for (const z of AC_ZONES) if (z !== unit) {
      const keep = {}; for (const m of ['heat', 'cool']) for (const [k] of AXIS) keep[m + '_' + k] = units[z][m + '_' + k];
      units[z] = Object.assign(clone(units[unit]), keep);
    }
    persist(); schedule();
  });
  $('f-file').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const msg = $('f-trainmsg'); msg.hidden = false; msg.className = 'notice'; msg.textContent = 'Reading ' + f.name + '…';
    readFile(f, t => setTimeout(() => loadExport(t, f.name), 0), m => { msg.className = 'notice err'; msg.textContent = m; });
    e.target.value = '';
  });
  $('f-train').addEventListener('click', doTrain);
  $('f-day').addEventListener('change', schedule);
  const bsel = $('f-base'); bsel.value = baseKind;
  bsel.addEventListener('change', () => { baseKind = bsel.value; if (baseKind === 'pinned' && !pinned) pin(); persist(); schedule(); });
  function pin() { pinned = Object.assign(clone(units), { _at: 'at ' + new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }); }
  $('f-pin').addEventListener('click', () => { pin(); baseKind = 'pinned'; bsel.value = 'pinned'; persist(); schedule(); });
  $('f-unpin').addEventListener('click', () => { pinned = null; if (baseKind === 'pinned') { baseKind = 'recorded'; bsel.value = baseKind; } persist(); schedule(); });
  const hk = $('f-heater'), hs = $('f-heater-set'), hw = $('f-heater-win');
  hk.value = heater.kind; hs.value = heater.set; hw.value = heater.windows;
  const syncHeater = () => { $('f-heater-thermo').hidden = heater.kind !== 'thermostat'; };
  hk.addEventListener('change', () => { heater.kind = hk.value; syncHeater(); persist(); schedule(); });
  hs.addEventListener('input', () => { if (isFinite(+hs.value)) { heater.set = +hs.value; persist(); schedule(); } });
  hw.addEventListener('change', () => { heater.windows = hw.value; persist(); schedule(); });
  syncHeater();
  $('f-copy').addEventListener('click', () => copyText($('f-yaml').textContent, $('f-yaml'), $('f-copied')));

  return {
    activate() {
      active = true;
      showMode(form, 'flat'); writeForm(form, units[unit]);
      if (!dataset) { useDataset(exampleDataset()); } else schedule();
      renderModelInfo();
    },
    deactivate() { active = false; hv.hide(); },
    input() { readForm(form, units[unit]); persist(); schedule(); },
    reset() { units[unit] = Object.assign({}, BLUEPRINT_DEFAULTS, SYNTHETIC_INSTANCES[unit]); writeForm(form, units[unit]); persist(); schedule(); },
    resize() { if (active && RES) renderCharts(); },
  };
}
