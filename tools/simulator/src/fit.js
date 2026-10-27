// Training the apartment model on recorded data.
//
// The criterion is what the simulator needs the model for: starting from
// the measured temperatures, how well does it predict the next six hours of
// every room, given what the units, the heater, the windows, the sun and
// the weather did? Electricity on the units' phase is matched as well, with
// a robust loss so cooking and other loads on that phase do not drag the
// fit. Weak priors keep parameters plausible where the data says little,
// and the last days are held back to check the result.

import { defaultModel, compile, runRecorded, estimateHidden, zoneSummary, ZONE_IDS, AC_ZONES, WINDOW_ZONES, SOLAR } from './apartment.js';
import { carnotHeat } from './room.js';
import { solveSPD } from './linalg.js';

const MIN = 60e3;
export const FIT = { windowSteps: 72, strideSteps: 36, every: 3, sigmaT: 0.25, sigmaP: 0.3, huber: 1.5, maxIter: 30, burnInH: 36 };

// ---- parameters ---------------------------------------------------------------
function paramList(model) {
  const P = [];
  const add = (path, kind, sigma, floor) => P.push({ path, kind, sigma, floor: floor || 0 });
  for (const z of ZONE_IDS) {
    add(['zones', z, 'Ca'], 'log', 0.8); add(['zones', z, 'Cm'], 'log', 0.7); add(['zones', z, 'Cw'], 'log', 0.7);
    add(['zones', z, 'Ham'], 'log', 0.8); add(['zones', z, 'Hmw'], 'log', 0.8);
    add(['zones', z, 'Hwo'], 'log', 0.9, 0.001); add(['zones', z, 'Hwn'], 'log', 1.0, 0.001); add(['zones', z, 'H'], 'log', 1.0, 0.001);
    add(['zones', z, 'q'], 'log', 1.2, 0.005); add(['zones', z, 'qc'], 'lin', 0.05); add(['zones', z, 'qs'], 'lin', 0.05);
  }
  add(['building', 'Tnb'], 'lin', 2.0);
  for (const z of WINDOW_ZONES) add(['zones', z, 'Hw'], 'log', 1.2, 0.01);
  for (const z of ['office', 'bedroom', 'living', 'bath']) for (const f of SOLAR) add(['zones', z, 's' + f], 'log', 1.5, 0.05);
  for (const z of Object.keys(model.links)) add(['links', z], 'log', 0.9, 0.003);
  for (const z of AC_ZONES) { add(['ac', z, 'Kp'], 'log', 0.7); add(['ac', z, 'off'], 'lin', 1.0); add(['ac', z, 'Qmax'], 'log', 0.5); }
  add(['plant', 'Qmax'], 'log', 0.5); add(['plant', 'eta'], 'log', 0.15);
  // Standby is left at its preset: with other loads on the same phase that
  // run whenever the units do (an office PC), the data cannot tell them apart.
  return P;
}
const getPath = (o, p) => p.reduce((a, k) => a[k], o);
const setPath = (o, p, v) => { const last = p[p.length - 1]; p.slice(0, -1).reduce((a, k) => a[k], o)[last] = v; };
function toTheta(model, P) { return Float64Array.from(P, d => { const v = getPath(model, d.path); return d.kind === 'log' ? Math.log(Math.max(v, d.floor || 1e-6)) : v; }); }
function fromTheta(theta, P, base) {
  const m = JSON.parse(JSON.stringify(base));
  P.forEach((d, i) => setPath(m, d.path, d.kind === 'log' ? Math.exp(theta[i]) : theta[i]));
  return m;
}

// ---- what the data offers ----------------------------------------------------------
const quantile = (a, q) => { const s = a.filter(isFinite).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };
const median = a => quantile(a, 0.5);

