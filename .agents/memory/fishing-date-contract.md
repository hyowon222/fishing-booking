---
name: Fishing date contract
description: Date serialization behavior shared by the reservation API and React client.
---

OpenAPI date fields are validated as Zod dates on the server and arrive in browser responses as ISO timestamps, even when the source value is date-only.

**Why:** The generated response schema uses date coercion, so display code that blindly appends a date suffix to every value can create invalid timestamps.

**How to apply:** Normalize date-only and ISO values at the UI formatting boundary; keep query input values as `YYYY-MM-DD` strings.