// One schema drives the parameter form, the YAML export and stored settings.
// The same form edits the single room's settings or, in apartment mode, the
// settings of whichever unit's tab is selected.
import { $ } from './util.js';

export const AXIS = [['charge', 'Charge'], ['comfort', 'Comfort'], ['coast', 'Coast']];
export const SCHEMA = [
  { group: 'Comfort axis', open: true, items: [{ type: 'axis' }] },
  { group: 'Price', open: true, items: [
    { key: 'price_cheap', label: 'Cheap price', unit: '€/kWh', step: 0.01, min: 0, max: 5, sub: 'At or below this, power counts as fully cheap.' },
    { key: 'price_expensive', label: 'Expensive price', unit: '€/kWh', step: 0.01, min: 0, max: 5 },
    { type: 'sep' },
    { key: 'use_forward', label: 'Forward Average Price Sensor', type: 'check' },
    { key: 'forward_hours', label: 'Its window', unit: 'h', step: 1, min: 1, max: 12, dep: 'use_forward', sub: 'Which ⌀ Price Next Nh sensor it is.' },
    { key: 'price_lookahead_margin', label: 'Forward Price Margin', type: 'range', step: 0.01, min: 0.02, max: 1, dep: 'use_forward' },
    { type: 'sep' },
    { key: 'use_near', label: 'Near-Term Average Price Sensor', type: 'check' },
    { key: 'near_hours', label: 'Its window', unit: 'h', step: 1, min: 1, max: 4, dep: 'use_near', sub: 'Price Next 1h or 2h; short, so it asks whether the price is still going down.' },
    { key: 'price_falling_margin', label: 'Falling Price Margin', type: 'range', step: 0.01, min: 0.02, max: 0.5, dep: 'use_near' },
    { key: 'price_falling_hold', label: 'Hold While Falling', type: 'range', step: 0.1, min: 0, max: 1, dep: 'use_near', sub: '0 waits at comfort, 1 waits at coast.' },
  ] },
  { group: 'Demand', items: [
    { key: 'use_demand', label: 'Forward Outdoor Mean helper', type: 'check' },
    { key: 'demand_lookahead_hours', label: 'Demand Lookahead', unit: 'h', step: 1, min: 1, max: 24, dep: 'use_demand' },
    { key: 'demand_cold_ref', label: 'Full Heating Demand Below', unit: '°C', step: 1, min: -25, max: 20, dep: 'use_demand' },
    { key: 'demand_hot_ref', label: 'Full Cooling Demand Above', unit: '°C', step: 1, min: 20, max: 45, dep: 'use_demand' },
  ] },
  { group: 'Day type & schedule', items: [
    { key: 'cool_day_threshold', label: 'Cooling Day Threshold', unit: '°C', step: 0.5, min: 10, max: 35 },
    { key: 'heat_day_threshold', label: 'Heating Day Threshold', unit: '°C', step: 0.5, min: 0, max: 30 },
    { key: 'heating_reference', label: 'Heating Day Reference', type: 'select', options: [['average', 'Average'], ['low', 'Forecast low'], ['high', 'Forecast high']] },
    { key: 'forecast_high', label: 'Forecast high', unit: '°C', step: 0.5, min: -40, max: 50, blank: true, sub: 'Empty takes the day\'s measured maximum.' },
    { key: 'forecast_low', label: 'Forecast low', unit: '°C', step: 0.5, min: -40, max: 50, blank: true },
    { type: 'sep' },
    { key: 'night_start', label: 'Night Mode Start', type: 'time' },
    { key: 'night_end', label: 'Night Mode End', type: 'time' },
    { key: 'storage_overrides_schedule', label: 'Charge Outside Normal Hours', type: 'check' },
  ] },
  { group: 'Rooms & timing', items: [
    { key: 'use_indoor', label: 'Indoor Temperature Sensors', type: 'check', sub: 'Gates the device on the simulated room temperature.' },
    { key: 'indoor_deadband', label: 'Indoor Deadband', unit: 'K', step: 0.1, min: 0.2, max: 5, dep: 'use_indoor' },
    { key: 'use_windows', label: 'Door/Window Sensors', type: 'check', mode: 'flat', sub: 'An open balcony door or window switches the unit off.' },
    { key: 'min_running_minutes', label: 'Minimum Running Time', unit: 'min', step: 1, min: 0, max: 30 },
    { key: 'min_idle_minutes', label: 'Minimum Idle Time', unit: 'min', step: 1, min: 0, max: 30 },
  ] },
  { group: 'Room model', mode: 'room', items: [
    { type: 'hint', text: 'Not blueprint inputs. A rough stand-in for your building, used to estimate when energy is bought.' },
    { key: 'model_loss_w_per_k', label: 'Heat loss', unit: 'W/K', step: 10, min: 10, max: 1000, sub: 'Heat flow per kelvin between room and outside.' },
    { key: 'model_capacity_kwh_per_k', label: 'Heat capacity', unit: 'kWh/K', step: 0.5, min: 0.5, max: 50, sub: 'Energy to warm the zone by one kelvin.' },
    { key: 'model_max_kw', label: 'Max output', unit: 'kW', step: 0.1, min: 0.5, max: 20, sub: 'Heating or cooling output at full speed.' },
    { key: 'model_cop', label: 'COP at 21 °C in / 7 °C out', unit: '', step: 0.1, min: 1, max: 7, sub: 'Falls as the gap between inside and outside grows.' },
    { key: 'model_start_temp', label: 'Room at 00:00', unit: '°C', step: 0.5, min: 5, max: 35, blank: true, sub: 'Empty uses the measured room temperature, else heating comfort.' },
  ] },
];
const BLANK = new Set(['forecast_high', 'forecast_low', 'model_start_temp']);

