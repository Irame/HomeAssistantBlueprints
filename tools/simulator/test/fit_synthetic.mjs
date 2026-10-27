// Train on made-up data from a known apartment and check that the model
// predicts held-out days well and lands near the true parameters.
//   node test/fit_synthetic.mjs [seed]
import { syntheticRun, toExport } from '../src/synthetic.js';
import { parseExport, guessMapping, prepare } from '../src/haexport.js';
import { train } from '../src/fit.js';
import { defaultModel, zoneSummary, ZONE_IDS } from '../src/apartment.js';

const seed = +(process.argv[2] || 7);

import { truthModel } from './truth.mjs';
const truth = truthModel();
let t = Date.now();
const arg = process.argv[3] || '';
const realism = arg === 'real' ? true : Object.fromEntries(arg.split(',').filter(Boolean).map(k => [k, 1]));
const run = syntheticRun({ days: 14, seed, model: truth, realism });
const parsed = parseExport(JSON.stringify(toExport(run)));
const { grid } = prepare(parsed, guessMapping(parsed));
console.log('data ready', Date.now() - t, 'ms;', grid.K, 'steps');
t = Date.now();
let last = 0;
const res = await train(grid, { onProgress: p => { if (p.stage === 'fit' && p.iter !== last) { last = p.iter; process.stdout.write(`  iter ${p.iter} cost ${p.cost.toFixed(0)}\n`); } } });
console.log('trained in', ((Date.now() - t) / 1000).toFixed(1), 's, windows', res.report.windows);
const f = x => x.toFixed(3);
console.log('zone      C total true/fit  loss true/fit  tau h true/fit  Ca true/fit   Ham true/fit  link true/fit  rmse train/val');
ZONE_IDS.forEach((z, i) => {
  const a = zoneSummary(truth, z), b = res.report.zones[z];
  console.log(z.padEnd(8), f(a.C), f(b.C), ' ', f(a.Hloss), f(b.Hloss), ' ', a.tauH.toFixed(0).padStart(4), b.tauH.toFixed(0).padStart(4), '  ',
    f(truth.zones[z].Ca), f(res.model.zones[z].Ca), ' ', f(truth.zones[z].Ham), f(res.model.zones[z].Ham), ' ',
    f(truth.links[z] || 0), f(res.model.links[z] || 0), ' ', f(res.report.rmseTrain[i]), f(res.report.rmseVal[i]));
});
for (const z of ['office', 'bedroom', 'living']) console.log('ac', z.padEnd(8), 'Kp', f(truth.ac[z].Kp), f(res.model.ac[z].Kp), 'off', f(truth.ac[z].off), f(res.model.ac[z].off), 'Qmax', f(truth.ac[z].Qmax), f(res.model.ac[z].Qmax));
console.log('neighbours Tnb', f(truth.building.Tnb), f(res.model.building.Tnb));
console.log('plant eta', f(truth.plant.eta), f(res.model.plant.eta), 'Qmax', f(truth.plant.Qmax), f(res.model.plant.Qmax), 'standby', f(truth.plant.standby), f(res.model.plant.standby));
console.log('windows Hw', ['office', 'bedroom', 'living'].map(z => f(truth.zones[z].Hw) + '/' + f(res.model.zones[z].Hw)).join(' '));
// the units' true electricity on the held-out days, which the phase reading only approximates
let trueE = 0;
for (const v of res.validation) for (let i = 0; i < run.rec.t.length; i++) if (run.rec.t[i] >= v.t0 && run.rec.t[i] < v.t0 + 864e5) trueE += run.rec.pel[i] / 60;
console.log('val energy kWh: model', res.report.energy.sim.toFixed(1), '| phase minus other loads', res.report.energy.obs.toFixed(1), '| true', trueE.toFixed(1));
console.log('warnings', res.report.warnings);
