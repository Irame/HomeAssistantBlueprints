// The blueprint's decision logic, mirrored by hand from
// blueprints/automation/Irame/adaptive_climate_setpoint.yaml (the `refresh`
// branch). test/blueprint_parity.py renders the real templates and checks
// this file against them, so a change to one belongs in both.

export const HOUR = 3600e3, MIN = 60e3;
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---- series helpers --------------------------------------------------------
// series: sorted [{t, v}]; value in force at t (last value at or before t)
export function stepAt(series, t) {
  if (!series || !series.length || t < series[0].t) return null;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (series[m].t <= t) lo = m; else hi = m - 1; }
  return series[lo].v;
}
export function linAt(series, t) {
  if (!series || !series.length) return null;
  if (t <= series[0].t) return t < series[0].t - 2 * HOUR ? null : series[0].v;
  const last = series[series.length - 1];
  if (t >= last.t) return t > last.t + 2 * HOUR ? null : last.v;
  let lo = 0, hi = series.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (series[m].t <= t) lo = m; else hi = m; }
  const a = series[lo], b = series[hi];
  return a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
}

// Resample a stepped price series onto a fixed interval grid, as the
// tibber_prices sensors see it. History only records changes, so two
// equal neighbouring intervals collapse into one record - sampling each
// interval in its middle restores them.
export function priceGrid(series, intervalMin, tStart, tEnd) {
  const iv = intervalMin * MIN;
  const g0 = Math.floor(tStart / iv) * iv;
  const out = [];
  for (let t = g0; t < tEnd; t += iv) out.push({ t, v: stepAt(series, t + iv / 2) });
  return { start: g0, iv, slots: out };
}

// Mean of the next N hours starting at the NEXT interval (tibber_prices next_avg_Nh).
export function nextAvg(grid, t, hours) {
  const k = Math.floor((t - grid.start) / grid.iv);
  const n = Math.round(hours * HOUR / grid.iv);
  let s = 0, c = 0;
  for (let i = k + 1; i <= k + n && i < grid.slots.length; i++) {
    const v = grid.slots[i] && grid.slots[i].v;
    if (v !== null && v !== undefined && isFinite(v)) { s += v; c++; }
  }
  return c > 0 ? s / c : null;
}

export function detectInterval(series) {
  if (!series || series.length < 3) return 60;
  let quarter = 0;
  for (const p of series) {
    const m = new Date(p.t).getMinutes();
    if (m === 15 || m === 30 || m === 45) quarter++;
  }
  return quarter / series.length > 0.05 ? 15 : 60;
}

// ---- inputs ------------------------------------------------------------------
export const BLUEPRINT_DEFAULTS = {
  // comfort axis
  heat_comfort: 21, heat_charge: 23.5, heat_coast: 19,
  cool_comfort: 24, cool_charge: 21, cool_coast: 26.5,
  // price
  price_cheap: 0.20, price_expensive: 0.35,
  use_forward: true, forward_hours: 6, price_lookahead_margin: 0.15,
  use_near: true, near_hours: 2, price_falling_margin: 0.10, price_falling_hold: 1,
  // demand
  use_demand: true, demand_lookahead_hours: 6, demand_cold_ref: 0, demand_hot_ref: 32,
  // day type
  cool_day_threshold: 24, heat_day_threshold: 16, heating_reference: 'average',
  forecast_high: null, forecast_low: null, // null = from outdoor data
  // schedule
  night_start: '22:00', night_end: '06:00', storage_overrides_schedule: false,
  // indoor
  use_indoor: true, indoor_deadband: 1.0,
  // door/window sensors force the device off
  use_windows: true,
  // timing guards
  min_running_minutes: 3, min_idle_minutes: 3,
};

