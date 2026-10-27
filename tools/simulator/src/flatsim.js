// One day of the whole apartment, minute by minute: the trained (or
// example) model, each unit either replaying what it really did or driven
// by its own blueprint instance, and the bath heater as recorded, off or on
// a thermostat.

import { dayContext, controller, stepAt } from './blueprint.js';
import { compile, advance, newState, substepsFor, estimateHidden, inputBuffer, hourWave, ZONE_IDS, AC_ZONES, WINDOW_ZONES, BATH } from './apartment.js';

const MIN = 60e3;

// "06:00-07:30, 19:00-21:30" -> [[360, 450], [1140, 1290]]
export function parseWindows(s) {
  return String(s || '').split(',').map(p => p.trim().match(/^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/)).filter(Boolean)
    .map(m => [+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]]);
}

// opts: { units: { office: { kind: 'recorded' } | { kind: 'blueprint', P } , ... },
//         heater: { kind: 'recorded' | 'off' | 'thermostat', set, windows, kw },
//         price: [{t, v}], hours: 24 }
export function simulateDay(model, grid, k0, opts) {
  const m = compile(model), n = m.n, nA = AC_ZONES.length;
  const hidden = estimateHidden(m, grid, 0, k0);
  const Ta0 = Float64Array.from(ZONE_IDS, (z, i) => isFinite(grid.T[i][k0]) ? grid.T[i][k0] : 20);
  const S = newState(m, Ta0, hidden.subarray(k0 * 2 * n, (k0 + 1) * 2 * n));
  const t0 = grid.t[k0], minutes = Math.round((opts.hours || 24) * 60);
  const kEnd = Math.min(grid.K - 1, k0 + Math.round(minutes / grid.stepMin));
  const t1 = Math.min(t0 + minutes * MIN, grid.t[kEnd]);
  const price = opts.price && opts.price.length ? opts.price : grid.price;
  const ctx = dayContext(price, grid.outdoorSeries, t0, t1);
  const ctl = {};
  for (const z of AC_ZONES) {
    const u = opts.units[z];
    if (u && u.kind === 'blueprint') ctl[z] = controller(u.P, t0);
  }
  const heater = opts.heater || { kind: 'recorded' };
  const hw = heater.kind === 'thermostat' ? parseWindows(heater.windows) : [];
  const hkw = heater.kw || Math.max(1, ...Array.from(grid.heater).filter(isFinite)) || 2;
  let heaterOn = false;
  const sub = substepsFor(m, 1 / 60), dt = 1 / 60 / sub;
  const u = inputBuffer(m), Q = new Float64Array(nA);
  const rows = [];
  let energy = 0, cost = 0, hEnergy = 0, hCost = 0;
  for (let t = t0; t < t1; t += MIN) {
    const f = (t - t0) / (grid.step), k = Math.min(kEnd - 1, k0 + Math.floor(f)), w = f - Math.floor(f);
    const lerp = a => isFinite(a[k + 1]) ? a[k] + (a[k + 1] - a[k]) * w : a[k];
    u.tout = lerp(grid.tout);
    for (let i = 0; i < u.open.length; i++) u.open[i] = grid.open[i][k];
    u.sol.D = lerp(grid.sol.D); u.sol.E = lerp(grid.sol.E); u.sol.S = lerp(grid.sol.S); u.sol.W = lerp(grid.sol.W);
    [u.hc, u.hs] = hourWave(t);
    const p = stepAt(price, t);
    const unit = [];
    for (let a = 0; a < nA; a++) {
      const z = AC_ZONES[a], zi = ZONE_IDS.indexOf(z), spec = opts.units[z] || { kind: 'recorded' };
      if (spec.kind === 'blueprint') {
        const x = ctx.at(spec.P, t);
        x.indoor = Math.round(S[zi] * 10) / 10;
        const wi = WINDOW_ZONES.indexOf(z);
        x.windowOpen = wi >= 0 && u.open[wi] > 0;
        const d = ctl[z].step(t, x);
        u.mode[a] = ctl[z].mode === 'heat' ? 1 : ctl[z].mode === 'cool' ? 2 : 0;
        u.set[a] = ctl[z].setpoint ?? 20;
        unit.push({ mode: ctl[z].mode, target: d.target, setpoint: ctl[z].setpoint, d, x });
      } else {
        u.mode[a] = grid.mode[a][k]; u.set[a] = grid.set[a][k];
        unit.push({ mode: ['off', 'heat', 'cool', 'auto'][u.mode[a]], target: isFinite(u.set[a]) ? u.set[a] : null, setpoint: u.set[a], d: null });
      }
    }
    if (heater.kind === 'recorded') u.heater = grid.heater[k];
    else if (heater.kind === 'off') u.heater = 0;
    else {
      const dd = new Date(t), mm = dd.getHours() * 60 + dd.getMinutes();
      const inWin = hw.some(([a, b]) => a <= b ? (mm >= a && mm < b) : (mm >= a || mm < b));
      heaterOn = inWin && (heaterOn ? S[BATH] < heater.set + 0.5 : S[BATH] < heater.set);
      u.heater = heaterOn ? hkw : 0;
    }
    let pel = 0; const qs = new Float64Array(nA);
    for (let s = 0; s < sub; s++) { pel += advance(m, S, u, dt, Q) / sub; for (let a = 0; a < nA; a++) qs[a] += Q[a] / sub; }
    energy += pel / 60; hEnergy += u.heater / 60;
    if (p !== null) { cost += pel / 60 * p; hCost += u.heater / 60 * p; }
    for (let a = 0; a < nA; a++) unit[a].Q = qs[a];
    rows.push({ t, Ta: Float64Array.from(S.subarray(0, n)), unit, heater: u.heater, pel, price: p, tout: u.tout, open: Array.from(u.open), k });
  }
  const minT = ZONE_IDS.map((z, i) => Math.min(...rows.map(r => r.Ta[i])));
  const maxT = ZONE_IDS.map((z, i) => Math.max(...rows.map(r => r.Ta[i])));
  return { rows, energy, cost, avgPrice: energy > 0 ? cost / energy : null, heaterEnergy: hEnergy, heaterCost: hCost, minT, maxT, intervalMin: ctx.intervalMin, ctx };
}
