---
name: API codegen barrel behavior
description: Keep generated Zod API exports collision-free after OpenAPI codegen.
---

After Orval codegen in this workspace, check the public Zod barrel: generation may add a wildcard re-export alongside explicit generated-type exports, duplicating names such as detection request/response schemas.

**Why:** Orval exposes both Zod schemas and TypeScript interfaces for detection body/response names, so overlapping exports make `typecheck:libs` fail after otherwise successful codegen.

**How to apply:** Keep the barrel exports explicit, omit duplicate type names already exported as Zod schemas, and rerun `pnpm run typecheck:libs` after generation.
