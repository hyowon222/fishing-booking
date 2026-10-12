---
name: GitHub push authentication
description: Workspace Git CLI authentication can fail independently of a healthy Replit GitHub connection.
---

A GitHub source-control connection can report healthy or already added while `git push` still fails with an invalid-credentials error.

**Why:** In this workspace, linking the existing connection did not make the Git CLI push succeed.

**How to apply:** Verify the remote branch SHA before and after a push. If authentication fails, report that the commits remain local and resolve the Git connection; do not silently replace the requested commit history with an API-generated squash.