export function buildForm(form) {
  form.textContent = '';
  for (const g of SCHEMA) {
    const det = document.createElement('details'); det.className = 'group'; det.open = !!g.open;
    if (g.mode) det.dataset.mode = g.mode;
    const sum = document.createElement('summary'); sum.textContent = g.group; det.appendChild(sum);
    const body = document.createElement('div'); body.className = 'body'; det.appendChild(body);
    for (const it of g.items) body.appendChild(control(it));
    form.appendChild(det);
  }
}
function control(it) {
  if (it.type === 'sep') { const d = document.createElement('div'); d.className = 'sep'; return d; }
  if (it.type === 'hint') { const p = document.createElement('p'); p.className = 'hint'; p.textContent = it.text; return p; }
  if (it.type === 'axis') {
    const g = document.createElement('div'); g.className = 'axis-grid';
    const cell = (t, cls) => { const s = document.createElement('span'); s.className = cls || ''; s.textContent = t; g.appendChild(s); };
    cell('', 'h'); cell('Heating', 'h'); cell('Cooling', 'h');
    for (const [k, name] of AXIS) {
      cell(name);
      for (const mode of ['heat', 'cool']) {
        const inp = document.createElement('input'); inp.type = 'number'; inp.step = '0.5'; inp.min = '12'; inp.max = '32';
        inp.id = 'p-' + mode + '_' + k; inp.dataset.key = mode + '_' + k;
        inp.setAttribute('aria-label', (mode === 'heat' ? 'Heating ' : 'Cooling ') + name + ' in °C');
        g.appendChild(inp);
      }
    }
    const wrap = document.createElement('div');
    wrap.appendChild(g);
    const p = document.createElement('p'); p.className = 'hint'; p.style.marginTop = '6px';
    p.textContent = 'Comfort at a neutral price, charge while power is cheap, coast while it is dear (°C).';
    wrap.appendChild(p);
    return wrap;
  }
  const f = document.createElement('div'); f.className = 'field'; f.dataset.dep = it.dep || '';
  if (it.mode) f.dataset.mode = it.mode;
  const id = 'p-' + it.key;
  if (it.type === 'check') {
    const l = document.createElement('label'); l.className = 'toggle'; l.htmlFor = id;
    const c = document.createElement('input'); c.type = 'checkbox'; c.id = id; c.dataset.key = it.key;
    l.appendChild(c); l.appendChild(document.createTextNode(it.label));
    f.appendChild(l);
  } else {
    const l = document.createElement('label'); l.htmlFor = id; l.textContent = it.label; f.appendChild(l);
    if (it.type === 'range') {
      const out = document.createElement('output'); out.id = id + '-o'; out.htmlFor = id;
      f.appendChild(document.createElement('span'));
      const s = document.createElement('div'); s.className = 'slider';
      const r = document.createElement('input'); r.type = 'range'; r.id = id; r.dataset.key = it.key;
      r.min = it.min; r.max = it.max; r.step = it.step;
      s.appendChild(r); s.appendChild(out); f.appendChild(s);
    } else if (it.type === 'select') {
      const sel = document.createElement('select'); sel.id = id; sel.dataset.key = it.key;
      for (const [v, t] of it.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
      f.appendChild(sel);
    } else {
      const n = document.createElement('span'); n.className = 'num';
      const i = document.createElement('input'); i.id = id; i.dataset.key = it.key;
      i.type = it.type === 'time' ? 'time' : 'number';
      if (i.type === 'number') { i.step = it.step; i.min = it.min; i.max = it.max; if (it.blank) i.placeholder = 'auto'; }
      n.appendChild(i);
      if (it.type !== 'time') { const u = document.createElement('span'); u.className = 'unit'; u.textContent = it.unit || ''; n.appendChild(u); }
      f.appendChild(n);
    }
  }
  if (it.sub) { const s = document.createElement('div'); s.className = 'sub'; s.textContent = it.sub; f.appendChild(s); }
  return f;
}
export function writeForm(form, P) {
  for (const el of form.querySelectorAll('[data-key]')) {
    const k = el.dataset.key, v = P[k];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = (v === null || v === undefined) ? '' : v;
    const o = $(el.id + '-o'); if (o) o.textContent = Number(v).toFixed(2);
  }
  syncDeps(form, P);
}
export function readForm(form, P) {
  for (const el of form.querySelectorAll('[data-key]')) {
    const k = el.dataset.key;
    if (el.type === 'checkbox') P[k] = el.checked;
    else if (el.type === 'number' || el.type === 'range') {
      if (el.value === '' && BLANK.has(k)) P[k] = null;
      else if (el.value !== '' && isFinite(+el.value)) P[k] = +el.value;
    } else P[k] = el.value;
    const o = $(el.id + '-o'); if (o) o.textContent = Number(P[k]).toFixed(2);
  }
  syncDeps(form, P);
}
function syncDeps(form, P) {
  for (const f of form.querySelectorAll('.field[data-dep]')) {
    const dep = f.dataset.dep; if (!dep) continue;
    const on = !!P[dep];
    f.classList.toggle('off', !on);
    for (const i of f.querySelectorAll('input,select')) i.disabled = !on;
  }
}
export function showMode(form, mode) {
  for (const e of form.querySelectorAll('[data-mode]')) e.hidden = e.dataset.mode !== mode;
}

// The settings as blueprint inputs; scale 100 when the price sensor reports ct/kWh.
export function yamlFor(P, scale, title) {
  const n = v => +(+v).toFixed(4), sc = scale === 100 ? 100 : 1;
  const L = [title ? '# ' + title : '# Adaptive Climate Setpoint inputs, from the simulator'];
  for (const m of ['heat', 'cool']) for (const [k] of AXIS) L.push(m + '_' + k + ': ' + n(P[m + '_' + k]));
  L.push('price_cheap: ' + n(P.price_cheap * sc) + (sc === 100 ? '   # ct/kWh, like your sensor' : ''));
  L.push('price_expensive: ' + n(P.price_expensive * sc));
  if (P.use_forward) { L.push('price_forecast_sensor: sensor.REPLACE_price_next_' + P.forward_hours + 'h'); L.push('price_lookahead_margin: ' + n(P.price_lookahead_margin)); }
  else L.push('price_forecast_sensor: []');
  if (P.use_near) {
    L.push('price_near_sensor: sensor.REPLACE_price_next_' + P.near_hours + 'h');
    L.push('price_falling_margin: ' + n(P.price_falling_margin));
    L.push('price_falling_hold: ' + n(P.price_falling_hold));
  } else L.push('price_near_sensor: []');
  if (P.use_demand) {
    L.push('demand_lookahead_hours: ' + n(P.demand_lookahead_hours));
    L.push('demand_cold_ref: ' + n(P.demand_cold_ref));
    L.push('demand_hot_ref: ' + n(P.demand_hot_ref));
  } else L.push('forward_outdoor_helper: []');
  L.push('cool_day_threshold: ' + n(P.cool_day_threshold));
  L.push('heat_day_threshold: ' + n(P.heat_day_threshold));
  L.push('heating_reference: ' + P.heating_reference);
  L.push('night_start: "' + P.night_start + ':00"');
  L.push('night_end: "' + P.night_end + ':00"');
  L.push('storage_overrides_schedule: ' + !!P.storage_overrides_schedule);
  if (P.use_indoor) L.push('indoor_deadband: ' + n(P.indoor_deadband)); else L.push('indoor_sensors: []');
  L.push('min_running_minutes: ' + n(P.min_running_minutes));
  L.push('min_idle_minutes: ' + n(P.min_idle_minutes));
  return L.join('\n');
}
