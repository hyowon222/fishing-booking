---
name: Fishing source lifecycle
description: Lifecycle rule for database-backed reservation sources
---

Managed reservation sources are user-owned configuration. The initial source may be seeded during setup, but runtime reads must not recreate a source when the table is empty; deleting the last source must remain effective.

**Why:** Automatic fallback seeding made an explicit delete appear to fail and could overwrite the user's intended empty configuration.

**How to apply:** Keep setup seeding separate from schedule lookup and source-list reads. Treat an empty source list as a valid state with no schedules.