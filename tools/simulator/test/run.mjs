// npm test: the parts that need no Python. Trains on made-up data with
// units that cycle and people on a schedule, then checks the result.
import { syntheticRun, toExport } from '../src/synthetic.js';
import { parseExport, guessMapping, prepare } from '../src/haexport.js';
import { train } from '../src/fit.js';
import { zoneSummary, ZONE_IDS } from '../src/apartment.js';
import { truthModel } from './truth.mjs';

let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

const truth = truthModel();
const run = syntheticRun({ days: 14, seed: 7, model: truth, realism: true });
const parsed = parseExport(JSON.stringify(toExport(run)));
const map = guessMapping(parsed);
check(map.temp.office === 'sensor.buero_temperatur', 'room thermometer chosen over the unit\'s own reading');
check(map.window.living.length === 1 && map.heater === 'sensor.bad_heizluefter_leistung', 'window sensor and heater found');
const { map: m2, grid } = prepare(parsed, map);
check(m2.phase === 'sensor.phase_l2_leistung', 'units\' phase picked from the data');

const res = await train(grid);
ZONE_IDS.forEach((z, i) => {
  const a = zoneSummary(truth, z).tauH, b = res.report.zones[z].tauH;
  check(Math.abs(b / a - 1) < 0.35, `${z}: time constant ${b.toFixed(0)} h vs ${a.toFixed(0)} h`);
  check(res.report.rmseVal[i] < 0.35, `${z}: held-out day error ${res.report.rmseVal[i].toFixed(2)} K`);
});
check(res.model.plant.eta > 0.25 && res.model.plant.eta < 0.45, `efficiency ${res.model.plant.eta.toFixed(2)} (true ${truth.plant.eta})`);
let trueE = 0;
for (const v of res.validation) for (let i = 0; i < run.rec.t.length; i++) if (run.rec.t[i] >= v.t0 && run.rec.t[i] < v.t0 + 864e5) trueE += run.rec.pel[i] / 60;
check(Math.abs(res.report.energy.sim / trueE - 1) < 0.3, `held-out energy ${res.report.energy.sim.toFixed(1)} kWh vs ${trueE.toFixed(1)} kWh`);
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
