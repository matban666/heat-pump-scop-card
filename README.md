# Heat Pump SCOP Card

A Home Assistant Lovelace card that plots daily heat pump SCOP against mean outside temperature, with a quadratic trend line per period. Use it to compare performance across seasons, setpoints or hardware changes.

Data comes from Home Assistant's long-term statistics, so it needs no InfluxDB and keeps its full history after the recorder purges raw states.

## Requirements

The **Heat Pump Monitor** integration (`heat_pump_monitor`) must be installed and configured. Each night it calculates the daily values this card reads:

- mean inside and outside temperature
- CH and DHW energy in/out
- CH and DHW SCOP

The card finds the integration's config entry automatically.

## Installation

### HACS (custom repository)

1. HACS → ⋮ → **Custom repositories**
2. Repository: `https://github.com/matban666/heat-pump-scop-card`, type **Dashboard**
3. Install **Heat Pump SCOP Card**, then reload the browser

### Manual

1. Copy `dist/heat-pump-scop.js` to `/config/www/`
2. Add a resource: `/local/heat-pump-scop.js`, type **JavaScript Module**
3. Hard-refresh the browser

## Configuration

```yaml
type: custom:heat-pump-scop-card
title: SCOP
days: 365
scop_type: ch
setpoint: 22
cop_threshold: 1
energy_in_threshold: 0.1
color_periods:
  - name: 9kW
    endDate: "2025-11-18"
    setpoint: 21
    startColor: "#7ca4d9"
    endColor: "#2468bf"
  - name: 8kW
    endDate: now
    setpoint: 22
    startColor: "#f78d8d"
    endColor: "#ee1a1a"
```

| Option | Default | Description |
|---|---|---|
| `title` | `Heat Pump SCOP Performance` | Card title |
| `days` | `365` | Days of history to plot |
| `scop_type` | `ch` | `ch`, `dhw`, `combined` (CH + DHW energy) or `both` (CH and DHW as separate points) |
| `setpoint` | `21` | Indoor setpoint shown in stats when a period doesn't set its own |
| `cop_threshold` | `1` | Drop days with SCOP at or below this |
| `energy_in_threshold` | `0.1` | Drop days with energy in (kWh) at or below this |
| `width` / `height` | `700` / `400` | Chart size in pixels |
| `color_periods` | none | Periods with their own colour gradient and trend line. Each has `name`, `endDate` (`YYYY-MM-DD` or `now`), optional `setpoint`, `startColor`, `endColor` |
| `entry_id` | auto | Heat Pump Monitor config entry to read, if you have more than one |

Days are also dropped when the inside temperature isn't above the outside temperature.
