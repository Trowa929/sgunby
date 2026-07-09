# Grafana Dashboards-as-Code

A self-contained, provisioned Grafana + Prometheus + Alertmanager stack for
home lab and off-grid power monitoring, built entirely as code. Clone it,
run `docker compose up`, and you get four working dashboards with live
(simulated) data and real alert rules — no manual clicking-around in the
Grafana UI required.

The centerpiece is a **LiFePO4 battery bank monitor** modeled on a
Raspberry Pi that reads a Bluetooth LE battery management system (BMS) and
bridges the readings into Prometheus, with alerting when pack voltage gets
dangerously low. Three supporting dashboards round out a realistic home-lab
observability stack: solar/inverter power flow, a Kubernetes app, and
general server/media health.

![status](https://img.shields.io/badge/status-demo--ready-brightgreen)
![grafana](https://img.shields.io/badge/grafana-11.x-orange)
![prometheus](https://img.shields.io/badge/prometheus-2.53-red)

---

## Why this repo exists

Dashboards that only live inside a Grafana UI are invisible, unversioned,
and impossible to review or diff. Everything here — dashboards, alert
rules, datasource wiring, even the metrics source — is a text file you can
`git diff`, PR, and deploy the same way every time. It's meant to double as:

- A **working reference** for anyone setting up battery/solar monitoring
  with a Raspberry Pi + BLE BMS + Prometheus + Grafana.
- A **portfolio piece** demonstrating dashboards-as-code, Prometheus
  alerting, and provisioning practices for infra/DevOps work.

---

## Architecture

```
┌─────────────────────┐        BLE        ┌──────────────────────────┐
│  LiFePO4 Battery     │ ◄────────────────►│   Raspberry Pi            │
│  Bank + Smart BMS     │  (GATT notify)    │   ble_battery_exporter    │
│  (Pytes / Maple Leaf) │                   │   :9101/metrics           │
└─────────────────────┘                    └──────────┬────────────────┘
                                                        │ scrape (15s)
┌───────────────────────┐  Modbus/TCP     ┌─────────────▼───────────┐
│  Solar Inverter         │◄──────────────►│      Prometheus            │
│  (LuxPower LXP series)  │  (poller,       │  scrape + alert_rules.yml  │
└───────────┬──────────────┘  not included) └──────┬──────────┬────────┘
            │ scrape                                │          │
┌───────────▼────────────┐                          │   ┌──────▼───────┐
│  Kubernetes cluster       │◄─────────────────────────┘   │ Alertmanager │
│  (kube-state-metrics,      │        scrape                └──────┬───────┘
│   cAdvisor, node metrics) │                                       │
└───────────┬────────────┘                                          │ webhook /
            │ scrape                                                 │ email / etc
┌───────────▼────────────┐                                          ▼
│  Home server (Plex,        │                                (your notifier)
│  windows_exporter)         │
└─────────────────────────┘
                                          ┌───────────────────────┐
                                          │        Grafana           │
                                          │  provisioned datasource  │
                                          │  + 4 provisioned          │
                                          │    dashboards             │
                                          └───────────────────────┘
```

This repo ships a **working simulator** for the BLE battery exporter so the
whole stack runs with zero real hardware attached. The other three
metrics sources (inverter, Kubernetes, home server) are documented and
wired into `prometheus.yml` as ready-to-uncomment scrape jobs — swap in
your real exporters and the dashboards work unmodified.

---

## Repo structure

```
.
├── docker-compose.yml                 # Prometheus + Alertmanager + Grafana + simulator
├── prometheus/
│   ├── prometheus.yml                 # scrape configs (including commented real-world examples)
│   └── alert_rules.yml                # all alerting rules, grouped by domain
├── alertmanager/
│   └── alertmanager.yml               # routing skeleton (wire up your own receiver)
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/datasource.yml # auto-provisions the Prometheus datasource
│   │   └── dashboards/dashboard.yml   # auto-provisions the dashboards below
│   └── dashboards/
│       ├── lifepo4-battery-monitor.json
│       ├── solar-inverter-overview.json
│       ├── kubernetes-guestbook-cluster.json
│       └── homelab-server-overview.json
├── exporters/
│   └── ble_battery_exporter/
│       ├── ble_battery_simulator.py   # simulated Pi + BLE BMS bridge (Prometheus client)
│       ├── requirements.txt
│       └── Dockerfile
└── screenshots/                       # drop PNGs here for your repo's README preview
```

---

## Quick start

```bash
git clone <this-repo>
cd grafana-dashboards-as-code
docker compose up -d
```

Then open:

- **Grafana** → http://localhost:3000 (`admin` / `admin`, change on first login)
  — dashboards appear automatically under the **Home Lab** folder.
- **Prometheus** → http://localhost:9090 — check **Status → Targets** to
  confirm the simulator is being scraped, and **Alerts** to see the rules.
- **Alertmanager** → http://localhost:9093

No dashboard import, no manual datasource setup — everything is
provisioned from the YAML/JSON in this repo.

---

## The dashboards

### 1. LiFePO4 Battery Bank Monitor (`lifepo4-battery-monitor.json`)

Models a Raspberry Pi that polls a Bluetooth LE smart BMS (JBD /
Overkill Solar / Daly-style, as commonly used in Pytes and Maple Leaf
packs) and exposes the readings on `:9101/metrics` for Prometheus to
scrape.

**Panels:** pack voltage, state of charge, current (charge/discharge),
pack temperature, exporter online/offline status, pack voltage trend with
threshold shading, min/max/delta cell voltage trend, current history, a
horizontal bar gauge of all 16 individual cell voltages, charge cycle
count, exporter staleness, and an alert-state timeline.

**Why it matters:** a LiFePO4 pack's BMS will *hard cut* the pack under
load if voltage drops too far — you want a warning long before that
happens, and you want to catch cell imbalance (one weak cell dragging the
whole pack) before it becomes a fire risk or a dead cell.

**Alert rules** (`prometheus/alert_rules.yml`, `lifepo4_battery_alerts`):

| Alert | Condition | Severity |
|---|---|---|
| `BatteryPackVoltageLow` | pack voltage < 46 V for 2m | warning |
| `BatteryPackVoltageCritical` | pack voltage < 44.8 V for 1m | critical |
| `BatteryCellImbalance` | max-min cell delta > 80 mV for 5m | warning |
| `BatteryTemperatureHigh` | pack temp > 45 °C for 3m | warning |
| `BLEExporterDown` | exporter unreachable for 5m | critical |

The thresholds above assume a 16S LiFePO4 pack (nominal 51.2 V, ~54.4–58.4 V
full, ~44.8 V low-voltage cutoff) — adjust for your own series count.

**Going from simulator to real hardware:** `ble_battery_simulator.py`
contains a full docstring showing the `bleak`-based BLE polling pattern
(write a request frame to the BMS's write characteristic, parse the
notify response) — swap `simulate_reading()` for a real `poll_bms()` call
and every panel/alert in this repo keeps working unchanged, since they're
all driven by the same Prometheus metric names.

### 2. Solar & Battery Inverter Overview (`solar-inverter-overview.json`)

Power-flow view for a hybrid solar+battery inverter (modeled on a
LuxPower LXP-series unit) running self-consumption mode with a
net-metering export cap: PV production, battery SoC, house load, grid
import/export, current operating mode (self-consumption vs. a
weather-triggered AC-charge "storm guard" mode), and export vs. cap
tracking.

**Alerts:** `GridExportOverLimit` (exceeding your utility's export cap),
`InverterOffline`.

### 3. Kubernetes: Guestbook App & Cluster Health (`kubernetes-guestbook-cluster.json`)

Built around a common DevOps take-home-style stack: a small app (e.g. the
classic Guestbook example) deployed to Kubernetes via Pulumi, with its own
Prometheus/Grafana monitoring. Panels cover pod readiness, restarts,
request rate, p95 latency, and per-pod CPU/memory, plus a general node
CPU/memory section for the underlying cluster.

**Alerts:** `GuestbookPodNotReady`, `NodeCPUThrottling`.

> **Known gotcha included as a code comment:** on Docker Desktop's
> Kubernetes, kubelet/cAdvisor scraping over HTTPS often fails silently
> unless the scrape config sets `insecure_skip_verify: true` (see the
> commented `kubernetes-nodes-cadvisor` job in `prometheus.yml`). If CPU/
> memory panels are empty, check **Prometheus → Status → Targets** first.

### 4. Home Lab: Server & Plex Overview (`homelab-server-overview.json`)

General health for a 24/7 home server: CPU, memory, free disk per volume,
and active Plex stream count (direct play vs. transcode), suitable for a
Windows host running `windows_exporter` plus a community Plex Prometheus
exporter.

**Alert:** `DiskSpaceLow` (shared rule, works for any `node_exporter`-style
filesystem metric).

---

## Alerting

All rules live in one place, `prometheus/alert_rules.yml`, grouped by
domain (`battery`, `solar`, `kubernetes`, `homelab`) so they're easy to
scan or extend. `alertmanager/alertmanager.yml` ships with a minimal
routing tree — critical alerts get a shorter repeat interval — and empty
receiver stubs. Wire in a real notifier by uncommenting/adding, for
example:

```yaml
receivers:
  - name: "critical"
    webhook_configs:
      - url: "http://homeassistant.local:8123/api/webhook/battery-alerts"
```

This lets you fan a `BatteryPackVoltageCritical` alert straight into a
home automation system for a push notification, a siren, or a
forced-charge action.

---

## Adapting this to your own setup

- **Real BLE BMS:** replace the simulator's `simulate_reading()` with a
  real poll using `bleak` (already documented in the exporter's
  docstring); keep the same Prometheus gauge names and nothing else needs
  to change.
- **Real inverter:** most hybrid inverters (LuxPower, Growatt, Deye, etc.)
  expose readings over Modbus/TCP or a local API — write a small Python
  poller that publishes to the metric names used in
  `solar-inverter-overview.json` (`inverter_pv_power_watts`,
  `inverter_battery_soc_percent`, etc.).
- **Real Kubernetes cluster:** uncomment the `kubernetes-nodes-cadvisor`
  job in `prometheus.yml` and add a `kube-state-metrics` scrape job for
  pod-phase/restart metrics.
- **Real home server:** install `windows_exporter` (or `node_exporter` on
  Linux) and a Plex Prometheus exporter, then point Prometheus at them.

Because every dashboard is JSON in this repo (not something exported ad
hoc from a running Grafana instance), tweaking a panel is a normal text
edit — no drag-and-drop required, and every change is reviewable in a PR
diff.

---