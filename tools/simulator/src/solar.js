// Sun position and a rough split of solar irradiance onto vertical facades.
// Good enough to give each room a solar-gain input the fit can scale; the
// fitted coefficients absorb window sizes, shading and the crudeness here.

const RAD = Math.PI / 180;

// Low-precision solar position (about 0.01 degrees, NOAA/Astronomical Almanac).
// Returns elevation and azimuth in radians, azimuth from north clockwise.
export function sunPosition(t, lat, lon) {
  const d = t / 864e5 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + lon) * RAD - ra);
  const phi = lat * RAD;
  const elev = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  let az = Math.atan2(-Math.cos(dec) * Math.sin(ha), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(ha));
  if (az < 0) az += 2 * Math.PI;
  return { elev, az };
}

export const FACADES = { E: 90 * RAD, S: 180 * RAD, W: 270 * RAD };

// cloud: 0..1 or null (treated as a typical 0.5).
// Returns kW/m²: D = diffuse and reflected light any window sees, E/S/W =
// direct sun on a vertical east, south or west facade.
export function irradiance(t, lat, lon, cloud) {
  const { elev, az } = sunPosition(t, lat, lon);
  const s = Math.sin(elev);
  if (s <= 0.01) return { D: 0, E: 0, S: 0, W: 0, ghi: 0 };
  const c = cloud === null || cloud === undefined || !isFinite(cloud) ? 0.5 : Math.min(1, Math.max(0, cloud));
  const clear = 1.098 * s * Math.exp(-0.057 / s); // Haurwitz clear-sky GHI
  const ghi = clear * (1 - 0.75 * Math.pow(c, 3.4)); // Kasten-Czeplak cloud factor
  const kd = Math.min(1, 0.15 + 0.85 * c * c); // diffuse share
  const dhi = kd * ghi;
  const dni = Math.min(1.0, (ghi - dhi) / Math.max(s, 0.05));
  const out = { D: 0.5 * dhi + 0.1 * ghi, ghi };
  for (const f of ['E', 'S', 'W']) out[f] = dni * Math.max(0, Math.cos(elev) * Math.cos(az - FACADES[f]));
  return out;
}
