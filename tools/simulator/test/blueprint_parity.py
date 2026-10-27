"""Render the blueprint's refresh-branch templates with real Jinja2 and compare
them with src/blueprint.js on random scenarios.

    python3 test/blueprint_parity.py [seed] [cases]

Needs jinja2 and pyyaml. Home Assistant's template helpers are stubbed just
far enough for this branch.
"""
import ast, json, math, os, random, subprocess, sys, datetime as dt
import yaml, jinja2

HERE = os.path.dirname(os.path.abspath(__file__))
BP = os.path.join(HERE, '..', '..', '..', 'blueprints', 'automation', 'Irame', 'adaptive_climate_setpoint.yaml')

class Input:
    def __init__(self, name): self.name = name
    def __repr__(self): return f'!input {self.name}'
class Loader(yaml.SafeLoader): pass
Loader.add_constructor('!input', lambda l, n: Input(l.construct_scalar(n)))
bp = yaml.load(open(BP), Loader=Loader)

# input defaults
defaults = {}
for sec in bp['blueprint']['input'].values():
    for k, v in sec['input'].items():
        if 'default' in v: defaults[k] = v['default']

refresh = [c for c in bp['action'][0]['choose'] if "'refresh'" in c['conditions']][0]
variables = refresh['sequence'][0]['variables']

_missing = object()
def ha_float(v, default=_missing):
    try: return float(v)
    except (TypeError, ValueError):
        if default is _missing: raise
        return default
def is_number(v):
    try: f = float(v); return not (math.isnan(f) or math.isinf(f))
    except (TypeError, ValueError): return False

class State:
    def __init__(self, eid, state, attrs, last_changed):
        self.entity_id, self.state, self.attributes, self.last_changed = eid, state, attrs, last_changed

def make_env(world, now):
    env = jinja2.Environment(extensions=['jinja2.ext.loopcontrols'])
    class States:
        def __call__(self, eid): return world[eid].state if eid in world else 'unknown'
        def __getitem__(self, eid): return world.get(eid)
    st = States()
    env.globals.update(
        states=st, now=lambda: now,
        is_state=lambda e, s: e in world and world[e].state == s,
        state_attr=lambda e, a: world[e].attributes.get(a) if e in world else None,
        expand=lambda ids: [world[i] for i in ids if i in world],
        strptime=lambda s, f: dt.datetime.strptime(s, f),
        as_timestamp=lambda d: d.timestamp(),
        as_local=lambda d: d,
    )
    env.filters.update(float=ha_float, is_number=is_number, int=lambda v, d=0: int(ha_float(v, d)))
    env.tests['number'] = is_number
    return env

def parse_result(s):
    # Home Assistant's template result parsing (roughly): literal_eval, keep str otherwise
    s = s.strip()
    try:
        v = ast.literal_eval(s)
        if isinstance(v, (int, float, bool, list, dict)): return v
    except Exception: pass
    return s

def run_blueprint(inputs, world, now):
    env = make_env(world, now)
    ctx = {}
    for k, v in variables.items():
        if isinstance(v, Input): ctx[k] = inputs[v.name]
        elif isinstance(v, str):
            r = env.from_string(v).render(**ctx)
            ctx[k] = parse_result(r)
        else: ctx[k] = v
    return ctx

