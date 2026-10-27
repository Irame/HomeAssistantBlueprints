// A thermal model of the whole apartment. Every zone has three nodes: its
// air, which the thermometer sees and the units and the heater warm
// directly; its surfaces and furniture, which the air charges within hours
// and the sun warms; and the building structure behind them (walls, floor
// slab), which takes days and leaks to the outside and to the neighbours.
// Zones are coupled through the hallway's air.
//
//   Ca dTa/dt = H (Tout - Ta) + Hw open (Tout - Ta) + Ham (Tm - Ta)
//             + L (Ta_hall - Ta) + Q_unit + Q_heater + q(hour)
//   Cm dTm/dt = Ham (Ta - Tm) + Hmw (Tw - Tm) + sD*D + sE*E + sS*S + sW*W
//   Cw dTw/dt = Hmw (Tm - Tw) + Hwo (Tout - Tw) + Hwn (Tnb - Tw)
//
// q(hour) = q + qc cos(2 pi hour/24) + qs sin(2 pi hour/24) covers people
// and appliances. Tnb is the neighbours' temperature.
// Units: C kWh/K, H* and L kW/K, Q and q kW, solar inputs kW/m², s* m².

import { carnotHeat, carnotCool } from './room.js';

export const ZONES = [
  { id: 'office', label: 'Office', ac: true, window: true },
  { id: 'bedroom', label: 'Bedroom', ac: true, window: true },
  { id: 'living', label: 'Living room & kitchen', ac: true, window: true },
  { id: 'bath', label: 'Bathroom', heater: true },
  { id: 'hall', label: 'Hallway', hub: true },
];
export const ZONE_IDS = ZONES.map(z => z.id);
export const AC_ZONES = ZONES.filter(z => z.ac).map(z => z.id);
export const WINDOW_ZONES = ZONES.filter(z => z.window).map(z => z.id);
export const HUB = ZONES.findIndex(z => z.hub);
export const BATH = ZONES.findIndex(z => z.heater);
export const SOLAR = ['D', 'E', 'S', 'W'];
export function modeCode(s) {
  if (s === 'heat') return 1;
  if (s === 'cool' || s === 'dry') return 2;
  if (s === 'heat_cool' || s === 'auto') return 3;
  return 0;
}

// A plausible apartment, used as the example and as the prior for training.
export function defaultModel() {
  const z = (Ca, Cm, Cw, Ham, Hmw, Hwo, Hwn, H, Hw, q, sol) => ({ Ca, Cm, Cw, Ham, Hmw, Hwo, Hwn, H, Hw, q, qc: 0, qs: 0, ...sol });
  return {
    version: 3,
    zones: {
      office: z(0.25, 1.0, 3.0, 0.35, 0.15, 0.014, 0.008, 0.005, 0.12, 0.04, { sD: 0.6, sE: 0, sS: 0.8, sW: 0 }),
      bedroom: z(0.25, 1.0, 3.2, 0.35, 0.15, 0.014, 0.008, 0.005, 0.12, 0.02, { sD: 0.6, sE: 0, sS: 0.8, sW: 0 }),
      living: z(0.6, 2.5, 7.0, 0.8, 0.35, 0.032, 0.016, 0.010, 0.20, 0.12, { sD: 1.2, sE: 0, sS: 1.0, sW: 0.8 }),
      bath: z(0.12, 0.4, 1.0, 0.2, 0.08, 0.005, 0.004, 0.002, 0, 0.01, { sD: 0.1, sE: 0, sS: 0, sW: 0 }),
      hall: z(0.2, 0.6, 2.0, 0.3, 0.12, 0.002, 0.008, 0.002, 0, 0.02, { sD: 0, sE: 0, sS: 0, sW: 0 }),
    },
    building: { Tnb: 20 },
    links: { office: 0.012, bedroom: 0.012, living: 0.090, bath: 0.010 },
    ac: {
      office: { Kp: 1.5, off: 0.5, Qmax: 3.2 },
      bedroom: { Kp: 1.5, off: 0.5, Qmax: 3.2 },
      living: { Kp: 2.0, off: 0.8, Qmax: 4.5 },
    },
    plant: { Qmax: 7.0, eta: 0.42, standby: 0.03 },
  };
}

