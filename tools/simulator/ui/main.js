import { $, store } from './util.js';
import { buildForm } from './form.js';
import { createRoomView } from './room.js';
import { createFlatView } from './flat.js';

const form = $('params');
buildForm(form);
const views = { room: createRoomView({ form }), flat: createFlatView({ form }) };
let mode = null;

function setMode(m) {
  if (mode) views[mode].deactivate();
  mode = m;
  store.set('acs-sim-mode', m);
  for (const k of Object.keys(views)) {
    $('rail-' + k).hidden = k !== m;
    $('stage-' + k).hidden = k !== m;
    $('mode-' + k).setAttribute('aria-selected', k === m ? 'true' : 'false');
  }
  $('reset').textContent = m === 'flat' ? 'Reset this unit to blueprint defaults' : 'Reset to blueprint defaults';
  views[m].activate();
}

form.addEventListener('input', () => views[mode].input());
form.addEventListener('submit', e => e.preventDefault());
$('reset').addEventListener('click', () => views[mode].reset());
for (const k of Object.keys(views)) $('mode-' + k).addEventListener('click', () => { if (k !== mode) setMode(k); });
let rw = null;
window.addEventListener('resize', () => { clearTimeout(rw); rw = setTimeout(() => views[mode].resize(), 80); });

setMode(store.get('acs-sim-mode') === 'room' ? 'room' : 'flat');
