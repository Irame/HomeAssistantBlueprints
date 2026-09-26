# Home Assistant Blueprints

A collection of Home Assistant automation blueprints.

## Blueprints

### Adaptive Climate Setpoint (Forecast + Tibber Price)

Automatically switches your climate devices between heating, cooling, and off, and continuously adjusts the target temperature based on:

- **Today's forecast** (from any `weather` entity) — decides *whether* today heats, cools, or stays off in a dead band. Cooling is decided on the day's **high**; heating on the **average of the high and low**, because heating load follows the whole day rather than its warmest moment. The forecast does **not** move the setpoint.
- **Electricity price** — decides *where in your comfort range* the setpoint sits. One signed signal runs from **charge** (cheap) through **comfort** (neutral) to **coast** (expensive).
- **The demand ahead** (from the hourly forecast) — decides *how deeply* to charge. A cheap hour before a cold night is worth far more than the same cheap hour before a mild evening.
- **Night mode**, **disabled weekdays**, **presence**, **open windows** — force the device off.
- **Measured room temperature** (optional, any number of sensors) — holds the device off while the rooms are already past the target, which a unit's own thermostat often cannot judge from inside its own airflow.
- **Live outdoor temperature** — turns the device off mid-run if it's already warmer/colder outside than your comfort target, avoiding pointless standby operation.

#### The comfort axis

Each mode has three temperatures you set, and price slides the target between them:

```
COOLING                                HEATING
  charge  21.0 C   cheap power           charge  23.5 C   cheap power
  comfort 24.0 C   neutral price         comfort 21.0 C   neutral price
  coast   26.5 C   expensive power       coast   19.0 C   expensive power
```

`target = comfort + p × (coast − comfort)` when `p > 0`, else `comfort + p × (comfort − charge)`, where `p` is the price signal in −1…+1. At a neutral price the target is exactly your comfort temperature.

These three numbers are the only dial price has. There is no separate influence weight, because moving an anchor toward comfort *is* how you give price less say — comfort is the fixed point of the axis, so halving the distance and halving a weight are the same operation. Setting **charge = comfort** disables thermal storage for that mode, **coast = comfort** means never trading comfort for price, and setting all three equal pins the target and ignores price entirely.

#### How deep to charge

Price says *when* to charge. It cannot say how much is worth storing — that depends on how much energy the coming hours will actually consume. The mean forecast outdoor temperature over the lookahead window becomes a 0–1 demand factor, measured from your comfort setpoint (where the building loses nothing) to a configurable reference where demand is maximal. That factor pulls the charge anchor back toward comfort:

```
heating, comfort 21 C, full demand at 0 C, price fixed at "cheap"

  next 6h mean  20 C   demand 0.05  #                                target 21.0 C
  next 6h mean  16 C   demand 0.24  #######                          target 21.5 C
  next 6h mean  12 C   demand 0.43  #############                    target 22.0 C
  next 6h mean   8 C   demand 0.62  ###################              target 22.5 C
  next 6h mean   4 C   demand 0.81  ########################         target 23.0 C
  next 6h mean   0 C   demand 1.00  ##############################   target 23.5 C
```

Demand only ever *reduces* charge depth — it never pushes past the Charge temperature you set. Coast is deliberately left alone, because how much comfort to give up is a comfort decision, not a demand one.

This needs the **Forward Outdoor Mean Storage Helper**, which a separate 15-minute trigger fills from `weather.get_forecasts` with `type: hourly`. Without it the demand factor is 1 and charge depth is unscaled.

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FIrame%2FHomeAssistantBlueprints%2Fblob%2Fmaster%2Fblueprints%2Fautomation%2FIrame%2Fadaptive_climate_setpoint.yaml)

#### Requirements