// Total capacity, steady loss (to outside and neighbours) and the slow time
// constant of a zone, for reports.
export function zoneSummary(model, z) {
  const p = model.zones[z];
  const C = p.Ca + p.Cm + p.Cw;
  const Hloss = p.H + 1 / (1 / p.Ham + 1 / p.Hmw + 1 / Math.max(1e-9, p.Hwo + p.Hwn));
  return { C, Hloss, tauH: C / Math.max(1e-6, Hloss) };
}

// Flatten into arrays for the inner loop.
export function compile(model) {
  const n = ZONE_IDS.length;
  const f = k => Float64Array.from(ZONE_IDS, z => (model.zones[z] && model.zones[z][k]) || 0);
  const acz = AC_ZONES.map(z => ZONE_IDS.indexOf(z));
  const m = {
    n, Ca: f('Ca'), Cm: f('Cm'), Cw: f('Cw'), Ham: f('Ham'), Hmw: f('Hmw'), Hwo: f('Hwo'), Hwn: f('Hwn'),
    H: f('H'), Hw: f('Hw'), q: f('q'), qc: f('qc'), qs: f('qs'), Tnb: (model.building && model.building.Tnb) ?? 20,
    sD: f('sD'), sE: f('sE'), sS: f('sS'), sW: f('sW'),
    L: Float64Array.from(ZONE_IDS, z => (model.links[z] || 0)),
    winZone: WINDOW_ZONES.map(z => ZONE_IDS.indexOf(z)),
    acz, Kp: Float64Array.from(AC_ZONES, z => model.ac[z].Kp), off: Float64Array.from(AC_ZONES, z => model.ac[z].off),
    Qmax: Float64Array.from(AC_ZONES, z => model.ac[z].Qmax),
    plantQ: model.plant.Qmax, eta: model.plant.eta, standby: model.plant.standby,
  };
  // fastest rate in the system, to pick a stable explicit step
  let rate = 0, Lhub = 0;
  for (let z = 0; z < n; z++) if (z !== HUB) Lhub += m.L[z];
  for (let z = 0; z < n; z++) {
    const a = acz.indexOf(z);
    const air = (m.H[z] + m.Hw[z] + m.Ham[z] + (z === HUB ? Lhub : m.L[z]) + (a >= 0 ? m.Kp[a] : 0)) / m.Ca[z];
    const mass = (m.Hmw[z] + m.Ham[z]) / m.Cm[z], wall = (m.Hmw[z] + m.Hwo[z] + m.Hwn[z]) / m.Cw[z];
    rate = Math.max(rate, air, mass, wall);
  }
  m.maxRate = rate;
  return m;
}
export function substepsFor(m, dtH) { return Math.max(1, Math.ceil(dtH * m.maxRate / 0.5)); }

// The indoor units' heat for given modes and setpoints, capped by the
// shared outdoor unit, and the electricity it takes.
export function plant(m, Ta, tout, mode, set, Qout) {
  let sum = 0, anyOn = false;
  for (let a = 0; a < m.acz.length; a++) {
    const z = m.acz[a], sensed = Ta[z] + m.off[a];
    let d = 0;
    if (mode[a] === 1) d = Math.min(m.Qmax[a], Math.max(0, m.Kp[a] * (set[a] - sensed)));
    else if (mode[a] === 2) d = -Math.min(m.Qmax[a], Math.max(0, m.Kp[a] * (sensed - set[a])));
    else if (mode[a] === 3) d = Math.max(-m.Qmax[a], Math.min(m.Qmax[a], m.Kp[a] * (set[a] - sensed)));
    if (mode[a]) anyOn = true;
    Qout[a] = d; sum += Math.abs(d);
  }
  const scale = sum > m.plantQ ? m.plantQ / sum : 1;
  let pel = anyOn ? m.standby : 0;
  for (let a = 0; a < m.acz.length; a++) {
    Qout[a] *= scale;
    if (Qout[a] > 0) pel += Qout[a] / (m.eta * carnotHeat(Ta[m.acz[a]], tout));
    else if (Qout[a] < 0) pel += -Qout[a] / (m.eta * carnotCool(Ta[m.acz[a]], tout));
  }
  return pel;
}

