# Renderer refactoring summary

## What was done

`renderer.js` was split from a 2200-line monolith into domain-specific files:

| File | Contents | Lines |
|------|----------|-------|
| `renderer-deployments.js` | Deployment list, cards, rollout history, pod table, PR injection | ~260 |
| `renderer-pipelines.js` | Pipeline list, failed step injection, pipeline PR injection | ~320 |
| `renderer-prs.js` | PR view, filtering, tabs, approve/merge, avatar fetching | ~510 |
| `renderer-feed.js` | Feed events, building, rendering, date filter | ~170 |
| `renderer-logs.js` | Log modal, stream handling, filter + net/catch | ~120 |
| `renderer-utils.js` | Pure utility functions (also testable in Node.js) | ~120 |
| `renderer.js` | Core: config, nav, settings, refresh logic, rollback modal | ~685 |

Unit tests added in `renderer-utils.test.js` (37 tests).

Dead code removed: unreachable `sha256:` branch in `getImageTag`, unused `deriveRepoName` in `azure-client.js`.

## What this is NOT

This is a file split, not a proper module system. The files are still plain `<script>` tags that share a single browser global scope. Cross-file dependencies are implicit — `renderer-prs.js` reads `latestDeployments` and `loadConfig` from `renderer.js`, for example, with no explicit import.

**The load order in `index.html` is a hidden contract** — changing it will break things silently.

ESLint's `no-undef` rule is disabled for renderer files for this reason, and `/* exported */` comments mark the public API of each file.

## Next step (not done yet)

The natural next step is to introduce an explicit `appState` object and a `services` object passed into each domain module as parameters, rather than reading globals by name. That would make dependencies visible and testable. It would likely require either a bundler (esbuild is small) or switching `<script>` tags to `<script type="module">`.
