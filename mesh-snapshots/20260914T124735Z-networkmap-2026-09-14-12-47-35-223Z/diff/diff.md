# Zigbee mesh diff

Before: **after-outage-complete** (2026-09-14T10:54:01.003233+00:00)  
After: **networkmap-2026-09-14-12-47-35-223Z** (2026-09-14T12:47:35.571300+00:00)

## Summary

- Nodes: 96 → 96 (added 0, removed 0)
- Directed links: 1516 → 1516 (added 0, removed 0)
- Changed links: 0; degraded by ≥15 LQI: 0
- Active-route changes: 0
- Network metadata changes: 0

## LQI statistics

- Before: `{"count": 1553, "max": 255, "mean": 155.6, "median": 146, "min": 0, "p10": 36}`
- After: `{"count": 1553, "max": 255, "mean": 155.6, "median": 146, "min": 0, "p10": 36}`

## Interpretation notes

- IEEE addresses identify devices; short network addresses can change after a restart and are not device replacements.
- Links are directional and LQI is a measurement from the scan, not a permanent radio-quality property.
- A scan asks devices for neighbor information and can temporarily reduce responsiveness; avoid running it too frequently.
- Compare snapshots taken under similar conditions. Battery devices may be asleep, so a missing edge can be a measurement gap rather than a permanent topology change.
