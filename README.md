# Kubernetes Dashboard

A macOS and Linux desktop app for teams running services on Kubernetes. Combines pull requests, CI pipelines, and deployments into one view so you can see what's happening across your stack without switching between GitHub, Azure DevOps, and kubectl.

## Features

**Pull Requests**
- Lists open PRs across all repos tagged with your team's GitHub topic
- Tabs for Open, Merged today, Merged yesterday, and Dependabot
- Filter by status: Approved, Changes requested, Draft, Checks passing/failing, Opened today, Human/Dependabot
- Age badges on PRs older than 24h (yellow → orange → red)
- Links to matching Azure DevOps pipeline runs directly from the PR card
- Watched repos: show PRs from shared repos (e.g. infra/IaC) filtered by a namespace label

**Pipelines**
- Today's Azure DevOps pipeline runs at a glance
- Linked GitHub PR info per pipeline run
- Failed step name extracted from the build timeline
- Build log errors (`[ERROR]` lines) fetched and shown inline, collapsible
- Copy button to share error context including PR reference

**Deployments**
- Live Kubernetes deployment status via `kubectl`
- Healthy / Failing / Progressing filter
- Links to GitHub PR for the deployed commit
- Trello card links extracted from PR comments
- Datadog logs link per deployment (configurable site URL)
- Environment shortcuts (Prod / QA / Test) for quick context switching

## Requirements

- macOS (Apple Silicon) or Linux (x86_64)
- [`kubectl`](https://kubernetes.io/docs/tasks/tools/) — configured with your cluster contexts
- [`gh`](https://cli.github.com/) — GitHub CLI, authenticated (`gh auth login`)
- [`az`](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) — Azure CLI, authenticated (`az login`) with the [Azure DevOps extension](https://learn.microsoft.com/en-us/azure/devops/cli/get-started) installed (`az extension add --name azure-devops`)

All three must be available on your `PATH`.

**macOS (Homebrew):**

```bash
brew install kubectl gh azure-cli
az extension add --name azure-devops
gh auth login
az login
```

**Fedora / RHEL:**

```bash
sudo dnf install kubernetes-client gh azure-cli
az extension add --name azure-devops
gh auth login
az login
```

**Debian / Ubuntu:**

```bash
sudo apt install kubectl gh
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
az extension add --name azure-devops
gh auth login
az login
```

The Linux build also needs FUSE to run the AppImage: `sudo dnf install fuse` (Fedora/RHEL) or `sudo apt install libfuse2` (Debian/Ubuntu). If it's missing, either install it or launch with `--appimage-extract-and-run`.

## Installation

**macOS:** download the latest `.dmg` from [Releases](https://github.com/esschul/kubernetes-dashboard/releases), open it, and drag the app to `/Applications`.

**Linux (x86_64):**

```bash
curl -fsSL https://raw.githubusercontent.com/esschul/kubernetes-dashboard/main/scripts/install-linux.sh | sh
```

This installs to `~/.local/share/kubernetes-dashboard`, adds a `kubernetes-dashboard` launcher to `~/.local/bin`, and registers a desktop entry — no `sudo` required. To uninstall: `sh install-linux.sh --uninstall` (download it first if you piped it in originally).

If you'd rather review the script before running it:

```bash
curl -fsSLO https://raw.githubusercontent.com/esschul/kubernetes-dashboard/main/scripts/install-linux.sh
less install-linux.sh
sh install-linux.sh
```

## Configuration

Open the app and go to **Settings**:

| Field | Description |
|---|---|
| kubectl context | Which cluster context to use (defaults to current) |
| Namespace | Your team's Kubernetes namespace |
| GitHub Org | GitHub organisation name |
| Repo topic | GitHub topic tag used to find your team's repos (defaults to namespace name) |
| Watched repos | Shared repos to include — only PRs labelled with your namespace are shown |
| Azure DevOps Org URL | e.g. `https://dev.azure.com/my-org` |
| Azure DevOps Project | Project name |
| Datadog Site URL | e.g. `https://app.datadoghq.eu` |
| Environment shortcuts | Map Prod/QA/Test to specific kubectl contexts |

## Snapshot and MCP server

After each fetch the app writes what it got to `snapshot.json` in its data folder:

- macOS: `~/Library/Application Support/kubernetes-dashboard/snapshot.json`
- Linux: `~/.config/kubernetes-dashboard/snapshot.json`

| Key | Contents |
|---|---|
| `version` | Format version, bumped on breaking changes |
| `writtenAt` | When the file was last written |
| `app` | App `version`, `pid` and `startedAt` – a reader can tell if the app still runs |
| `pullRequests` | `fetchedAt`, `lastError`, and the PR lists per tab. Each PR has `trelloCard` (`id`, `slug`, `url`) from the branch name, or `null` |
| `pipelines` | Per `org/project`: `fetchedAt`, `lastError`, `runs` |
| `deployments` | Per `context/namespace`: `fetchedAt`, `lastError`, `deployments` |

A failed fetch sets `lastError` and keeps the last good data. The file is replaced in one step, so readers never see half a file.

### MCP server

`mcp/server.js` serves the snapshot read-only over MCP (stdio, no dependencies). Run it from a clone of this repo – it is not part of the installed app.

```bash
claude mcp add kubernetes-dashboard -- node /path/to/kubernetes-dashboard/mcp/server.js
```

| Tool | What it returns |
|---|---|
| `dashboard_status` | Age and last error for PRs, each pipeline source and each context/namespace |
| `list_pull_requests` | Open/merged PRs; filter by repo, author, Trello card, bots |
| `list_trello_cards` | PRs grouped by Trello card |
| `list_pipeline_runs` | Pipeline runs, newest first; filter by result, repo, branch |
| `list_deployments` | Deployments with status, image and SHA; filter by context, namespace, name, failing |
| `get_deployment` | One deployment with pods, events and rollouts |

Every result starts with `snapshot`: `writtenAt`, `ageMinutes`, `appRunning`, `stale` (older than 15 min or a bad timestamp) and a `note` when the data is not being updated. List tools also get `sources` (age and last error of the data they read) and `warnings` when a source failed or was never fetched.

List results are `{ total, returned, items }`, capped by `limit` (default 30–100). Bad arguments come back as tool errors that say what to fix. Set `KUBE_DASHBOARD_SNAPSHOT` to read another file.

## Development

```bash
npm install
npm start
```

To build a distributable DMG (macOS) or AppImage (Linux):

```bash
npm run build:mac     # macOS
npm run build:linux   # Linux
```

To build and publish a GitHub release, see [docs/RELEASING.md](docs/RELEASING.md) — releases are built on both platforms and macOS goes first.

## Troubleshooting

- **App won't find `kubectl`/`gh`/`az`**: set `KUBECTL_PATH`, `GH_PATH`, or `AZ_PATH` to the tool's full path.
- **Linux: "libfuse.so.2" error on launch**: install FUSE (see Requirements above) or run the AppImage with `--appimage-extract-and-run`.
- **Linux: sandbox error on some Debian-based systems**: if the app refuses to start with a sandbox-related error, try launching with `--no-sandbox`.

## Tech stack

- [Electron](https://www.electronjs.org/)
- `kubectl` (via `execFile`) for Kubernetes data
- `gh` CLI for GitHub PRs and check runs
- `az` CLI for Azure DevOps pipelines and build logs