- A `weather` entity that supports `weather.get_forecasts` with `type: daily`, returning `temperature` (the day's high) and, for the default heating reference, `templow` (the day's low). For demand-scaled charging it must also support `type: hourly`.
- A dynamic electricity price sensor whose state is the current price as a plain number (e.g. the official Tibber integration's `sensor.electricity_price_<home_name>`), in the same unit as your cheap/expensive thresholds.
- An outdoor temperature sensor (`sensor` domain, `device_class: temperature`).
- Optionally, one or more indoor temperature sensors (`sensor` domain, `device_class: temperature`).
- One or more `climate` entities that support `hvac_mode: heat`, `hvac_mode: cool`, and `hvac_mode: off`.

#### Inputs

| Input | Description | Default |
|---|---|---|
| Climate Entities | The climate device(s) this automation controls | — |
| Forecast Low Storage Helper | Optional `input_number` holding today's forecast low | — |
| Forward Outdoor Mean Storage Helper | Optional `input_number` holding the mean outdoor temp of the coming hours | — |
| Demand Lookahead | Hours of hourly forecast averaged to judge coming demand | 6 h |
| Full Heating Demand Below | Forward outdoor mean at which heating demand is maximal | 0°C |
| Full Cooling Demand Above | Forward outdoor mean at which cooling demand is maximal | 32°C |
| Weather Entity | Used to read today's forecasted high | — |
| Electricity Price Sensor | Current price sensor | — |
| Outdoor Temperature Sensor | Live outdoor temperature for the real-time override | — |
| Indoor Temperature Sensors | Optional sensors representing the rooms served | — |
| Indoor Deadband | How far past target the rooms go before the device is held off | 1.0 K |
| Cooling — Comfort | Cooling target at a neutral price | 24°C |
| Cooling — Charge | Coldest accepted while banking cheap power | 21°C |
| Cooling — Coast | Warmest tolerated while riding out expensive hours | 26.5°C |
| Heating — Comfort | Heating target at a neutral price | 21°C |
| Heating — Charge | Warmest accepted while banking cheap power | 23.5°C |
| Heating — Coast | Coolest tolerated while riding out expensive hours | 19°C |
| Cooling Day Threshold | Forecast high above which today is a cooling day (outdoor) | 24°C |
| Heating Day Reference | Which part of the forecast heating reads: average / low / high | Average |
| Heating Day Threshold | Heating reference below which today is a heating day (outdoor) | 16°C |
| Cheap Price Threshold | At or below this, power counts as fully cheap | 0.20 |
| Expensive Price Threshold | At or above this, power counts as fully expensive | 0.35 |
| Forward Average Price Sensor | Optional sensor holding the mean price of the coming hours | — |
| Forward Price Margin | How far below the forward average earns a full charge signal | 0.15 |
| Charge Outside Normal Hours | Let cheap-price charging ignore night mode | off |
| Night Mode Start | Time the device is forced off overnight | 22:00:00 |
| Night Mode End | Time night mode ends | 06:00:00 |

Note: `Heating Day Threshold` is read in terms of whichever **Heating Day Reference** you pick. The shipped default (16°C) suits the default *average*; switching to *forecast high* means raising it by roughly 5°C.

Note: the **indoor** setpoints and the **outdoor** day thresholds are separate inputs. `Cooling Day Threshold` must be greater than `Heating Day Threshold`; the gap between them is the dead band, where the automation keeps the device off all day.

#### How it decides the target temperature

1. **Day type** — `cool` if today's captured forecast high is above the Cooling Day Threshold; otherwise `heat` if the *heating reference* (by default the average of the captured high and low) is below the Heating Day Threshold; otherwise `off` for the whole day. Cooling is checked first, so the heating reference never affects summer.
2. **Absolute price signal** (−1…+1) — −1 at or below the cheap threshold, +1 at or above the expensive one.
3. **Forward price signal** (−1…+1) — only if a Forward Average Price Sensor is set: how far the current price sits below or above the mean price of the coming hours, scaled by the Forward Price Margin. Without it, only the absolute signal is used.
4. **Combined signal** — the two are averaged, so charging requires both to agree that now is a good moment.
5. **Demand factor** (0–1) — how much heating or cooling the lookahead window will need, from the forward outdoor mean. It pulls the charge anchor toward comfort so shallow demand earns a shallow charge.
6. **Target temperature** — slid along the Charge…Comfort…Coast axis by that signal, then snapped to each device's own temperature step and clamped to its own `min_temp`/`max_temp`.
7. **Off overrides** — an open window, a disabled weekday, nobody home, a dead-band day, or the rooms already being past target always force the device off. Night mode and the live outdoor override also force it off, unless *Charge Outside Normal Hours* is on and the automation is genuinely charging.

#### Not running when the rooms are already there

A split unit measures at its own intake, inside its own airflow, so it often cannot tell whether the room has actually arrived — it idles, trickles, or cycles when nothing is needed. Point **Indoor Temperature Sensors** at whatever genuinely represents the rooms (one hallway sensor covering several rooms works well) and the mean of them gates the device.

The comparison is against the target **currently in force**, not your comfort setpoint. During a cheap-power charge that means it asks whether the charge has landed, not merely whether the room is comfortable — and because the energy is then in the building, this is one of the off reasons thermal storage never bypasses.

It uses real hysteresis, so it does not chatter around the comparison point:

```
cooling, target 24.0 C, deadband 1.0 K

  room 26.0 -> RUN     room 23.2 -> OFF
  room 24.2 -> RUN     room 23.8 -> OFF     (drifting back up, stays off)
  room 23.5 -> RUN     room 24.0 -> RUN     (back at target, resumes)
  room 23.0 -> OFF     room 25.0 -> RUN
```

Sensors reporting `unknown` or `unavailable` are skipped; if none are left the check disables itself and each device's own thermostat decides, as it did before. A tight deadband makes an inverter compressor cycle, which costs more than letting it modulate — 1 K or more is usually kinder than precise control.

#### Why two price signals

A fixed threshold alone cannot tell whether waiting would be cheaper. Scaling against the day's own cheapest and dearest hour instead has the opposite flaw — it always nominates *some* hour as cheap, even on a day that is costly from morning to night — which is why that mode was dropped. Storing energy only pays when now is cheap **and** cheaper than when the stored energy will be used, so both halves must agree:

| Situation | now | next 6h | absolute | forward | result |
|---|---|---|---|---|---|
| Expensive all day, mid | 0.42 | 0.44 | +1.00 | −0.30 | 25.0°C coast |
| Expensive all day, its dip | 0.38 | 0.45 | +1.00 | −1.00 | 24.0°C comfort |
| Expensive day, real cheap window | 0.26 | 0.45 | −0.20 | −1.00 | 22.0°C charge |
| Cheap night, cheapest hour | 0.08 | 0.10 | −1.00 | −1.00 | 21.0°C full charge |
| Cheap day, its priciest hour | 0.17 | 0.12 | −1.00 | +1.00 | 24.0°C wait for the dip |

With the [tibber_prices](https://github.com/jpawlowski/hass.tibber_prices) HACS integration, point *Forward Average Price Sensor* at one of its `Price Next Nh` sensors — around 6h roughly matches how long a building holds a charge. Any sensor whose state is a forward mean price works; without one, only the absolute half is used.

The automation only sends a command when the mode or setpoint would actually change, so devices are not re-commanded every minute.

#### Behaviour when a sensor drops out

- **Price sensor** unavailable → treated as fully expensive, so the target sits at *coast*. A failed sensor never causes spending.
- **Forward average price sensor** unavailable, unset, or reporting zero → the forward half is dropped and the signal falls back to the absolute thresholds alone.
- **Forward outdoor mean helper** unset, or the weather entity returns no usable hourly forecast → the demand factor is 1, so charge depth is unscaled. The helper is simply not written rather than being filled with a wrong value.
- **Outdoor sensor** unavailable → the live outdoor override is skipped rather than guessed.
- **Indoor sensors** all unavailable, or none configured → the room check disables itself and the devices' own thermostats decide.
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

- Trigger the automation manually and check its **trace** — confirm `day_type`, `price_signal_absolute`, `price_signal_forward`, `price_signal`, `demand_factor`, `effective_charge`, `target_temp`, `indoor_temp`, `indoor_satisfied` and `should_be_off` compute the values you expect for today's actual forecast, price, and temperatures.
- Confirm `weather.get_forecasts` with `type: hourly` returns entries with a `temperature` field (**Developer Tools → Actions**), then check the Forward Outdoor Mean helper gets a sensible number within 15 minutes.
- Confirm your climate entities support `hvac_mode: "off"` (check the `hvac_modes` attribute in **Developer Tools → States**); some devices require `climate.turn_off` instead.
- Confirm your weather entity's `weather.get_forecasts` response actually contains `temperature` and `templow` fields for the first forecast entry (test it directly in **Developer Tools → Actions**).
- Confirm your price sensor's state is a plain number in the unit you used for the cheap/expensive thresholds (Tibber reports EUR/kWh, e.g. `0.28`, not ct/kWh).

## License

MIT.
