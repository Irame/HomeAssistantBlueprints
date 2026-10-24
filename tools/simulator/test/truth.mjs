// The made-up apartment the synthetic tests train against.
import { defaultModel } from '../src/apartment.js';

// a different apartment than the prior, so the fit has to move
export function truthModel() {
  const m = defaultModel();
  Object.assign(m.zones.office, { Ca: 0.35, Cm: 1.4, Cw: 4.0, Ham: 0.25, Hmw: 0.10, Hwo: 0.020, H: 0.008, Hw: 0.18, sS: 0.5, sE: 0.4 });
  Object.assign(m.zones.bedroom, { Ca: 0.2, Cm: 0.8, Cw: 2.5, Ham: 0.45, Hmw: 0.20, Hwo: 0.010, H: 0.004, Hw: 0.08 });
  Object.assign(m.zones.living, { Ca: 0.9, Cm: 3.5, Cw: 9.0, Ham: 0.6, Hmw: 0.25, Hwo: 0.040, Hwn: 0.025, H: 0.015, Hw: 0.30, sW: 1.4 });
  Object.assign(m.zones.bath, { Ca: 0.08, Cm: 0.3, Cw: 0.8, Ham: 0.15, Hmw: 0.06, Hwo: 0.006 });
  Object.assign(m.zones.hall, { Ca: 0.25, Cm: 0.9, Cw: 2.5 });
  m.building.Tnb = 19;
  Object.assign(m.links, { office: 0.008, bedroom: 0.015, living: 0.060, bath: 0.016 });
  Object.assign(m.ac.office, { Kp: 1.1, off: 1.0, Qmax: 2.6 });
  Object.assign(m.ac.living, { Kp: 2.6, off: 1.5 });
  Object.assign(m.plant, { Qmax: 6.0, eta: 0.36, standby: 0.03 });
  return m;
}