export function powerObservation(grid) {
  const K = grid.K, obs = new Float64Array(K).fill(NaN), ok = new Uint8Array(K), carMask = new Uint8Array(K);
  const notes = [];
  if (!grid.phase || !grid.phase.some(isFinite)) return { obs, ok, carMask, base: null, notes: ['No phase power assigned: the fit cannot see electricity, so efficiency and output come from the priors.'] };
  const adj = Float64Array.from(grid.phase);
  if (grid.car) {
    for (let k = 0; k < K; k++) if (isFinite(grid.car[k])) adj[k] -= grid.car[k] / 3;
    notes.push('Car charging subtracted on the units\' phase (a third of the charger\'s power).');
  } else if (grid.others.length) {
    const p10 = grid.others.map(o => quantile(Array.from(o), 0.1)), pp = quantile(Array.from(grid.phase), 0.1);
    let n = 0;
    for (let k = 0; k < K; k++) {
      const allUp = grid.others.every((o, i) => o[k] - p10[i] > (grid.others.length > 1 ? 1.0 : 2.5));
      if (allUp && grid.phase[k] - pp > 1.0) { for (let j = Math.max(0, k - 3); j <= Math.min(K - 1, k + 3); j++) carMask[j] = 1; n++; }
    }
    if (n) notes.push(`${Math.round(n * grid.stepMin / 60)} h of what looks like three-phase charging left out of the power fit.`);
  }
  // other loads on the phase, by hour of day, from times with every unit off
  const byHour = Array.from({ length: 24 }, () => []), all = [];
  for (let k = 0; k < K; k++) {
    if (grid.unitsOn[k] || carMask[k] || !isFinite(adj[k])) continue;
    byHour[new Date(grid.t[k]).getHours()].push(adj[k]); all.push(adj[k]);
  }
  const overall = all.length ? median(all) : quantile(Array.from(adj), 0.1);
  const base = byHour.map(a => a.length >= 6 ? median(a) : overall);
  if (all.length < 72) notes.push('Few periods with all units off, so the other loads on that phase are only roughly known.');
  for (let k = 0; k < K; k++) {
    if (!isFinite(adj[k]) || carMask[k]) continue;
    obs[k] = adj[k] - base[new Date(grid.t[k]).getHours()]; ok[k] = 1;
  }
  return { obs, ok, carMask, base, notes };
}

export function splitDays(grid, valShare = 0.25) {
  const perDay = Math.round(24 * 60 / grid.stepMin), days = [];
  for (let k = 0; k + perDay <= grid.K; k++) {
    const d = new Date(grid.t[k]);
    if (d.getHours() !== 0 || d.getMinutes() !== 0) continue;
    let v = 0; for (let j = k; j < k + perDay; j++) v += grid.valid[j];
    if (v >= 0.95 * perDay) days.push(k);
  }
  if (days.length < 2) return { train: days, val: [], perDay };
  const nVal = Math.max(1, Math.round(days.length * valShare));
  return { train: days.slice(0, days.length - nVal), val: days.slice(days.length - nVal), perDay };
}

function windowsFor(grid, dayStarts, perDay) {
  const W = [], L = FIT.windowSteps, burn = Math.round(FIT.burnInH / grid.stepH);
  for (const d of dayStarts) for (let k0 = Math.max(d, burn); k0 + L <= d + perDay; k0 += FIT.strideSteps) {
    let ok = true; for (let j = k0; j <= Math.min(grid.K - 1, k0 + L); j++) if (!grid.valid[j]) { ok = false; break; }
    if (ok && k0 + L < grid.K) W.push(k0);
  }
  return W;
}

// Starting values: the default apartment, with each unit's sensor offset read
// from the data where the units report their own temperature.
export function initialModel(grid) {
  const model = defaultModel();
  AC_ZONES.forEach((z, a) => {
    const zi = ZONE_IDS.indexOf(z), d = [];
    for (let k = 0; k < grid.K; k++) if (grid.mode[a][k] && isFinite(grid.cur[a][k]) && isFinite(grid.T[zi][k])) d.push(grid.cur[a][k] - grid.T[zi][k]);
    if (d.length > 50) model.ac[z].off = Math.max(-3, Math.min(3, median(d)));
  });
  return model;
}

