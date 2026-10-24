// Apartment export for the Climate Setpoint Simulator.
// Read-only: it reads history and statistics and writes nothing to Home Assistant.
// Open Home Assistant in a desktop browser, press F12, open the Console,
// paste all of this and press Enter. It saves apartment-export.json.
(async () => {
  const DAYS = 30; // Home Assistant keeps 10 days of detail unless recorder: purge_keep_days says otherwise
  const hass = document.querySelector('home-assistant').hass;
  const now = new Date(), iso = d => d.toISOString();
  const since = days => new Date(now - days * 864e5);
  const st = hass.states, all = Object.keys(st);
  const at = e => st[e].attributes || {};
  const dc = e => at(e).device_class;
  const unit = e => String(at(e).unit_of_measurement || '');
  const name = e => String(at(e).friendly_name || e).toLowerCase();
  const isTemp = e => dc(e) === 'temperature' || /°[CF]/.test(unit(e));
  const isPower = e => dc(e) === 'power' || /^k?W$/.test(unit(e));
  const isPrice = e => /\/\s*kWh$/i.test(unit(e));
  const isOpening = e => ['window', 'door', 'opening', 'garage_door'].includes(dc(e))
    || (!dc(e) && /fenster|window|balkon|terrasse|tür|tuer|door/.test(name(e) + ' ' + e));
  const sensors = all.filter(e => e.startsWith('sensor.') && (isTemp(e) || isPower(e) || isPrice(e) || dc(e) === 'humidity'));
  const histIds = all.filter(e => e.startsWith('climate.') || e.startsWith('weather.') || e.startsWith('person.')
    || (e.startsWith('binary_sensor.') && isOpening(e)));
  const reg = e => (hass.entities && hass.entities[e]) || {};
  const areaOf = e => {
    const r = reg(e), dev = r.device_id && hass.devices && hass.devices[r.device_id];
    const a = r.area_id || (dev && dev.area_id);
    return a && hass.areas && hass.areas[a] ? hass.areas[a].name : null;
  };
  const meta = {};
  for (const e of sensors.concat(histIds)) {
    const a = at(e);
    meta[e] = {
      name: a.friendly_name || null, device_class: dc(e) || null, unit: a.unit_of_measurement || null,
      area: areaOf(e), device: reg(e).device_id || null,
      ...(e.startsWith('climate.') ? { hvac_modes: a.hvac_modes, min_temp: a.min_temp, max_temp: a.max_temp, step: a.target_temp_step } : {}),
    };
  }
  const stats = (period, days, ids) => ids.length ? hass.callWS({ type: 'recorder/statistics_during_period',
    start_time: iso(since(days)), end_time: iso(now), statistic_ids: ids, period, types: ['mean'] }) : {};
  const pack = s => { const o = {}; for (const id in s) o[id] = s[id].filter(r => r.mean !== null && r.mean !== undefined).map(r => [r.start, r.mean]); return o; };
  console.log('Reading 5-minute statistics...');
  const short = pack(await stats('5minute', DAYS, sensors));
  console.log('Reading hourly statistics...');
  const hourly = pack(await stats('hour', 90, sensors.filter(e => isTemp(e) || isPower(e))));
  const history = {};
  const hist = async (ids, extra) => ids.length ? hass.callApi('GET', 'history/period/' + iso(since(DAYS))
    + '?end_time=' + encodeURIComponent(iso(now)) + '&filter_entity_id=' + ids.join(',') + extra) : [];
  // sensors without long-term statistics (no state_class), prices among them, come from their history
  const missing = sensors.filter(e => !short[e] || !short[e].length);
  console.log('Reading history...');
  for (const list of await hist(missing, '&minimal_response&no_attributes')) {
    const id = list.length && list[0].entity_id;
    for (const s of list) { const v = parseFloat(s.state); if (id && !isNaN(v)) (history[id] = history[id] || []).push([s.last_changed || s.last_updated, v]); }
  }
  for (const list of await hist(histIds, '&significant_changes_only=0'))
    for (const s of list) {
      const a = s.attributes || {}, t = s.last_updated || s.last_changed, e = s.entity_id;
      if (!e) continue;
      (history[e] = history[e] || []).push(e.startsWith('climate.')
        ? [t, s.state, a.temperature ?? null, a.current_temperature ?? null, a.hvac_action ?? null, a.fan_mode ?? null]
        : e.startsWith('weather.') ? [t, s.state, a.temperature ?? null, a.cloud_coverage ?? null]
        : [t, s.state]);
    }
  const out = {
    exported: iso(now), ha_version: hass.config.version,
    // rounded to about 10 km: enough for the sun's position
    location: { lat: Math.round(hass.config.latitude * 10) / 10, lon: Math.round(hass.config.longitude * 10) / 10, tz: hass.config.time_zone },
    meta, stats_5min: short, stats_hourly: hourly, history,
  };
  const text = JSON.stringify(out);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = 'apartment-export.json';
  document.body.appendChild(link); link.click(); link.remove();
  console.log('Saved apartment-export.json, ' + (text.length / 1e6).toFixed(1) + ' MB: '
    + sensors.length + ' sensors, ' + histIds.length + ' other entities.');
})().catch(e => console.error('Export failed:', e));
