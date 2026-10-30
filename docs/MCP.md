# Use the dashboard from Claude Code

The app writes what it fetches to `snapshot.json`. The MCP server in `mcp/` lets Claude Code read it,
so you can ask things like "which Dependabot PRs fail checks?", "which PRs belong to this Trello
card?" or "is anything crash-looping in QA?".

## Setup

Needs Node and Claude Code.

1. **Run the app** (v1.1.80 or newer) and open the Pull Requests view once. It writes the snapshot to
   - macOS: `~/Library/Application Support/kubernetes-dashboard/snapshot.json`
   - Linux: `~/.config/kubernetes-dashboard/snapshot.json`
2. **Clone the repo.** The MCP server is not part of the installed app.

   ```bash
   git clone https://github.com/esschul/kubernetes-dashboard.git ~/dev/kubernetes-dashboard
   ```

3. **Register the server** for all your projects:

   ```bash
   claude mcp add -s user kubernetes-dashboard -- node ~/dev/kubernetes-dashboard/mcp/server.js
   ```

4. **Add the skill.** It tells Claude when to use the server, to check how fresh the data is, and
   to verify with `gh`, `az` or `kubectl` before acting. A symlink keeps it current with `git pull`:

   ```bash
   mkdir -p ~/.claude/skills && ln -s ~/dev/kubernetes-dashboard/mcp/skill ~/.claude/skills/kubernetes-dashboard
   ```

5. **Start a new Claude Code session** (tools and skills load at start) and check:

   ```bash
   claude mcp get kubernetes-dashboard
   ```

   It should say `Connected`.

## Try it

- "Sjekk dashboardet: hvilke PR-er feiler?"
- "Which Dependabot PRs fail checks?"
- "Hvilke PR-er hører til kortet https://trello.com/c/…?"
- "What's deployed in QA, and is anything unhealthy?"
- "Why does shippingguide fail in QA?"
- "How fresh is the dashboard data?"

Say "dashboardet" or run `/kubernetes-dashboard` to make sure Claude uses it.

## Good to know

- **Read-only.** It never approves, merges, re-runs or deploys.
- **Only as fresh as the app.** Every answer says how old the data is and whether the app runs. If
  the app is closed, you get the last snapshot with a note.
- **Your team's repos only:** repos with your GitHub topic, plus watched repos.
- **Tools:** `dashboard_status`, `list_pull_requests`, `list_trello_cards`, `list_pipeline_runs`,
  `list_deployments`, `get_deployment`. Details in the README under "Snapshot and MCP server".

## Troubleshooting

| Problem | Fix |
|---|---|
| "No snapshot at …" | Start the app and open the Pull Requests view once |
| No `kubernetes-dashboard` tools in Claude | Start a new session; check `claude mcp get kubernetes-dashboard` |
| `Failed to connect` | `node` not on PATH for Claude; use the full path, e.g. `$(which node)` |
| Answers say the app is not running | Start the app; the data is from `writtenAt` |
| Snapshot somewhere else | Add `-e KUBE_DASHBOARD_SNAPSHOT=/path/to/snapshot.json` to `claude mcp add` |
