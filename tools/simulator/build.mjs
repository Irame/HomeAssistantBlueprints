// Bundles ui/main.js and inlines it into ui/page.html, writing the single
// file ../adaptive_climate_setpoint_simulator.html that opens without a server.
//   npm run build [-- --fragment <path>]   (--fragment also writes the page body alone)
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const out = await build({ entryPoints: [join(here, 'ui/main.js')], bundle: true, format: 'iife', target: 'es2020', write: false, legalComments: 'none' });
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const page = readFileSync(join(here, 'ui/page.html'), 'utf8');
const fragment = page.replace('/*APP*/', () => js);
const [head, body] = fragment.split('<!--/head-->');
const full = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
  + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  + head.trim() + '\n</head>\n<body>\n' + body.trim() + '\n</body>\n</html>\n';
const target = join(here, '..', 'adaptive_climate_setpoint_simulator.html');
writeFileSync(target, full);
const i = process.argv.indexOf('--fragment');
if (i > 0) writeFileSync(process.argv[i + 1], fragment);
console.log('wrote', target, (full.length / 1024).toFixed(0) + ' KB');