// ---- residuals --------------------------------------------------------------------
function makeProblem(grid, pw, windows, P, base, theta0) {
  const n = ZONE_IDS.length, L = FIT.windowSteps, e = FIT.every;
  const nT = windows.length * Math.floor(L / e) * n, nP = windows.length * Math.floor(L / e), nPr = P.length;
  const rows = nT + nP + nPr;
  const wP = new Float64Array(nP).fill(1);
  const T0 = new Float64Array(n), H0 = new Float64Array(2 * n);
  const kLast = Math.min(grid.K - 1, windows[windows.length - 1] + L);
  function residuals(theta, out) {
    const m = compile(fromTheta(theta, P, base));
    const hidden = estimateHidden(m, grid, 0, kLast);
    let i = 0, ip = nT;
    for (const k0 of windows) {
      for (let z = 0; z < n; z++) T0[z] = grid.T[z][k0];
      for (let j = 0; j < 2 * n; j++) H0[j] = hidden[k0 * 2 * n + j];
      const run = runRecorded(m, grid, k0, k0 + L, T0, H0);
      for (let j = e; j <= L; j += e) {
        const k = k0 + j;
        for (let z = 0; z < n; z++) { const v = grid.T[z][k]; out[i++] = isFinite(v) ? (run.T[j * n + z] - v) / FIT.sigmaT : 0; }
      }
      for (let j = 0; j + e <= L; j += e) {
        let ps = 0, po = 0, ok = true;
        for (let s = 0; s < e; s++) { const k = k0 + j + s; if (!pw.ok[k]) { ok = false; break; } ps += run.P[j + s]; po += pw.obs[k]; }
        const idx = ip - nT;
        out[ip++] = ok ? wP[idx] * (ps - po) / e / FIT.sigmaP : 0;
      }
    }
    for (let p = 0; p < nPr; p++) out[nT + nP + p] = (theta[p] - theta0[p]) / P[p].sigma;
    return out;
  }
  function updateWeights(r) {
    for (let idx = 0; idx < nP; idx++) {
      const raw = wP[idx] ? r[nT + idx] / wP[idx] : 0;
      const a = Math.abs(raw);
      wP[idx] = a <= FIT.huber ? 1 : Math.sqrt(FIT.huber / a);
    }
  }
  return { rows, nT, nP, residuals, updateWeights };
}

const tick = () => new Promise(r => setTimeout(r, 0));

async function levenberg(prob, theta0, P, onProgress) {
  const p = theta0.length, rows = prob.rows;
  let theta = Float64Array.from(theta0);
  let r = prob.residuals(theta, new Float64Array(rows));
  prob.updateWeights(r); r = prob.residuals(theta, r);
  let cost = dot(r, r), lambda = 1e-2;
  const J = new Float64Array(rows * p), rp = new Float64Array(rows);
  const history = [cost];
  for (let it = 0; it < FIT.maxIter; it++) {
    for (let c = 0; c < p; c++) {
      const h = P[c].kind === 'log' ? 1e-3 : 1e-3;
      const th = Float64Array.from(theta); th[c] += h;
      prob.residuals(th, rp);
      for (let i = 0; i < rows; i++) J[i * p + c] = (rp[i] - r[i]) / h;
      if (c % 10 === 9) { onProgress && onProgress({ stage: 'fit', iter: it, cost, frac: (it + c / p) / FIT.maxIter }); await tick(); }
    }
    const A = new Float64Array(p * p), g = new Float64Array(p);
    for (let i = 0; i < rows; i++) {
      const ri = r[i], o = i * p;
      for (let a = 0; a < p; a++) {
        const ja = J[o + a]; if (ja === 0) continue;
        g[a] += ja * ri;
        for (let b = a; b < p; b++) A[a * p + b] += ja * J[o + b];
      }
    }
    for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) A[a * p + b] = A[b * p + a];
    let accepted = false;
    for (let tries = 0; tries < 10 && !accepted; tries++) {
      const M = Float64Array.from(A);
      for (let a = 0; a < p; a++) M[a * p + a] += lambda * Math.max(A[a * p + a], 1e-9);
      const step = solveSPD(M, g.map(v => -v), p);
      if (!step) { lambda *= 10; continue; }
      const th = theta.map((v, i) => v + Math.max(-1, Math.min(1, step[i])));
      prob.residuals(th, rp);
      const c2 = dot(rp, rp);
      if (c2 < cost) { theta = th; r.set(rp); accepted = cost - c2; cost = c2; lambda = Math.max(1e-7, lambda / 3); }
      else lambda *= 4;
    }
    prob.updateWeights(r); prob.residuals(theta, r); cost = dot(r, r);
    history.push(cost);
    onProgress && onProgress({ stage: 'fit', iter: it + 1, cost, frac: (it + 1) / FIT.maxIter });
    await tick();
    if (!accepted || accepted < 1e-5 * cost) break;
  }
  return { theta, cost, history };
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

