// Reads [{P, x}] from stdin, writes decide() results to stdout (for blueprint_parity.py).
import { BLUEPRINT_DEFAULTS, decide } from '../src/blueprint.js';
let buf = '';
process.stdin.on('data', d => buf += d).on('end', () => {
  const cases = JSON.parse(buf);
  process.stdout.write(JSON.stringify(cases.map(c => decide(Object.assign({}, BLUEPRINT_DEFAULTS, c.P), c.x))));
});