// Jinja's round filter is Python's round: ties go to the even neighbour.
function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function hm(str) {
  const [h, m] = String(str).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// ---- one evaluation of the automation --------------------------------------
// x: { now (ms), price, fwdMean, nearMean, outdoor, fwdOutdoor, high, low,
//      indoor, deviceOff, windowOpen }
export function decide(P, x) {
  const price_valid = x.price !== null && isFinite(x.price);
  const current_price = price_valid ? x.price : 0;
  const max_t = x.high, min_t = (x.low === null || x.low === undefined) ? x.high : x.low;
  const heat_ref = P.heating_reference === 'high' ? max_t
    : P.heating_reference === 'low' ? min_t : (max_t + min_t) / 2;
  const day_type = max_t > P.cool_day_threshold ? 'cool' : heat_ref < P.heat_day_threshold ? 'heat' : 'off';

  const lo = P.price_cheap, hi = P.price_expensive;
  const pf = !price_valid ? 1 : (hi > lo ? (current_price - lo) / (hi - lo) : 0);
  const pfc = clamp(pf, 0, 1);
  const sig_abs = 2 * pfc - 1;

  const fwd_valid = P.use_forward && price_valid && x.fwdMean !== null && x.fwdMean > 0;
  let sig_fwd = 0;
  if (fwd_valid) {
    const span = P.price_lookahead_margin * x.fwdMean;
    sig_fwd = span > 0 ? clamp((current_price - x.fwdMean) / span, -1, 1) : 0;
  }
  const raw = fwd_valid ? (sig_abs + sig_fwd) / 2 : sig_abs;
  const sig_unheld = clamp(raw, -1, 1);

  const near_valid = P.use_near && price_valid && x.nearMean !== null && x.nearMean > 0;
  let falling = 0;
  if (near_valid) {
    const span = P.price_falling_margin * x.nearMean;
    falling = span > 0 ? clamp((current_price - x.nearMean) / span, 0, 1) : 0;
  }
  const h = P.price_falling_hold;
  const signal = sig_unheld < h ? sig_unheld + falling * (h - sig_unheld) : sig_unheld;

  const cool = day_type === 'cool';
  const a_comfort = cool ? P.cool_comfort : P.heat_comfort;
  const a_charge = cool ? P.cool_charge : P.heat_charge;
  const a_coast = cool ? P.cool_coast : P.heat_coast;

  const demand_valid = P.use_demand && x.fwdOutdoor !== null && isFinite(x.fwdOutdoor);
  let demand = 1;
  if (!demand_valid) demand = 1;
  else if (day_type === 'cool') {
    const span = P.demand_hot_ref - P.cool_comfort;
    demand = clamp(span > 0 ? (x.fwdOutdoor - P.cool_comfort) / span : 1, 0, 1);
  } else if (day_type === 'heat') {
    const span = P.heat_comfort - P.demand_cold_ref;
    demand = clamp(span > 0 ? (P.heat_comfort - x.fwdOutdoor) / span : 1, 0, 1);
  } else demand = 0;

  const eff_charge = a_comfort + (a_charge - a_comfort) * demand;
  const target_raw = signal > 0 ? a_comfort + signal * (a_coast - a_comfort)
    : a_comfort + signal * (a_comfort - eff_charge);
  const target = roundHalfEven(target_raw * 2) / 2;

  const d = new Date(x.now);
  const nowm = d.getHours() * 60 + d.getMinutes();
  const ns = hm(P.night_start), ne = hm(P.night_end);
  const is_night = ns <= ne ? (ns <= nowm && nowm < ne) : (nowm >= ns || nowm < ne);

  const outdoor_valid = x.outdoor !== null && isFinite(x.outdoor);
  let outdoor_off = false;
  if (outdoor_valid) {
    if (day_type === 'cool') outdoor_off = x.outdoor <= P.cool_comfort;
    else if (day_type === 'heat') outdoor_off = x.outdoor >= P.heat_comfort;
  }

  const price_is_cheap = pfc <= 0;
  const storage_charging = price_is_cheap && signal < 0 && day_type !== 'off' && eff_charge !== a_comfort;
  const storage_bypass = P.storage_overrides_schedule && storage_charging;

  const indoor_valid = P.use_indoor && x.indoor !== null && x.indoor !== undefined && isFinite(x.indoor);
  let indoor_satisfied = false;
  if (indoor_valid) {
    const t = target, i = x.indoor, db = P.indoor_deadband;
    if (day_type === 'cool') indoor_satisfied = x.deviceOff ? i < t : i <= t - db;
    else if (day_type === 'heat') indoor_satisfied = x.deviceOff ? i > t : i >= t + db;
  }

  const window_open = !!(P.use_windows && x.windowOpen);

  const reasons = [];
  if (window_open) reasons.push('window open');
  if (day_type === 'off') reasons.push('dead-band day');
  if (indoor_satisfied) reasons.push('rooms past target');
  if (is_night && !storage_bypass) reasons.push('night');
  if (outdoor_off && !storage_bypass) reasons.push('outdoor override');
  const should_be_off = reasons.length > 0;

  return {
    day_type, price_factor: pfc, sig_abs, sig_fwd, fwd_valid, sig_unheld, falling, near_valid,
    signal, demand, eff_charge, target_raw, target, is_night, outdoor_off, window_open,
    storage_charging, storage_bypass, indoor_satisfied, should_be_off, reasons,
    desired_mode: should_be_off ? 'off' : day_type, heat_ref,
  };
}

// ---- the automation over time ------------------------------------------------
// Everything decide() needs that comes from the day rather than from the
// room: price windows, the captured forecast and the hourly forecast proxy.
export function dayContext(price, outdoor, tStart, tEnd) {
  const ivMin = detectInterval(price);
  const gridEnd = Math.max(tEnd, price.length ? price[price.length - 1].t + HOUR : tEnd);
  const grid = priceGrid(price, ivMin, Math.min(tStart, price.length ? price[0].t : tStart), gridEnd);
  const dayHL = {};
  const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
  for (const p of outdoor) {
    const k = dayKey(p.t);
    if (!dayHL[k]) dayHL[k] = { hi: -Infinity, lo: Infinity };
    dayHL[k].hi = Math.max(dayHL[k].hi, p.v); dayHL[k].lo = Math.min(dayHL[k].lo, p.v);
  }
  const at = (P, t) => {
    const hl = dayHL[dayKey(t)] || { hi: null, lo: null };
    const high = P.forecast_high !== null && P.forecast_high !== '' && isFinite(P.forecast_high) ? +P.forecast_high : hl.hi;
    const low = P.forecast_low !== null && P.forecast_low !== '' && isFinite(P.forecast_low) ? +P.forecast_low : hl.lo;
    const out = linAt(outdoor, t);
    let fo = null;
    { let s = 0, c = 0; const h0 = Math.floor(t / HOUR) * HOUR;
      for (let i = 0; i < P.demand_lookahead_hours; i++) { const v = linAt(outdoor, h0 + i * HOUR + HOUR / 2); if (v !== null) { s += v; c++; } }
      fo = c ? s / c : null; }
    return {
      now: t, price: stepAt(price, t), outdoor: out, fwdOutdoor: fo,
      fwdMean: nextAvg(grid, t, P.forward_hours), nearMean: nextAvg(grid, t, P.near_hours),
      high: isFinite(high) ? high : (out ?? 10), low: isFinite(low) ? low : null,
    };
  };
  return { intervalMin: ivMin, at };
}

// One blueprint instance driving one device, including its timing guards.
export function controller(P, tStart) {
  let mode = 'off', setpoint = null, lastChange = tStart - 24 * HOUR;
  return {
    get mode() { return mode; },
    get setpoint() { return setpoint; },
    step(t, x) {
      const d = decide(P, Object.assign({}, x, { deviceOff: mode === 'off' }));
      const since = (t - lastChange) / MIN;
      // An open window skips the manual-override pause in the blueprint, but
      // not these guards.
      const guard_ok = d.should_be_off ? (mode === 'off' || since >= P.min_running_minutes)
        : (mode !== 'off' || since >= P.min_idle_minutes);
      if (guard_ok) {
        if (d.desired_mode !== mode) { mode = d.desired_mode; lastChange = t; }
        if (mode !== 'off') setpoint = d.target;
      }
      return d;
    },
  };
}