random.seed(int(sys.argv[1]) if len(sys.argv) > 1 else 1)
cases, ctxs = [], []
N = int(sys.argv[2]) if len(sys.argv) > 2 else 400
for n in range(N):
    inp = dict(defaults)
    inp.update(climate_entities=['climate.ac'], weather_entity='weather.home', price_sensor='sensor.price',
               outdoor_sensor='sensor.outdoor', forecast_high_helper='input_number.hi',
               manual_override_context_helper='input_text.ctx', manual_override_timer_helper='timer.t')
    use_fwd, use_near = random.random() < 0.8, random.random() < 0.8
    use_low, use_demand, use_indoor = random.random() < 0.8, random.random() < 0.8, random.random() < 0.7
    inp['price_forecast_sensor'] = ['sensor.fwd'] if use_fwd else []
    inp['price_near_sensor'] = ['sensor.near'] if use_near else []
    inp['forecast_low_helper'] = ['input_number.lo'] if use_low else []
    inp['forward_outdoor_helper'] = ['input_number.fo'] if use_demand else []
    inp['indoor_sensors'] = ['sensor.in1'] if use_indoor else []
    use_win = random.random() < 0.5
    win_open = use_win and random.random() < 0.3
    inp['door_window_sensors'] = ['binary_sensor.win'] if use_win else []
    inp['price_falling_margin'] = random.choice([0.05, 0.1, 0.2])
    inp['price_falling_hold'] = random.choice([0, 0.3, 0.5, 1])
    inp['price_lookahead_margin'] = random.choice([0.1, 0.15, 0.3])
    inp['heating_reference'] = random.choice(['average', 'low', 'high'])
    inp['storage_overrides_schedule'] = random.random() < 0.5
    price = round(random.uniform(0.1, 0.45), 4)
    fwd = round(price * random.uniform(0.7, 1.3), 4)
    near = round(price * random.uniform(0.8, 1.2), 4)
    hi = round(random.uniform(-2, 34), 1); lo = round(hi - random.uniform(2, 12), 1)
    fo = round(random.uniform(-5, 33), 1); outdoor = round(random.uniform(-5, 34), 1)
    indoor = round(random.uniform(17, 26), 2)
    dev_off = random.random() < 0.5
    price_ok = random.random() < 0.95
    hour, minute = random.randrange(24), random.randrange(60)
    now = dt.datetime(2026, 10, 21, hour, minute)
    lc = now - dt.timedelta(minutes=30)
    world = {
        'sensor.price': State('sensor.price', str(price) if price_ok else 'unavailable', {}, lc),
        'sensor.fwd': State('sensor.fwd', str(fwd), {}, lc),
        'sensor.near': State('sensor.near', str(near), {}, lc),
        'sensor.outdoor': State('sensor.outdoor', str(outdoor), {}, lc),
        'sensor.in1': State('sensor.in1', str(indoor), {}, lc),
        'input_number.hi': State('input_number.hi', str(hi), {}, lc),
        'input_number.lo': State('input_number.lo', str(lo), {}, lc),
        'input_number.fo': State('input_number.fo', str(fo), {}, lc),
        'timer.t': State('timer.t', 'idle', {}, lc),
        'binary_sensor.win': State('binary_sensor.win', 'on' if win_open else 'off', {}, lc),
        'climate.ac': State('climate.ac', 'off' if dev_off else 'heat', {'temperature': 21, 'min_temp': 16, 'max_temp': 30, 'target_temp_step': 0.5}, lc),
    }
    ctx = run_blueprint(inp, world, now)
    P = {k: inp[k] for k in ['heat_comfort','heat_charge','heat_coast','cool_comfort','cool_charge','cool_coast','price_cheap','price_expensive','price_lookahead_margin','price_falling_margin','price_falling_hold','demand_cold_ref','demand_hot_ref','cool_day_threshold','heat_day_threshold','heating_reference','storage_overrides_schedule','indoor_deadband']}
    P.update(use_forward=use_fwd, use_near=use_near, use_demand=use_demand, use_indoor=use_indoor, use_windows=use_win,
             night_start=inp['night_start'][:5], night_end=inp['night_end'][:5])
    x = dict(now=int(now.timestamp() * 1000), price=price if price_ok else None, fwdMean=fwd if use_fwd else None,
             nearMean=near if use_near else None, outdoor=outdoor, fwdOutdoor=fo if use_demand else None,
             high=hi, low=lo if use_low else None, indoor=indoor if use_indoor else None, deviceOff=dev_off, windowOpen=win_open)
    cases.append(dict(P=P, x=x)); ctxs.append(ctx)

res = json.loads(subprocess.run(['node', os.path.join(HERE, 'decide_cli.mjs')], input=json.dumps(cases), capture_output=True, text=True, check=True).stdout)
keys = [('day_type','day_type'),('price_signal_absolute','sig_abs'),('price_signal_forward','sig_fwd'),('price_falling','falling'),
        ('price_signal','signal'),('demand_factor','demand'),('effective_charge','eff_charge'),('target_temp','target'),
        ('storage_charging','storage_charging'),('indoor_satisfied','indoor_satisfied'),('window_open','window_open'),
        ('should_be_off','should_be_off'),('desired_mode','desired_mode')]
bad = 0
for i, (ctx, r) in enumerate(zip(ctxs, res)):
    for bk, sk in keys:
        a, b = ctx[bk], r[sk]
        if isinstance(a, str) or isinstance(b, str) or isinstance(a, bool) or isinstance(b, bool):
            ok = str(a).strip().lower() == str(b).strip().lower()
        else:
            ok = abs(float(a) - float(b)) < 1e-6
        if not ok:
            bad += 1
            if bad <= 15: print('MISMATCH case', i, bk, repr(a), sk, repr(b))
print(f'{N} cases, {bad} mismatches')
held = sum(1 for c in ctxs if abs(float(c['price_signal']) - float(c['price_signal_combined'])) > 1e-9)
windows = sum(1 for c in ctxs if c['window_open'] is True)
print(f'signal changed by the falling-price hold: {held}, window open: {windows}')
sys.exit(1 if bad else 0)