// ---- checking ------------------------------------------------------------------------
// A whole day from midnight with nothing but the recorded inputs.
export function freeRun(model, grid, k0, steps) {
  const m = compile(model), n = ZONE_IDS.length;
  const hidden = estimateHidden(m, grid, 0, k0);
  const T0 = Float64Array.from(ZONE_IDS, (z, i) => grid.T[i][k0]);
  return runRecorded(m, grid, k0, Math.min(grid.K - 1, k0 + steps), T0, hidden.subarray(k0 * 2 * n, (k0 + 1) * 2 * n));
}
export function dayErrors(model, grid, pw, k0, perDay) {
  const run = freeRun(model, grid, k0, perDay), n = ZONE_IDS.length;
  const se = new Float64Array(n), bias = new Float64Array(n), cnt = new Float64Array(n);
  for (let j = 1; j <= perDay && k0 + j < grid.K; j++) for (let z = 0; z < n; z++) {
    const v = grid.T[z][k0 + j]; if (!isFinite(v)) continue;
    const d = run.T[j * n + z] - v; se[z] += d * d; bias[z] += d; cnt[z]++;
  }
  let es = 0, eo = 0;
  for (let j = 0; j < perDay && k0 + j < grid.K; j++) if (pw.ok[k0 + j]) { es += run.P[j] * grid.stepH; eo += pw.obs[k0 + j] * grid.stepH; }
  return { rmse: Array.from(se, (s, z) => Math.sqrt(s / Math.max(1, cnt[z]))), bias: Array.from(bias, (s, z) => s / Math.max(1, cnt[z])), energySim: es, energyObs: eo, run };
}

export async function train(grid, opts = {}) {
  const onProgress = opts.onProgress;
  const pw = powerObservation(grid);
  const split = splitDays(grid, opts.valShare ?? 0.25);
  const warnings = pw.notes.slice();
  if (!split.train.length) throw new Error('Not enough complete days of room temperatures to train on.');
  if (!split.val.length) warnings.push('Only one complete day: the check below uses the same day the model was trained on.');
  if (!grid.heater.some(v => v > 0.1)) warnings.push('No heater power: absolute heat capacities lean on the priors.');
  if (!grid.mode.some(m => m.some(v => v))) warnings.push('No unit was ever in heat or cool mode in this data.');
  const windows = windowsFor(grid, split.train, split.perDay);
  if (windows.length < 4) throw new Error('Too few gap-free six-hour stretches to train on.');

  const base = opts.initial || initialModel(grid);
  const P = paramList(base);
  const theta0 = toTheta(base, P);
  const prob = makeProblem(grid, pw, windows, P, base, theta0);
  onProgress && onProgress({ stage: 'start', windows: windows.length, params: P.length });
  const res = await levenberg(prob, theta0, P, onProgress);
  const model = fromTheta(res.theta, P, base);

  const evalDays = (days) => days.map(k0 => ({ k0, t0: grid.t[k0], ...dayErrors(model, grid, pw, k0, split.perDay) }));
  const train = evalDays(split.train), val = split.val.length ? evalDays(split.val) : evalDays(split.train.slice(-1));
  const agg = list => ZONE_IDS.map((z, i) => Math.sqrt(list.reduce((s, d) => s + d.rmse[i] ** 2, 0) / Math.max(1, list.length)));
  const report = {
    trainedAt: Date.now(), range: { start: grid.t[0], end: grid.t[grid.K - 1] },
    days: { train: split.train.map(k => grid.t[k]), val: split.val.map(k => grid.t[k]) },
    windows: windows.length, cost: res.cost, costHistory: res.history,
    rmseTrain: agg(train), rmseVal: agg(val),
    energy: { sim: val.reduce((s, d) => s + d.energySim, 0), obs: val.reduce((s, d) => s + d.energyObs, 0), observed: pw.ok.some(v => v) },
    cop7: model.plant.eta * carnotHeat(21, 7),
    zones: Object.fromEntries(ZONE_IDS.map(z => [z, zoneSummary(model, z)])),
    warnings,
  };
  return { model, report, pw, split, validation: val };
}
