# Zigbee mesh diff

Before: **networkmap-2026-09-14-13-56-21-274Z** (2026-09-14T13:56:21.843539+00:00)  
After: **after-new-host-live-2026-09-14** (2026-09-14T13:53:32.192958+00:00)

## Summary

- Nodes: 96 → 96 (added 0, removed 0)
- Directed links: 1344 → 1344 (added 0, removed 0)
- Changed links: 0; degraded by ≥15 LQI: 0
- Active-route changes: 0
- Network metadata changes: 0

## LQI statistics

- Before: `{"count": 1371, "max": 255, "mean": 157.3, "median": 144, "min": 0, "p10": 40}`
- After: `{"count": 1371, "max": 255, "mean": 157.3, "median": 144, "min": 0, "p10": 40}`

## Interpretation notes

- IEEE addresses identify devices; short network addresses can change after a restart and are not device replacements.
- Links are directional and LQI is a measurement from the scan, not a permanent radio-quality property.
- A scan asks devices for neighbor information and can temporarily reduce responsiveness; avoid running it too frequently.
- Compare snapshots taken under similar conditions. Battery devices may be asleep, so a missing edge can be a measurement gap rather than a permanent topology change.
