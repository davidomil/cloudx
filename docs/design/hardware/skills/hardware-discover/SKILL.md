---
name: hardware-discover
description: Find suitable CloudX hardware by type, capability tags, status, and availability.
---

# Discover hardware

Design draft. Run these procedures only after the Hardware plugin and helper are installed.

1. Run `node "$CLOUDX_HARDWARE_HELPER" context`. Use only this execution's context. Stop if it is missing or revoked.
2. Use `tags list`, `types list`, and `statuses list`. Follow every catalog cursor before claiming to know all available values.
3. Build a HardwareFilter with stable IDs. Use tags.all, tags.any, tags.none, exact status values, and availability. Use an empty filter to list all items; page until nextCursor is null.
4. Run `items list --input filter.json`. A list result is a snapshot, not a reservation.
5. Run `items get --id HARDWARE_ID`. Read complete notes, connection metadata, revisions, group aliases, status freshness, and ownership.
6. If a required command observation is stale, request `statuses refresh --input refresh.json` and inspect its receipt. Do not run a separate raw probe or reserve automatically.
7. Use hardware-reserve for the selected item's current revision. If nothing matches, report the missing capabilities or current blockers.

Never invent tag or status IDs. Never interpret a manual Free to use value as permission to ignore an internal claim. Cursor staleness requires an explicit fresh query.
