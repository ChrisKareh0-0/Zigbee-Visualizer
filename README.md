# Zigbee2MQTT mesh snapshots and outage diffs

This utility captures the Zigbee2MQTT raw network map, bridge metadata, and
device metadata through MQTT. It then compares two captures by IEEE address
and reports devices, directed links, LQI changes, active-route changes, and
network identity changes.

## Local frontend

The repository includes a browser frontend for capturing, browsing, mapping,
and comparing snapshots:

```powershell
python .\mesh_frontend.py
```

### Deploying the visualizer to Vercel

The repository includes a `pyproject.toml` entrypoint and dependency list so
Vercel can build the Python handler. Push `pyproject.toml`,
`mesh_frontend.py`, and `zigbee_mesh.py` together, then redeploy the project.

The Vercel deployment can visualize snapshots committed to the repository and
can import new JSON maps directly from the browser. Imported maps are stored in
the browser's IndexedDB, so they survive reloads and Vercel function cold
starts. They are private to that browser/profile and are not a shared database;
clear browser data or use another device and they will not be present there.
MQTT captures should still be run with the local frontend because a Vercel
function cannot reliably reach a private broker or provide durable server-side
storage.

Open `http://127.0.0.1:8765`. The frontend keeps MQTT credentials in the
current browser tab only; the backend stores redacted snapshot metadata and
does not persist the credentials. It provides:

- one-click raw network-map captures;
- import of raw JSON maps exported from Home Assistant/Zigbee2MQTT;
- optional active-route discovery; leave it off for a faster first capture;
- snapshot history with node/link/channel counts;
- an interactive SVG topology map with LQI-colored links;
- before/after comparison with added/removed nodes, degraded links, and route changes;
- a link to the complete Markdown diff report.

## Install

From PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The MQTT account needs permission to subscribe to the Zigbee2MQTT bridge
topics and publish to `bridge/request/networkmap`.

## Capture a baseline

Run this while the network is healthy:

```powershell
\.venv\Scripts\python.exe .\zigbee_mesh.py snapshot `
  --host 192.168.1.10 `
  --username mqtt-user `
  --password 'mqtt-password' `
  --label before-outage
```

Snapshots are written under `mesh-snapshots\` and contain:

- `snapshot.json`: complete, self-contained capture;
- `networkmap.raw.json`: raw nodes, links, LQI, and route data;
- `bridge.info.json`, `bridge.devices.json`, and `bridge.health.json`;
- `networkmap.dot`: Graphviz source for rendering a visual map.

The bridge information is redacted before it is saved, including the network
key and MQTT/TLS credentials if they are present.

## Keep a rolling history

An unexpected power outage cannot be captured after the fact, so keep periodic
baselines. The default interval is 15 minutes:

```powershell
\.venv\Scripts\python.exe .\zigbee_mesh.py watch `
  --host 192.168.1.10 `
  --username mqtt-user `
  --password 'mqtt-password' `
  --output-dir .\mesh-snapshots
```

At startup after the outage, take a fresh capture:

```powershell
\.venv\Scripts\python.exe .\zigbee_mesh.py snapshot `
  --host 192.168.1.10 `
  --username mqtt-user `
  --password 'mqtt-password' `
  --output-dir .\mesh-snapshots `
  --label after-outage
```

For a permanent history, run `watch` as a Windows Scheduled Task or as a
service on an always-on host. Do not schedule it more frequently than needed:
network-map scans actively query the mesh and can temporarily reduce
responsiveness.

If a scan is unusually slow or never completes, first capture without active
routes. From the command line use `--no-routes`; in the frontend leave
**Include active routes** unchecked. Enable it later for a focused diagnostic
capture.

## Import a map from Home Assistant

The frontend also accepts either of these JSON formats:

- a raw map containing `nodes` and `links`;
- the full MQTT response from `bridge/response/networkmap`, containing `data.value`.

In Home Assistant, use the MQTT integration's **Listen to a topic** and
**Publish a packet** tools. Listen first on:

```text
zigbee2mqtt/bridge/response/networkmap
```

Then publish to:

```text
zigbee2mqtt/bridge/request/networkmap
```

with payload:

```json
{"type":"raw","routes":false}
```

Copy the JSON response into a file such as `networkmap.json`, then use
**Import raw JSON file** in the local frontend. This avoids giving the local
tool direct MQTT access.

## Compare the networks

```powershell
\.venv\Scripts\python.exe .\zigbee_mesh.py diff `
  .\mesh-snapshots\20260914T080000Z-scheduled-0012 `
  .\mesh-snapshots\20260914T103000Z-after-outage
```

Open the generated `diff\diff.md`. The JSON report is next to it for further
processing. A link is considered degraded when its LQI falls by at least 15;
override that with `--lqi-threshold 25` or another value.

The comparison uses IEEE addresses for device identity. Short network
addresses are still reported, but changes to them alone are not treated as a
new device.

## Render the map

With Graphviz installed:

```powershell
dot -Tsvg `
  .\mesh-snapshots\20260914T103000Z-after-outage\networkmap.dot `
  -o .\mesh-snapshots\after-outage.svg
```

The raw map request is `{"type":"raw","routes":true}`. Zigbee2MQTT returns
the response on `bridge/response/networkmap`; the tool matches its transaction
identifier so unrelated responses are ignored.