// State S = [air..., surfaces..., structure...]; hidden = [surfaces..., structure...].
export function newState(m, Ta, hidden) {
  const n = m.n, S = new Float64Array(3 * n);
  for (let z = 0; z < n; z++) {
    S[z] = Ta[z];
    S[n + z] = hidden ? hidden[z] : Ta[z];
    S[2 * n + z] = hidden ? hidden[n + z] : Ta[z];
  }
  return S;
}

// Advance S in place by dtH hours (one explicit step; see substepsFor).
// u: { tout, open: [per window zone 0..1], sol: {D,E,S,W}, heater: kW,
//      mode: Int8 per AC zone, set: per AC zone, hc, hs: cos/sin of the hour }
const _fa = new Float64Array(16), _fm = new Float64Array(16), _fw = new Float64Array(16), _Q = new Float64Array(8);
export function advance(m, S, u, dtH, Qout) {
  const n = m.n, Q = Qout || _Q, fa = _fa, fm = _fm, fw = _fw;
  const pel = plant(m, S, u.tout, u.mode, u.set, Q);
  for (let z = 0; z < n; z++) {
    const ta = S[z], tm = S[n + z], tw = S[2 * n + z], x = m.Ham[z] * (tm - ta), y = m.Hmw[z] * (tw - tm);
    fa[z] = m.H[z] * (u.tout - ta) + m.q[z] + m.qc[z] * u.hc + m.qs[z] * u.hs + x;
    fm[z] = y - x + m.sD[z] * u.sol.D + m.sE[z] * u.sol.E + m.sS[z] * u.sol.S + m.sW[z] * u.sol.W;
    fw[z] = -y + m.Hwo[z] * (u.tout - tw) + m.Hwn[z] * (m.Tnb - tw);
  }
  for (let w = 0; w < m.winZone.length; w++) {
    const z = m.winZone[w];
    if (u.open[w]) fa[z] += m.Hw[z] * u.open[w] * (u.tout - S[z]);
  }
  for (let z = 0; z < n; z++) {
    if (z === HUB) continue;
    const f = m.L[z] * (S[HUB] - S[z]);
    fa[z] += f; fa[HUB] -= f;
  }
  if (u.heater) fa[BATH] += u.heater;
  for (let a = 0; a < m.acz.length; a++) fa[m.acz[a]] += Q[a];
  for (let z = 0; z < n; z++) {
    S[z] += fa[z] * dtH / m.Ca[z]; S[n + z] += fm[z] * dtH / m.Cm[z]; S[2 * n + z] += fw[z] * dtH / m.Cw[z];
  }
  return pel;
}

function inputAt(g, k, u) {
  u.tout = g.tout[k];
  for (let w = 0; w < u.open.length; w++) u.open[w] = g.open[w][k];
  u.sol.D = g.sol.D[k]; u.sol.E = g.sol.E[k]; u.sol.S = g.sol.S[k]; u.sol.W = g.sol.W[k];
  u.heater = g.heater[k]; u.hc = g.hc[k]; u.hs = g.hs[k];
  for (let a = 0; a < u.mode.length; a++) { u.mode[a] = g.mode[a][k]; u.set[a] = g.set[a][k]; }
}
export function inputBuffer(m) {
  return { tout: 0, open: new Float64Array(m.winZone.length), sol: { D: 0, E: 0, S: 0, W: 0 }, heater: 0,
    mode: new Int8Array(m.acz.length), set: new Float64Array(m.acz.length), hc: 0, hs: 0 };
}
export function hourWave(t) { const d = new Date(t), h = d.getHours() + d.getMinutes() / 60; return [Math.cos(2 * Math.PI * h / 24), Math.sin(2 * Math.PI * h / 24)]; }

