// Made-up apartment data in the exact format ha_export_snippet.js writes.
// It drives a known model with three blueprint instances, a bath heater on
// a thermostat, window airing, cooking and car charging, then measures it
// the way Home Assistant would (quantised thermometers, 5-minute means,
// state changes only). Used by the tests and for the simulator's examples.

import { BLUEPRINT_DEFAULTS, dayContext, controller } from './blueprint.js';
import { defaultModel, compile, advance, newState, substepsFor, hourWave, ZONE_IDS, AC_ZONES, WINDOW_ZONES } from './apartment.js';
import { irradiance } from './solar.js';

const MIN = 60e3, HOUR = 3600e3;

export function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  next.normal = () => { const u = Math.max(1e-12, next()), v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  return next;
}

export const SYNTHETIC_INSTANCES = {
  office: { heat_comfort: 21, heat_charge: 23, heat_coast: 19.5 },
  bedroom: { heat_comfort: 19.5, heat_charge: 21, heat_coast: 18 },
  living: { heat_comfort: 21.5, heat_charge: 23.5, heat_coast: 20 },
};

const NAMES = {
  office: ['buero', 'Büro'], bedroom: ['schlafzimmer', 'Schlafzimmer'], living: ['wohnzimmer', 'Wohnzimmer'],
  bath: ['bad', 'Bad'], hall: ['flur', 'Flur'],
};

