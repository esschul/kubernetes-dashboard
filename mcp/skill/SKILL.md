---
name: kubernetes-dashboard
description: Answer questions about the team's open/merged PRs, Dependabot PRs, failing checks, Trello cards and their PRs, Azure DevOps pipeline runs and Kubernetes deployments (QA/test/prod) with the kubernetes-dashboard MCP server before reaching for gh, az or kubectl. Use when the user asks "which PRs fail checks", "hva feiler", "dependabot-PRer", "PRer på kortet", "what's deployed in QA/prod", "is anything crash-looping", "pipeline failed", or mentions the dashboard snapshot.
---

# Kubernetes Dashboard MCP

The `kubernetes-dashboard` MCP server reads `snapshot.json`, which the Kubernetes Dashboard app
writes after each refresh. It is fast and already joins PRs, Trello cards, pipelines and
deployments, but it is only as fresh as the app.

## Steps

1. **Pick the tool.**

   | Question | Tool |
   |---|---|
   | PRs (open/merged, by repo, author, card, bots) | `list_pull_requests` (`includeBots: true` for Dependabot) |
   | Which PRs belong to which Trello card | `list_trello_cards`, or `list_pull_requests` with `trelloCard` (shortLink or URL) |
   | Pipeline runs, failures | `list_pipeline_runs` (`result: "failed"`) |
   | What runs where, what is broken | `list_deployments` (`context: "qa"`, `unhealthyOnly: true`) |
   | Why a deployment fails | `get_deployment` (pods, events, rollouts) |
   | How fresh is everything | `dashboard_status` |

2. **Read the `snapshot` block before the result.**
   - `appRunning: false` or `stale: true` → say how old the data is (`ageMinutes`) in the answer.
   - `warnings` → a source failed or was never fetched. An empty list then means "no data", not
     "nothing there". Say so.
   - `total > returned` → raise `limit` or narrow the filters before concluding.

3. **Verify with the real tool when it matters** (stale data, warnings, or before acting:
   approving, merging, re-running, deploying): `gh pr checks`, `gh pr view`, `az pipelines`,
   `kubectl`. If the snapshot and `gh` disagree, trust `gh` and tell the user the dashboard is off.

4. **Diagnose failures outside the snapshot.** The snapshot has check status and pipeline results,
   not logs. For a failing PR, get the logs with `gh pr checks <n> -R <repo>` and the Azure DevOps
   build log, then explain the error.

## Known limits

- `checkStatus: "none"` can mean "not looked up": the app skips PRs not updated for 7 days.
  Older builds also ignored commit statuses (Azure Pipelines via OAuth), so Woo and similar repos
  showed `none` even when red. Check with `gh pr checks` before saying a PR has no checks.
- Deployments have `gitSha` and image, not the PR. Match the SHA against PRs if you need the link.
- Only PRs in repos with the team's GitHub topic (plus watched repos) are included.
- If the tools are missing, the server is not registered or the session started before it was.
  Setup: `docs/MCP.md` in the kubernetes-dashboard repo.
