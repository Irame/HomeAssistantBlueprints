# Home Assistant Blueprints

A collection of Home Assistant automation blueprints.

## Blueprints

### Adaptive Climate Setpoint (Forecast + Tibber Price)

Automatically switches your climate devices between heating, cooling, and off, and continuously adjusts the target temperature based on:

- **Today's forecast** (from any `weather` entity) — decides whether it's a heating day, a cooling day, or falls in a dead band where the device stays off all day. Cooling is decided on the day's **high**; heating is decided on the **average of the high and low**, because heating load follows the whole day rather than its warmest moment.
- **Severity** — how far that reference temperature sits between the day threshold and your configured "hot"/"cold" reference temperatures, scaled into the target temperature.
- **Electricity price** (from a Tibber or similar dynamic-price sensor) — dampens the target back toward baseline when electricity is expensive. "Cheap" and "expensive" are **fixed absolute thresholds** by default, so a day that is costly from morning to night stays costly; the old behaviour of scaling against today's cheapest/most expensive hour is still available as an option.
- **Thermal storage** — while the price is at or below the cheap threshold, the target is pushed *past* its normal limit (cooling below Cooling Setpoint Min, heating above Heating Setpoint Max) to charge the building itself, so less has to be bought while power is expensive.
- **Night mode** — forces the device off during a configurable overnight window.
- **Live outdoor temperature** — turns the device off mid-run if the outdoor temperature already satisfies the target (e.g. it's already colder outside than the cooling target), avoiding pointless standby operation.

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FIrame%2FHomeAssistantBlueprints%2Fblob%2Fmaster%2Fblueprints%2Fautomation%2FIrame%2Fadaptive_climate_setpoint.yaml)

#### Requirements