// opts: { days, start (local midnight ms), seed, model, lat, lon, meanOutdoor, instances }
export function syntheticRun(opts = {}) {
  const days = opts.days || 14, R = rng(opts.seed || 1);
  const lat = opts.lat ?? 49.5, lon = opts.lon ?? 8.5;
  const start = opts.start ?? new Date(2026, 9, 6).getTime();
  const end = start + days * 24 * HOUR;
  const model = opts.model || defaultModel();
  const m = compile(model), sub = substepsFor(m, 1 / 60);

  // weather: hourly cloud as a Markov chain, outdoor temperature following it
  const hours = days * 24 + 48;
  const cloud = [], base = [];
  let c = 0.6, lvl = opts.meanOutdoor ?? 7;
  for (let h = 0; h < hours; h++) {
    if (R() < 0.15) c = Math.min(1, Math.max(0, c + (R() - 0.5) * 0.9));
    if (h % 24 === 0) lvl += R.normal() * 1.5 - (lvl - (opts.meanOutdoor ?? 7)) * 0.3;
    cloud.push(c); base.push(lvl);
  }
  const tAt = t => { const h = (t - start) / HOUR; return Math.max(0, Math.min(hours - 1, Math.floor(h))); };
  const outdoorTrue = t => {
    const h = tAt(t), hod = new Date(t).getHours() + new Date(t).getMinutes() / 60;
    const amp = 2 + 3.5 * (1 - cloud[h]);
    // the day's level drifts smoothly from one midday to the next
    const x = (t - start) / HOUR - 12, d0 = Math.floor(x / 24), f = x / 24 - d0;
    const lv = i => base[Math.max(0, Math.min(hours - 1, i * 24))];
    return lv(d0) + (lv(d0 + 1) - lv(d0)) * f + amp * Math.cos((hod - 15) / 24 * 2 * Math.PI);
  };

  // prices: two peaks, a night dip and a solar dip that depends on the clouds
  const price = [];
  for (let t = start - 24 * HOUR; t < end + 48 * HOUR; t += 15 * MIN) {
    const d = new Date(t), hod = d.getHours() + d.getMinutes() / 60, day = Math.floor((t - start) / (24 * HOUR));
    const level = 0.27 + 0.03 * Math.sin(day * 1.7);
    const g = (mu, s) => Math.exp(-0.5 * ((hod - mu) / s) ** 2);
    const cl = cloud[Math.max(0, Math.min(hours - 1, tAt(start + day * 24 * HOUR + 13 * HOUR)))];
    price.push({ t, v: +(level + 0.07 * g(8, 1.3) + 0.11 * g(18.7, 1.6) - 0.03 * g(3, 2) - 0.09 * (1 - cl) * g(13, 2.2) + 0.004 * R.normal()).toFixed(4) });
  }
  const outdoorSeries = [];
  for (let t = start - 24 * HOUR; t < end + 48 * HOUR; t += 10 * MIN) outdoorSeries.push({ t, v: outdoorTrue(t) });
  const ctx = dayContext(price, outdoorSeries, start, end);

  // what happens in the flat each day
  const plan = [];
  for (let d = 0; d < days; d++) {
    const weekday = new Date(start + d * 24 * HOUR).getDay();
    plan.push({
      airing: { office: R() < 0.8 ? 7.5 + R() * 0.5 : null, bedroom: R() < 0.9 ? 7 + R() * 0.5 : null, living: R() < 0.5 ? 12 + R() : null },
      airingLen: { office: 8 + R() * 6, bedroom: 10 + R() * 10, living: 8 + R() * 10 },
      cook: R() < 0.8 ? 18.2 + R() * 0.8 : null, lunch: weekday === 0 || weekday === 6 ? 12.3 : null,
      car: R() < 0.3 ? 19 + R() * 2 : null, carLen: 2 + R() * 2,
      work: weekday >= 1 && weekday <= 5,
    });
  }

  const inst = Object.fromEntries(AC_ZONES.map(z => [z, Object.assign({}, BLUEPRINT_DEFAULTS, (opts.instances || SYNTHETIC_INSTANCES)[z] || {})]));
  const ctl = Object.fromEntries(AC_ZONES.map(z => [z, controller(inst[z], start)]));
  const S = newState(m, ZONE_IDS.map(z => z === 'bedroom' ? 19.5 : z === 'bath' ? 21 : 20.5));
  const T = S; // the first n entries are the air temperatures
  // opts.realism adds what the trained model does not know about: units that
  // cycle on and off at low load, and people warming the rooms they are in
  // on a schedule rather than a smooth daily wave
  const real = opts.realism === true ? { cycle: 1, people: 1 } : (opts.realism || {}), n = m.n;
  const cycling = new Uint8Array(AC_ZONES.length);
  const u = { tout: 0, open: new Float64Array(WINDOW_ZONES.length), sol: null, heater: 0, mode: new Int8Array(AC_ZONES.length), set: new Float64Array(AC_ZONES.length) };
  const Q = new Float64Array(AC_ZONES.length);
  let heaterOn = false;
  const rec = { t: [], T: [], tout: [], open: [], heater: [], mode: [], set: [], Q: [], pel: [], cloud: [], L1: [], L2: [], L3: [], car: [] };

  for (let t = start; t < end; t += MIN) {
    const d = Math.floor((t - start) / (24 * HOUR)), dp = plan[d], dt = new Date(t), hod = dt.getHours() + dt.getMinutes() / 60;
    const open = WINDOW_ZONES.map(z => dp.airing[z] !== null && hod >= dp.airing[z] && hod < dp.airing[z] + dp.airingLen[z] / 60 ? 1 : 0);
    // the three blueprint instances, each reading its own room
    for (let a = 0; a < AC_ZONES.length; a++) {
      const z = AC_ZONES[a], zi = ZONE_IDS.indexOf(z), x = ctx.at(inst[z], t);
      x.indoor = Math.round(T[zi] * 10) / 10;
      x.windowOpen = open[WINDOW_ZONES.indexOf(z)] > 0;
      ctl[z].step(t, x);
      u.mode[a] = ctl[z].mode === 'heat' ? 1 : ctl[z].mode === 'cool' ? 2 : 0;
      u.set[a] = ctl[z].setpoint ?? 20;
      if (real.cycle && u.mode[a] === 1) {
        const sensed = T[zi] + m.off[a], dem = m.Kp[a] * (u.set[a] - sensed), floor = 0.35 * m.Qmax[a];
        if (dem < floor) {
          if (cycling[a] && sensed > u.set[a] + 0.5) cycling[a] = 0;
          else if (!cycling[a] && sensed < u.set[a] - 0.3) cycling[a] = 1;
          u.set[a] = cycling[a] ? sensed + floor / m.Kp[a] : sensed - 1;
        } else cycling[a] = 1;
      }
    }
    // bath heater on its own thermostat in the morning and evening
    const bathTime = (hod >= 6 && hod < 7.5) || (hod >= 19 && hod < 21.5);
    const tb = T[ZONE_IDS.indexOf('bath')];
    heaterOn = bathTime && (heaterOn ? tb < 23 : tb < 22.5);
    u.heater = heaterOn ? 2.0 : 0;
    u.tout = outdoorTrue(t);
    [u.hc, u.hs] = hourWave(t);
    const h = tAt(t);
    u.sol = irradiance(t + 30e3, lat, lon, cloud[h]);
    for (let w = 0; w < open.length; w++) u.open[w] = open[w];
    // cooking warms the kitchen; nothing in the model knows about it
    const cooking = (dp.cook !== null && hod >= dp.cook && hod < dp.cook + 0.6) || (dp.lunch !== null && hod >= dp.lunch && hod < dp.lunch + 0.5);
    const Tl = ZONE_IDS.indexOf('living');
    let pel = 0;
    for (let i = 0; i < sub; i++) pel += advance(m, S, u, 1 / 60 / sub, Q) / sub;
    if (cooking) S[Tl] += 0.6 * (1 / 60) / m.Ca[Tl];
    if (real.people) {
      const night = hod < 7 || hod >= 23, people = { bedroom: night ? 0.12 : 0, office: dp.work && hod >= 8.5 && hod < 17.5 ? 0.1 : 0, living: !night && hod >= 17 ? 0.15 : 0.03 };
      for (const z in people) { const zi = ZONE_IDS.indexOf(z); S[zi] += people[z] / 60 / m.Ca[zi]; }
    }
    const carKW = dp.car !== null && hod >= dp.car && hod < dp.car + dp.carLen ? 11 : 0;
    const office = 0.05 + (dp.work && hod >= 8.5 && hod < 17.5 ? 0.18 : 0) + 0.02 * R.normal();
    const stove = cooking ? 1.6 : 0;
    rec.t.push(t); rec.T.push(Array.from(S.subarray(0, m.n))); rec.tout.push(u.tout); rec.open.push(open); rec.heater.push(u.heater);
    rec.mode.push(Array.from(u.mode)); rec.set.push(Array.from(u.set)); rec.Q.push(Array.from(Q)); rec.pel.push(pel); rec.cloud.push(cloud[h]);
    rec.car.push(carKW);
    rec.L1.push(0.15 + 0.03 * R.normal() + stove * 0.5 + carKW / 3 + (hod > 18 && hod < 23 ? 0.1 : 0));
    rec.L2.push(pel + office + 0.04 + 0.015 * R.normal() + stove * 0.5 + carKW / 3);
    rec.L3.push(0.12 + 0.03 * R.normal() + carKW / 3);
  }
  return { rec, price, model, inst, lat, lon, start, end, R };
}