// Surfaces and structure are never measured. Driving them with the measured
// air temperatures reconstructs them: the surfaces settle within hours, the
// structure within a day or two, so after a burn-in this is a good estimate.
// Returns hidden states per step: [surfaces..., structure...] flattened.
export function estimateHidden(m, g, k0, k1) {
  const n = m.n, out = new Float64Array((k1 - k0 + 1) * 2 * n);
  const Tm = new Float64Array(n), Tw = new Float64Array(n);
  const first = Math.min(k1, k0 + Math.round(24 / g.stepH));
  for (let z = 0; z < n; z++) {
    let a = 0, c = 0;
    for (let k = k0; k <= first; k++) if (isFinite(g.T[z][k])) { a += g.T[z][k]; c++; }
    Tm[z] = isFinite(g.T[z][k0]) ? g.T[z][k0] : (c ? a / c : 20); Tw[z] = c ? a / c : Tm[z];
  }
  let rate = 0;
  for (let z = 0; z < n; z++) rate = Math.max(rate, (m.Ham[z] + m.Hmw[z]) / m.Cm[z], (m.Hmw[z] + m.Hwo[z] + m.Hwn[z]) / m.Cw[z]);
  const sub = Math.max(1, Math.ceil(g.stepH * rate / 0.5)), dt = g.stepH / sub;
  for (let k = k0; k <= k1; k++) {
    const o = (k - k0) * 2 * n;
    for (let z = 0; z < n; z++) { out[o + z] = Tm[z]; out[o + n + z] = Tw[z]; }
    if (k === k1) break;
    const sol = g.sol, tout = g.tout[k];
    for (let z = 0; z < n; z++) {
      const ta = isFinite(g.T[z][k]) ? g.T[z][k] : Tm[z];
      const s = m.sD[z] * sol.D[k] + m.sE[z] * sol.E[k] + m.sS[z] * sol.S[k] + m.sW[z] * sol.W[k];
      for (let i = 0; i < sub; i++) {
        const y = m.Hmw[z] * (Tw[z] - Tm[z]);
        Tm[z] += (m.Ham[z] * (ta - Tm[z]) + y + s) * dt / m.Cm[z];
        Tw[z] += (-y + m.Hwo[z] * (tout - Tw[z]) + m.Hwn[z] * (m.Tnb - Tw[z])) * dt / m.Cw[z];
      }
    }
  }
  return out;
}

// Free run over a prepared grid (see haexport.buildGrid) from step k0 to k1
// with the recorded inputs, from air temperatures Ta0 and hidden states H0.
// Returns air temperatures [step][zone] flattened, electric power and the
// units' heat per step.
export function runRecorded(m, g, k0, k1, Ta0, H0) {
  const n = m.n, K = k1 - k0, nA = m.acz.length;
  const S = newState(m, Ta0, H0);
  const outT = new Float64Array((K + 1) * n), outP = new Float64Array(K), outQ = new Float64Array(K * nA);
  for (let z = 0; z < n; z++) outT[z] = S[z];
  const sub = substepsFor(m, g.stepH), dt = g.stepH / sub;
  const u = inputBuffer(m), Q = new Float64Array(nA), qs = new Float64Array(nA);
  for (let k = k0; k < k1; k++) {
    inputAt(g, k, u);
    let pel = 0; qs.fill(0);
    for (let s = 0; s < sub; s++) {
      pel += advance(m, S, u, dt, Q);
      for (let a = 0; a < nA; a++) qs[a] += Q[a];
    }
    const j = k - k0;
    outP[j] = pel / sub;
    for (let a = 0; a < nA; a++) outQ[j * nA + a] = qs[a] / sub;
    for (let z = 0; z < n; z++) outT[(j + 1) * n + z] = S[z];
  }
  return { T: outT, P: outP, Q: outQ, S };
}
