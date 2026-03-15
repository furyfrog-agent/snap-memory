# snap-memory

Compaction-proof topic snapshots for OpenClaw. No API key, no cloud, no vector DB — just structured markdown that keeps your agent on track across sessions.

## What it does

- **Topic checkpoints**: Save structured topic state (status, decisions, history) to local markdown
- **Agent tool**: `context_snap` tool lets the agent checkpoint/list/read context files
- **Self-maintaining**: Files auto-prune to stay small and token-efficient
- **Zero dependencies**: Pure local markdown, no external services

## Install

```bash
# Link for local development
openclaw plugins install -l ./snap-memory

# Or copy-install
openclaw plugins install ./snap-memory
```

Then restart the gateway:

```bash
openclaw gateway restart
```

## Configure (optional)

```json
{
  "plugins": {
    "entries": {
      "snap-memory": {
        "enabled": true,
        "config": {
          "contextDir": "./memory",
          "maxHistoryLines": 30,
          "maxDecisions": 20
        }
      }
    }
  }
}
```

All config is optional — defaults to `<workspace>/memory`, 30 history lines, 20 decisions.

## Agent tool: `context_snap`

Three actions:

| Action | Required params | Description |
|--------|----------------|-------------|
| `checkpoint` | `topic`, + optional `status`, `decisions`, `historyLine` | Save/update a topic context |
| `list` | (none) | Show all context files |
| `read` | `topic` | View a specific context file |

**Natural triggers**: "checkpoint", "存一下", "save context"

## Context file format

```markdown
# Topic Name

## Meta
- **created**: 2026-03-10
- **updated**: 2026-03-11

## Current Status
(overwritten each checkpoint — always reflects latest state)

## Key Decisions
- 2026-03-10: Decided X because Y

## History
- 2026-03-10: Started discussion
- 2026-03-11: Completed feature
```

## vs other memory plugins

| | snap-memory | lossless-claw | mem0/Supermemory |
|---|---|---|---|
| Scope | Topic-level snapshots | Full context management | User-level memory |
| Type | Tool plugin | Context engine plugin | Memory plugin |
| Storage | Local markdown | Local DB | Cloud API |
| API key needed | No | No | Yes |
| Compaction | Does not interfere | Replaces entirely | N/A |
| Weight | ~200 lines | Heavy | Medium |

## License

MIT
