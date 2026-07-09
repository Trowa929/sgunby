#!/usr/bin/env python3
"""
ble_battery_simulator.py

Simulates a Raspberry Pi that talks to a LiFePO4 BMS (e.g. a JBD/Overkill
Solar/Daly-style Smart BMS as used in Pytes / Maple Leaf packs) over
Bluetooth LE, and exposes the readings as Prometheus metrics.

This is the "demo data" half of the repo so the dashboards render
realistic values with zero hardware attached. It models a 16S LiFePO4
pack (nominal 51.2 V, ~54.4-58.4 V full, ~44.8-46 V low cutoff) doing a
slow charge/discharge cycle with a bit of noise and per-cell drift.

--------------------------------------------------------------------
Adapting this to REAL hardware on a Raspberry Pi
--------------------------------------------------------------------
Most consumer LiFePO4 BMS units (JBD/Overkill/Daly-style) expose a BLE
GATT service with a single write characteristic (send a request frame)
and a single notify characteristic (receive the reply frame). The
general pattern with `bleak` looks like:

    import asyncio
    from bleak import BleakClient

    BMS_MAC = "AA:BB:CC:DD:EE:FF"
    WRITE_CHAR = "0000ff02-0000-1000-8000-00805f9b34fb"
    NOTIFY_CHAR = "0000ff01-0000-1000-8000-00805f9b34fb"

    async def poll_bms():
        async with BleakClient(BMS_MAC) as client:
            def handle_notify(_, data: bytearray):
                parse_bms_frame(data)   # your BMS's specific frame format
            await client.start_notify(NOTIFY_CHAR, handle_notify)
            await client.write_gatt_char(WRITE_CHAR, REQUEST_BASIC_INFO)
            await asyncio.sleep(2)

Swap the `simulate_reading()` function below for a real `poll_bms()`
call, keep the same Prometheus gauge names, and every dashboard/alert
in this repo works unmodified against your actual pack.
--------------------------------------------------------------------
"""

import os
import random
import time
import math

from prometheus_client import start_http_server, Gauge

DEVICE = os.environ.get("PACK_NODE_NAME", "pi-battery-monitor-01")
CELL_COUNT = int(os.environ.get("CELL_COUNT", "16"))
POLL_INTERVAL_SECONDS = float(os.environ.get("POLL_INTERVAL_SECONDS", "5"))

LABELS = ["device"]

pack_voltage = Gauge("battery_pack_voltage_volts", "Total pack voltage", LABELS)
soc_percent = Gauge("battery_soc_percent", "State of charge percent", LABELS)
current_amps = Gauge("battery_current_amps", "Pack current, positive=charging, negative=discharging", LABELS)
temperature_c = Gauge("battery_temperature_celsius", "BMS temperature sensor", LABELS)
cycle_count = Gauge("battery_cycle_count", "Charge cycle count reported by BMS", LABELS)
cell_min = Gauge("battery_cell_voltage_min_volts", "Lowest individual cell voltage", LABELS)
cell_max = Gauge("battery_cell_voltage_max_volts", "Highest individual cell voltage", LABELS)
cell_voltage = Gauge("battery_cell_voltage_volts", "Per-cell voltage", LABELS + ["cell"])
last_seen = Gauge("battery_last_seen_timestamp", "Unix timestamp of last successful BLE read", LABELS)

# Rough per-cell offsets so the pack isn't perfectly uniform (mirrors
# real-world cell drift you'd want to catch with an imbalance alert).
CELL_OFFSETS = [random.uniform(-0.01, 0.015) for _ in range(CELL_COUNT)]

_start = time.time()
_cycles = 412  # arbitrary starting point, like a pack that's been in service a while


def simulate_reading():
    """Produce one realistic set of readings for a 16S LiFePO4 pack
    doing a slow ~2 hour charge/discharge cycle."""
    elapsed_min = (time.time() - _start) / 60.0
    # slow sine wave between "mostly charged" and "getting low", plus noise
    cycle_phase = math.sin(elapsed_min / 45.0)
    base_cell_v = 3.30 + (cycle_phase * 0.12)  # ~3.18V-3.42V per cell nominal range
    base_cell_v += random.uniform(-0.004, 0.004)

    cells = [round(base_cell_v + off, 4) for off in CELL_OFFSETS]
    pack_v = round(sum(cells), 2)

    # current: positive while "charging" (phase rising), negative while discharging
    charging = cycle_phase > 0
    amps = round(random.uniform(8, 18) * (1 if charging else -1) + random.uniform(-1, 1), 2)

    soc = round(50 + cycle_phase * 45 + random.uniform(-1, 1), 1)
    soc = max(1.0, min(100.0, soc))

    temp = round(22 + abs(amps) * 0.35 + random.uniform(-0.5, 0.5), 1)

    return pack_v, cells, amps, soc, temp


def main():
    start_http_server(9101)
    print(f"[ble_battery_simulator] serving /metrics on :9101 for device={DEVICE}")
    while True:
        pack_v, cells, amps, soc, temp = simulate_reading()

        pack_voltage.labels(device=DEVICE).set(pack_v)
        soc_percent.labels(device=DEVICE).set(soc)
        current_amps.labels(device=DEVICE).set(amps)
        temperature_c.labels(device=DEVICE).set(temp)
        cycle_count.labels(device=DEVICE).set(_cycles)
        cell_min.labels(device=DEVICE).set(min(cells))
        cell_max.labels(device=DEVICE).set(max(cells))
        for i, v in enumerate(cells, start=1):
            cell_voltage.labels(device=DEVICE, cell=str(i)).set(v)
        last_seen.labels(device=DEVICE).set(time.time())

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
