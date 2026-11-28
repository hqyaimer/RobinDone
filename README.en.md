# RobinDone

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="RobinDone" width="128" height="128" />
</div>
<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

**RobinDone** is a **general-purpose always-on automation harness**: assemble a multi-agent team per project, driven by triggers and running around the clock — agents only start when triggered, state lives in files, and you can step in anytime.

## What is RobinDone

Hand a long-running project (monitoring, operations, development collaboration — any domain) to a team of agents:

- The **main agent** is the project manager, owning direction, planning, task assignment, progress, and acceptance;
- **Resident workers** (development, operations, analysis, …) are staffed as needed, each with their own sessions and state files;
- **Triggers** (schedule / webhook / script) wake the right agent automatically when something happens;
- You collaborate with all agents in a group-chat area — interject or interrupt anytime; major decisions are escalated to you by the main agent.

| Concept             | In one sentence                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| Project (workspace) | One entity / one long-term goal per project; data, agent roster, and triggers are isolated between projects |
| Main agent (master) | The project manager: direction, planning, assignment, progress, acceptance — it covers it all               |
| worker              | Resident executor agents (dev, ops, …) with independent sessions and state files                            |
| subagent            | A temporary helper any agent can spawn; destroyed when the task ends                                        |
| Trigger             | Three event sources — schedule / local webhook / script — that wake agents automatically                    |
| Ops panel           | Requirements, approvals, feedback, and the project progress ledger                                          |

## How It Differs from Typical Agent Harnesses

|               | Typical single-agent harness          | RobinDone                                                                                                              |
| ------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Organization  | One agent, one conversation at a time | Project-based, three-tier roster: master → resident workers → ephemeral subagents                                      |
| Driving force | Mostly human-initiated chats          | Event-driven: triggers wake the right agent; humans step in anytime                                                    |
| Lifecycle     | Work stops when the session ends      | The project keeps running; agents start only when triggered — no resident LLM loop                                     |
| State         | Lives in conversation context         | State files and knowledge bases on disk are the single source of truth across sessions                                 |
| Collaboration | —                                     | Group-chat style: workers never talk directly, everything is routed via the main agent; you can interject or interrupt |
| Delivery      | Mostly CLI / editor plugins           | Desktop app; all projects share one window                                                                             |

## Core Features

- **Project-based workspace**: all projects in one window; three-pane layout — agent tree with a trigger folder / group-chat conversation area (chunked by sender) / info panels (web preview, file tree, …).
- **Multi-agent collaboration**: workers are structurally identical to the main agent (independent sessions, cold recovery); task hand-off goes through request-response ContactAgent with explicit addressing; interject or interrupt any session.
- **Trigger system**:
  - **Event sources**: schedule (cron / interval), local webhook (port + path/token validation), scripts (resident collector processes, or scheduled one-shot runs that exit when done);
  - **Delivery routing**: direct / fixed / dispatcher — dispatcher clusters topics and routes events to the right session; events from the same source are debounced and merged, queued while the bound session is busy, and one source keeps one session for context continuity;
  - **Reliability**: scripts report through a unified emit contract; repeated failures trip a circuit breaker with notification, auto-reset on recovery; crashed scripts restart with backoff;
  - **Hosted browser**: the engine hosts chromium for scripts and persists login states encrypted; on login failure it opens a headed window for you to sign in again, and re-archives when you close it;
  - **Zero setup**: the desktop build bundles a Python runtime, so script triggers work out of the box.
- **Ops panel**: requirements, approvals, feedback, and the project progress ledger (maintained exclusively by the main agent, updated in place, showing only valid final states).
- **Bring your own LLM**: pick any provider and API key — no vendor lock-in.
- **File-based state and knowledge bases**: agent state lives in files, split by topic with an index file — check the index first, read only the relevant pieces; experience entries are append-first; conflicting entries are marked as superseded, never silently rewritten.
- **Context compaction**: a soft threshold starts wrap-up guidance (with manual compaction on demand), a hard cap forces compaction unconditionally — long sessions stay affordable.
- **Extensibility**: MCP servers, plugin marketplace, and skills extend agent capabilities.
- **Auto-update**: built-in updater on Windows and Linux AppImage; macOS upgrades are manual downloads for now.

## Typical Use Cases

Any domain that is long-running, event-driven, and multi-role. Staffing and triggers are composed entirely on demand. For example:

