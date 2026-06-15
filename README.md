# Kubernetes Dashboard

A macOS desktop app for teams running services on Kubernetes. Combines pull requests, CI pipelines, and deployments into one view so you can see what's happening across your stack without switching between GitHub, Azure DevOps, and kubectl.

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

- macOS (Apple Silicon)
- [`kubectl`](https://kubernetes.io/docs/tasks/tools/) configured with your cluster contexts
- [`gh`](https://cli.github.com/) authenticated with GitHub
- [`az`](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) authenticated with Azure DevOps (for pipelines)

## Installation

Download the latest `.dmg` from [Releases](https://github.com/esschul/kubernetes-dashboard/releases), open it, and drag the app to `/Applications`.

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

## Development

```bash
npm install
npm start
```

To build a distributable DMG:

```bash
npm run build:mac
```

To build and publish a GitHub release:

```bash
npm run release
```

## Tech stack

- [Electron](https://www.electronjs.org/)
- `kubectl` (via `execFile`) for Kubernetes data
- `gh` CLI for GitHub PRs and check runs
- `az` CLI for Azure DevOps pipelines and build logs
