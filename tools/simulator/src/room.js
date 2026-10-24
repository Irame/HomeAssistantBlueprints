// One room, one device, one blueprint instance: the simulator's simple mode.
import { HOUR, MIN, clamp, linAt, BLUEPRINT_DEFAULTS, dayContext, controller } from './blueprint.js';

export const ROOM_DEFAULTS = Object.assign({}, BLUEPRINT_DEFAULTS, {
  model_loss_w_per_k: 100, model_capacity_kwh_per_k: 4, model_max_kw: 5,
  model_cop: 3.5, model_start_temp: null, model_ctrl_minutes: 30,
});

// Carnot-shaped COP, scaled so heating at 21 C in / 7 C out gives the nominal COP.
export function carnotHeat(tin, tout) {
  const th = tin + 273.15 + 12, tc = tout + 273.15 - 6;
  return th / Math.max(8, th - tc);
}
export function carnotCool(tin, tout) {
  const tc = tin + 273.15 - 10, th = tout + 273.15 + 10;
  return tc / Math.max(8, th - tc);
}
const HEAT_REF = carnotHeat(21, 7), COOL_REF = carnotCool(27, 35);

// data: { price: [{t,v}], outdoor: [{t,v}], indoor?: [{t,v}] }
export function simulateRoom(data, Pin, range) {
  const P = Object.assign({}, ROOM_DEFAULTS, Pin);
  const tStart = range.start, tEnd = range.end;
  const ctx = dayContext(data.price, data.outdoor, tStart, tEnd);

  const H = P.model_loss_w_per_k / 1000; // kW/K
  const C = Math.max(0.1, P.model_capacity_kwh_per_k); // kWh/K
  const Pmax = P.model_max_kw;
  const tauCtrl = Math.max(1, P.model_ctrl_minutes) / 60; // h
  const dt = 1 / 60; // h

  let tin = P.model_start_temp;
  if (tin === null || tin === undefined || !isFinite(tin)) {
    const m = data.indoor && data.indoor.length ? linAt(data.indoor, tStart) : null;
    tin = m !== null ? m : P.heat_comfort;
  }
  const dev = controller(P, tStart);
  const rows = [];
  let energy = 0, cost = 0, heat = 0;

  for (let t = tStart; t < tEnd; t += MIN) {
    const x = ctx.at(P, t);
    x.indoor = tin;
    const d = dev.step(t, x);
    const mode = dev.mode, setpoint = dev.setpoint;

    const tout = x.outdoor ?? tin;
    const loss = H * (tin - tout); // kW leaving the room
    let pth = 0, pel = 0;
    if (mode === 'heat') {
      pth = clamp(loss + C * (setpoint - tin) / tauCtrl, 0, Pmax);
      pel = pth / (P.model_cop * carnotHeat(tin, tout) / HEAT_REF);
    } else if (mode === 'cool') {
      pth = -clamp(-loss + C * (tin - setpoint) / tauCtrl, 0, Pmax);
      pel = -pth / (P.model_cop * carnotCool(tin, tout) / COOL_REF);
    }
    tin += (pth - loss) * dt / C;
    energy += pel * dt; heat += Math.abs(pth) * dt;
    if (x.price !== null) cost += pel * dt * x.price;

    rows.push(Object.assign(d, { t, price: x.price, outdoor: x.outdoor, fwdMean: x.fwdMean, nearMean: x.nearMean,
      fwdOutdoor: x.fwdOutdoor, high: x.high, low: x.low, mode, setpoint: mode === 'off' ? null : setpoint,
      indoor: tin, pth, pel }));
  }
  let minIn = Infinity, maxIn = -Infinity;
  for (const r of rows) { minIn = Math.min(minIn, r.indoor); maxIn = Math.max(maxIn, r.indoor); }
  return { rows, energy, cost, heat, avgPrice: energy > 0 ? cost / energy : null, minIn, maxIn, intervalMin: ctx.intervalMin };
}

export { HOUR, MIN };