- **Information monitoring & collection**: scheduled/resident scripts watch pages and data sources → events routed by topic clustering → analysis workers archive into knowledge bases → notable changes wake the main agent to report to you.
- **Event response watch**: external systems push webhook alerts → the on-duty worker triages and handles → anything uncertain escalates to the main agent for your call.
- **Online account operations**: scheduled collection of trends and comment sections → operations workers draft posts and replies → the main agent paces the activity → user feedback flows back into the loop.
- **Development collaboration**: requirements and feedback land in the ops panel → the main agent splits and assigns tasks to dev workers → deliverables get accepted and logged in the progress ledger.

## Design Principles

### When to Use Multiple Agents

The criterion is **separation of responsibilities**, not concurrency:

- Set up a resident worker only when a functional domain (dev / ops / analysis, …) needs a long-term post with its own accumulating knowledge base and state files;
- Parallel execution is not a reason — multiple sessions and ephemeral subagents already cover it; one-off tasks go to subagents;
- The main agent can double as a functional role (its self-identity stays "project manager"); a minimal roster of "main agent + dev + ops" is a good starting point;
- Workers never talk directly to each other — all communication is routed via the main agent, keeping the information hub and decision authority clear.

### When Triggers Fire, and Which Source to Pick

Pick the event source by the shape of the event:

- **Pure time-driven** (daily at X, every N minutes) → schedule source (cron / interval);
- **A periodic check that finishes in one pass** → the script's scheduled mode: spawn a collection run at the appointed time → emit → exit, without occupying resident quota;
- **Continuous listening, long-lived collection** → resident script mode; merge multiple event types of the same responsibility domain into one resident script — neither split for splitting's sake nor merge for merging's sake;
- **Push from external systems** → local webhook.

When events are many and topics are messy, turn on dispatcher routing: topics are clustered and dispatched accordingly; finished topics are evicted on compaction, and no routing-table file is maintained.

### Start Only When Triggered

There is no resident LLM loop. Agents start only when an event fires: an independent trigger opens a new session, and the same trigger source reuses the same session to keep context. Tokens are spent only on triggered work.

### Files Are the State

Sessions carry the process only — **files are the single source of truth across sessions**. Knowledge bases follow divide-and-conquer: one overview file + an index + topical sub-files; read the index first and fetch only what's relevant. Experience entries are append-first; rewriting existing content without constraint is forbidden.

### Fully Automatic, With Gates

- You can interrupt, interject, or take over any agent's session at any time;
- When a trigger needs a decision, it wakes the main agent; major matters are escalated to you — never decided unilaterally.

## Installation

Download the installer for your platform from [GitHub Releases](https://github.com/hqyaimer/RobinDone/releases) (the latest version is whatever the Releases page shows). The builds are not code-signed yet, so each platform needs a one-time allow step described below.

### Windows 11 (win-x64)

1. Download the `.exe` installer and double-click it;
2. If you see "**Smart App Control blocked this app**", you need to turn Smart App Control off first: open **Settings → Privacy & security → Windows Security → App & browser control → Smart App Control settings** and select **Off**;
3. Run the installer again to finish.

> Note: once Smart App Control is off, it usually cannot be re-enabled without reinstalling/resetting Windows — weigh that carefully. If what pops up is instead the SmartScreen "Windows protected your PC" dialog, click "More info → Run anyway". This step goes away once the builds are properly signed.

### macOS (Apple Silicon / Intel)

1. Download the `.dmg` for your architecture, open it, and drag RobinDone into Applications;
2. The mac build is not signed/notarized yet, so remove the quarantine attribute in a terminal before first launch:

```bash
sudo xattr -rd com.apple.quarantine /Applications/RobinDone.app
```

> Auto-update is unavailable on macOS for now; download new versions manually from the Releases page.

### Linux (x64)

- **AppImage**: `chmod +x RobinDone-*.AppImage`, then run it;
- **deb / rpm / pacman packages**: install the usual way for your distribution.

### First Launch

1. Create a project (one window hosts all projects; the most recent one opens on cold start);
2. Configure your model provider (API endpoint and key) in settings;
3. Chat with the main agent: have it staff your worker roster and set up triggers, and the project starts running.

All data is stored locally under `~/.robindone`.

## Building from Source

Requires Git, Node.js **≥ 24**, and pnpm **10.33.2** (see [mise.toml](mise.toml) for the pinned versions).

```bash
pnpm bootstrap     # install deps + prepare desktop runtime assets + full build
pnpm dev:desktop   # start the desktop app in dev mode
pnpm typecheck     # type check
pnpm lint          # lint
```

## License

Dual licensing:

- **RobinDone's original code and docs**: [MIT](LICENSE-MIT)
- **Code derived from upstream open-source projects**: [Apache-2.0](LICENSE) (its legal grant cannot be changed)

Third-party notices: [NOTICE.md](NOTICE.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