- A `weather` entity that supports `weather.get_forecasts` with `type: daily`, returning `temperature` (the day's high) and, for the default heating reference, `templow` (the day's low).
- A dynamic electricity price sensor whose state is the current price (e.g. the official Tibber integration's `sensor.electricity_price_<home_name>`). `min_price`/`max_price` attributes are only needed if you choose the "Today's min/max" price reference.
- An outdoor temperature sensor (`sensor` domain, `device_class: temperature`).
- One or more `climate` entities that support `hvac_mode: heat`, `hvac_mode: cool`, and `hvac_mode: off`.

#### Inputs

| Input | Description | Default |
|---|---|---|
| Climate Entities | The climate device(s) this automation controls | — |
| Forecast Low Storage Helper | Optional `input_number` holding today's forecast low | — |
| Weather Entity | Used to read today's forecasted high | — |
| Electricity Price Sensor | Current price sensor | — |
| Outdoor Temperature Sensor | Live outdoor temperature for the real-time override | — |
| Cooling Setpoint Min | Most aggressive cooling target, used on the hottest days | 21°C |
| Cooling Setpoint Baseline | Where cooling starts from (severity 0) | 24°C |
| Heating Setpoint Baseline | Where heating starts from (severity 0) | 21°C |
| Heating Setpoint Max | Most aggressive heating target, used on the coldest days | 26°C |
| Cooling Day Threshold | Forecast high above which today is a cooling day (outdoor) | 24°C |
| Heating Day Reference | Which part of the forecast heating reads: average / low / high | Average |
| Heating Day Threshold | Heating reference below which today is a heating day (outdoor) | 16°C |
| Hot Day Reference | Forecast high at which cooling severity reaches maximum | 30°C |
| Cold Day Reference | Heating reference at which heating severity reaches maximum | 0°C |
| Electricity Price Influence | 0 = ignore price, 1 = full influence | 0.5 |
| Price Reference | Fixed thresholds, or today's min/max | Fixed |
| Cheap Price Threshold | At or below this, power counts as fully cheap | 0.20 |
| Expensive Price Threshold | At or above this, power counts as fully expensive | 0.35 |
| Storage Boost | How far past the setpoint limit to charge when cheap (0 = off) | 1.5°C |
| Charge Outside Normal Hours | Let cheap-price charging ignore night mode | off |
| Night Mode Start | Time the device is forced off overnight | 22:00:00 |
| Night Mode End | Time night mode ends | 06:00:00 |

Note: `Heating Day Threshold` and `Cold Day Reference` are read in terms of whichever **Heating Day Reference** you pick. The shipped defaults (16°C / 0°C) suit the default *average*; switching to *forecast high* means raising both by roughly 5°C.

Note: the **indoor** setpoints and the **outdoor** day thresholds are separate inputs. `Cooling Day Threshold` must be greater than `Heating Day Threshold`; the gap between them is the dead band, where the automation keeps the device off all day.

#### How it decides the target temperature

1. **Day type** — `cool` if today's captured forecast high is above the Cooling Day Threshold; otherwise `heat` if the *heating reference* (by default the average of the captured high and low) is below the Heating Day Threshold; otherwise `off` for the whole day. Cooling is checked first, so the heating reference never affects summer.
2. **Severity** (0–1) — how far the relevant reference temperature sits between its day threshold and the hot/cold reference temperature.
3. **Price position** (0–1) — 0 at or below the cheap threshold, 1 at or above the expensive one.
4. **Price dampening** — the price position pulls severity back down, proportionally to the price influence weight.
5. **Storage boost** — the *cheapness* (1 − price position) pushes the target past its limit by up to `Storage Boost × price influence` degrees, so cheap hours charge the building.
6. **Target temperature** — baseline shifted toward the min (cooling) or max (heating) setpoint by the dampened severity, then boosted, then snapped to each device's own temperature step and clamped to its own `min_temp`/`max_temp`.
7. **Off overrides** — an open window, a disabled weekday, nobody home, or a dead-band day always force the device off. Night mode and the live outdoor override also force it off, unless *Charge Outside Normal Hours* is on and the price is at or below the cheap threshold.

The automation only sends a command when the mode or setpoint would actually change, so devices are not re-commanded every minute.

#### Behaviour when a sensor drops out

- **Price sensor** unavailable → treated as fully expensive: no storage charging, maximum dampening. A failed sensor never causes spending.
- **Outdoor sensor** unavailable → the live outdoor override is skipped rather than guessed.
- **Forecast high helper** not yet set → the automation does nothing until the next capture.
- **Forecast low helper** not configured, or the weather entity reports no `templow` → the heating reference falls back to the forecast high. The `heating_reference_degraded` variable in the trace tells you this happened.

## Installation

1. Click the import badge above, **or** manually go to **Settings → Automations & Scenes → Blueprints tab → Import Blueprint**, and paste:
   ```
   https://github.com/Irame/HomeAssistantBlueprints/blob/master/blueprints/automation/Irame/adaptive_climate_setpoint.yaml
   ```
2. Click **Preview**, then **Import Blueprint**.
3. Go to **Settings → Automations & Scenes → Create Automation → Use Blueprint**, select **Adaptive Climate Setpoint (Forecast + Tibber Price)**, and fill in your entities and setpoints.
4. Create one automation instance per climate device (or group of devices) if they need independent setpoints, sensors, or schedules.

## Testing before relying on it

Before letting it run unattended:

- Trigger the automation manually and check its **trace** — confirm `day_type`, `severity`, `target_temp`, and `should_be_off` compute the values you expect for today's actual forecast, price, and outdoor temperature.
- Confirm your climate entities support `hvac_mode: "off"` (check the `hvac_modes` attribute in **Developer Tools → States**); some devices require `climate.turn_off` instead.
- Confirm your weather entity's `weather.get_forecasts` response actually contains `temperature` and `templow` fields for the first forecast entry (test it directly in **Developer Tools → Actions**).
- Confirm your price sensor's state is a plain number in the unit you used for the cheap/expensive thresholds (Tibber reports EUR/kWh, e.g. `0.28`, not ct/kWh).

## License

MIT.
