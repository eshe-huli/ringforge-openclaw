# OpenClaw RingForge Plugin

Connect OpenClaw agents to a RingForge hub fleet.

## Setup

Add to your `openclaw.yaml`:

```yaml
ringforge:
  enabled: true
  hubUrl: "wss://hub.ringforge.dev/ws/websocket"
  apiKey: "rf_live_..."
  fleetId: "your-fleet-id"
  agentName: "my-agent"
  capabilities: ["code", "research"]
```

## Run

```bash
npm install
npm run build
npm start
```

Environment overrides: `RINGFORGE_HUB_URL`, `RINGFORGE_API_KEY`, `RINGFORGE_AGENT_NAME`, `OPENCLAW_CONFIG`.

## Architecture

- Reads `openclaw.yaml` (or env vars)
- Connects via Phoenix WebSocket to `fleet:lobby`
- Registers as framework `openclaw` for tier-2 context injection
- Handles direct messages, task assignments, and kanban events
