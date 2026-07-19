# Home Assistant Blueprints

A collection of Home Assistant automation blueprints.

## Blueprints

### Adaptive Climate Setpoint (Forecast + Tibber Price)

Automatically switches your climate devices between heating, cooling, and off, and continuously adjusts the target temperature based on:

- **Today's forecasted high** (from any `weather` entity) — decides whether it's a heating day, a cooling day, or falls in a dead band where the device stays off all day.
- **Severity** — how far the forecasted high sits between your baseline and your configured "hot"/"cold" reference temperatures, scaled into the target temperature.
- **Electricity price** (from a Tibber or similar dynamic-price sensor with `min_price`/`max_price` attributes) — dampens the target back toward baseline when electricity is expensive, and allows the full range when it's cheap.
- **Night mode** — forces the device off during a configurable overnight window.
- **Live outdoor temperature** — turns the device off mid-run if the outdoor temperature already satisfies the target (e.g. it's already colder outside than the cooling target), avoiding pointless standby operation.

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FIrame%2FHomeAssistantBlueprints%2Fblob%2Fmain%2Fblueprints%2Fautomation%2FIrame%2Fadaptive_climate_setpoint.yaml)

#### Requirements

- A `weather` entity that supports `weather.get_forecasts` with `type: daily`, and returns a `temperature` field for today's forecast (the day's high).
- A dynamic electricity price sensor exposing `min_price` and `max_price` attributes for the current day (e.g. the official Tibber integration's `sensor.electricity_price_<home_name>`).
- An outdoor temperature sensor (`sensor` domain, `device_class: temperature`).
- One or more `climate` entities that support `hvac_mode: heat`, `hvac_mode: cool`, and `hvac_mode: off`.

#### Inputs

| Input | Description | Default |
|---|---|---|
| Climate Entities | The climate device(s) this automation controls | — |
| Weather Entity | Used to read today's forecasted high | — |
| Electricity Price Sensor | Current price sensor with `min_price`/`max_price` attributes | — |
| Outdoor Temperature Sensor | Live outdoor temperature for the real-time override | — |
| Cooling Setpoint Min | Most aggressive cooling target, used on the hottest days | 21°C |
| Cooling Setpoint Baseline | Where cooling starts from (severity 0) | 24°C |
| Heating Setpoint Baseline | Where heating starts from (severity 0) | 21°C |
| Heating Setpoint Max | Most aggressive heating target, used on the coldest days | 26°C |
| Hot Day Reference | Forecasted high at which cooling severity reaches maximum | 30°C |
| Cold Day Reference | Forecasted high at which heating severity reaches maximum | 5°C |
| Electricity Price Influence | 0 = ignore price, 1 = full influence | 0.5 |
| Night Mode Start | Time the device is forced off overnight | 22:00:00 |
| Night Mode End | Time night mode ends | 06:00:00 |

Note: `Cooling Setpoint Baseline` must be greater than `Heating Setpoint Baseline`. The gap between them is the dead band — on days where the forecasted high falls between the two, the automation keeps the device off all day.

#### How it decides the target temperature

1. **Day type** — `cool` if today's forecasted high is above the cooling baseline, `heat` if it's below the heating baseline, otherwise `off` for the whole day.
2. **Severity** (0–1) — how far the forecasted high sits between the relevant baseline and the hot/cold reference temperature.
3. **Price dampening** — today's current price is normalized against today's min/max price, then used to pull severity back down proportionally to the configured price influence weight.
4. **Target temperature** — baseline shifted toward the min (cooling) or max (heating) threshold by the dampened severity, rounded to the nearest 0.5°C.
5. **Off overrides** — night mode, a dead-band day, the price dampening having pulled the target back to baseline, or the live outdoor temperature already satisfying the target, all force the device off regardless of the above.

## Installation

1. Click the import badge above, **or** manually go to **Settings → Automations & Scenes → Blueprints tab → Import Blueprint**, and paste:
   ```
   https://github.com/Irame/HomeAssistantBlueprints/blob/main/blueprints/automation/Irame/adaptive_climate_setpoint.yaml
   ```
2. Click **Preview**, then **Import Blueprint**.
3. Go to **Settings → Automations & Scenes → Create Automation → Use Blueprint**, select **Adaptive Climate Setpoint (Forecast + Tibber Price)**, and fill in your entities and setpoints.
4. Create one automation instance per climate device (or group of devices) if they need independent setpoints, sensors, or schedules.

## Testing before relying on it

Before letting it run unattended:

- Trigger the automation manually and check its **trace** — confirm `day_type`, `severity`, `target_temp`, and `should_be_off` compute the values you expect for today's actual forecast, price, and outdoor temperature.
- Confirm your climate entities support `hvac_mode: "off"` (check the `hvac_modes` attribute in **Developer Tools → States**); some devices require `climate.turn_off` instead.
- Confirm your weather entity's `weather.get_forecasts` response actually contains a `temperature` field for the first forecast entry (test it directly in **Developer Tools → Actions**).
- Confirm your price sensor exposes `min_price`/`max_price` attributes for today.

## License

MIT.