// Measure a run the way Home Assistant records it.
export function toExport(run) {
  const { rec, price, lat, lon, R } = run;
  const iso = t => new Date(t).toISOString();
  const meta = {}, s5 = {}, hist = {};
  const mean5 = (id, get) => {
    const rows = [];
    for (let i = 0; i + 5 <= rec.t.length; i += 5) { let a = 0; for (let j = i; j < i + 5; j++) a += get(j); rows.push([rec.t[i], +(a / 5).toFixed(3)]); }
    s5[id] = rows;
  };
  const q = (v, step) => Math.round(v / step) * step;
  ZONE_IDS.forEach((z, zi) => {
    const id = `sensor.${NAMES[z][0]}_temperatur`;
    meta[id] = { name: `${NAMES[z][1]} Temperatur`, device_class: 'temperature', unit: '°C', area: NAMES[z][1], device: 'dev_t_' + z };
    const bias = 0.05 * R.normal();
    mean5(id, j => q(rec.T[j][zi] + bias + 0.03 * R.normal(), 0.1));
  });
  meta['sensor.balkon_temperatur'] = { name: 'Balkon Temperatur', device_class: 'temperature', unit: '°C', area: null, device: 'dev_out' };
  mean5('sensor.balkon_temperatur', j => q(rec.tout[j] + 0.1 * R.normal(), 0.1));
  for (const [id, key] of [['sensor.phase_l1_leistung', 'L1'], ['sensor.phase_l2_leistung', 'L2'], ['sensor.phase_l3_leistung', 'L3']]) {
    meta[id] = { name: `Phase ${key} Leistung`, device_class: 'power', unit: 'W', area: null, device: 'dev_meter' };
    mean5(id, j => Math.max(0, rec[key][j]) * 1000);
  }
  meta['sensor.bad_heizluefter_leistung'] = { name: 'Bad Heizlüfter Leistung', device_class: 'power', unit: 'W', area: 'Bad', device: 'dev_plug' };
  mean5('sensor.bad_heizluefter_leistung', j => rec.heater[j] * 1000 + (rec.heater[j] ? 5 * R.normal() : 0));
  AC_ZONES.forEach((z, a) => {
    const id = `climate.${NAMES[z][0]}_klima`, zi = ZONE_IDS.indexOf(z);
    meta[id] = { name: `${NAMES[z][1]} Klima`, device_class: null, unit: null, area: NAMES[z][1], device: 'dev_ac_' + z, hvac_modes: ['off', 'heat', 'cool', 'dry', 'fan_only'], min_temp: 16, max_temp: 31, step: 0.5 };
    // the unit's own thermometer, which should not be taken for the room's
    const own = `sensor.${NAMES[z][0]}_klima_innentemperatur`;
    meta[own] = { name: `${NAMES[z][1]} Klima Innentemperatur`, device_class: 'temperature', unit: '°C', area: NAMES[z][1], device: 'dev_ac_' + z };
    mean5(own, j => q(rec.T[j][zi] + run.model.ac[z].off, 0.5));
    const rows = []; let last = '';
    for (let j = 0; j < rec.t.length; j++) {
      const mode = ['off', 'heat', 'cool'][rec.mode[j][a]] || 'off';
      const cur = q(rec.T[j][zi] + run.model.ac[z].off + 0.1 * R.normal(), 0.5);
      const action = mode === 'off' ? 'off' : Math.abs(rec.Q[j][a]) > 0.05 ? (mode === 'heat' ? 'heating' : 'cooling') : 'idle';
      const row = [mode, rec.set[j][a], cur, action];
      const key = row.join('|');
      if (key !== last) { rows.push([iso(rec.t[j] + 2000), mode, rec.set[j][a], cur, action, 'auto']); last = key; }
    }
    hist[id] = rows;
  });
  WINDOW_ZONES.forEach((z, w) => {
    const id = `binary_sensor.${NAMES[z][0]}_balkontuer`;
    meta[id] = { name: `${NAMES[z][1]} Balkontür`, device_class: 'door', unit: null, area: NAMES[z][1], device: 'dev_w_' + z };
    const rows = []; let last = null;
    for (let j = 0; j < rec.t.length; j++) { const s = rec.open[j][w] ? 'on' : 'off'; if (s !== last) { rows.push([iso(rec.t[j]), s]); last = s; } }
    hist[id] = rows;
  });
  meta['binary_sensor.wohnungstuer'] = { name: 'Wohnungstür', device_class: 'door', unit: null, area: 'Flur', device: 'dev_door' };
  hist['binary_sensor.wohnungstuer'] = [[iso(rec.t[0]), 'off']];
  meta['weather.forecast_home'] = { name: 'Forecast Home', device_class: null, unit: null, area: null };
  hist['weather.forecast_home'] = [];
  for (let j = 0; j < rec.t.length; j += 60) hist['weather.forecast_home'].push([iso(rec.t[j]), rec.cloud[j] > 0.7 ? 'cloudy' : 'partlycloudy', +rec.tout[j].toFixed(1), Math.round(rec.cloud[j] * 100)]);
  meta['sensor.zuhause_strompreis'] = { name: 'Zuhause Strompreis', device_class: 'monetary', unit: 'EUR/kWh', area: null, device: 'dev_tibber' };
  hist['sensor.zuhause_strompreis'] = price.map(p => [iso(p.t), p.v]);
  meta['sensor.zuhause_price_next_2h'] = { name: '⌀ Price Next 2h', device_class: 'monetary', unit: 'EUR/kWh', area: null, device: 'dev_tibber' };
  hist['sensor.zuhause_price_next_2h'] = price.slice(0, 20).map(p => [iso(p.t), p.v]);
  meta['person.felix'] = { name: 'Felix', device_class: null, unit: null, area: null };
  hist['person.felix'] = [[iso(rec.t[0]), 'home']];
  return { exported: iso(rec.t[rec.t.length - 1]), ha_version: 'synthetic', location: { lat: Math.round(lat * 10) / 10, lon: Math.round(lon * 10) / 10, tz: 'Europe/Berlin' },
    meta, stats_5min: s5, stats_hourly: {}, history: hist };
}
