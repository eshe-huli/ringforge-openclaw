/**
 * Ringforge OpenClaw Plugin v0.5.2
 *
 * Connects any OpenClaw agent to a Ringforge fleet:
 *
 *   plugins:
 *     entries:
 *       ringforge:
 *         enabled: true
 *         config:
 *           server: "wss://ringforge.wejoona.com"
 *           apiKey: "rf_live_..."
 *           fleetId: "default"
 *           agentName: "My Agent"
 *           capabilities: ["code", "research"]
 *           autoReply: true
 *           cryptoMode: "sign_encrypt"
 *           contextRefreshMs: 300000
 *           maxContextChars: 4000
 *
 * Features:
 * - Persistent WebSocket connection with auto-reconnect + exponential backoff
 * - JWS/JWE encrypted messaging (auto-negotiated fleet key)
 * - DM auto-reply: captures LLM output via agent_end hook, sends back to sender
 * - Context injection: kanban + role + squad + fleet + artifacts + rules → LLM prompt
 * - 10 tools: roster, send, inbox, activity, presence, memory, kanban, context, task_update
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { CryptoMode } from "./src/crypto.js";
import { RingforgeClient, type RingforgeConfig, type RingforgeMessage } from "./src/client.js";
import { ContextManager } from "./src/context-manager.js";
import { DmHandler } from "./src/dm-handler.js";
import { createRingforgeTools, updateRoster, pushIncomingMessage } from "./src/tools.js";

// ── Config Resolution ────────────────────────────────────────

function resolveConfig(
  pluginConfig: Record<string, unknown> | undefined,
  agentName?: string,
): RingforgeConfig | null {
  if (!pluginConfig || pluginConfig.enabled === false) return null;

  const server = pluginConfig.server as string;
  const apiKey = pluginConfig.apiKey as string;
  if (!server || !apiKey) return null;

  return {
    server,
    apiKey,
    fleetId: (pluginConfig.fleetId as string) || "default",
    agentName:
      (pluginConfig.agentName as string) ||
      agentName ||
      `openclaw-${Math.random().toString(36).slice(2, 8)}`,
    framework: "openclaw",
    capabilities: (pluginConfig.capabilities as string[]) || [],
    model: (pluginConfig.model as string) || undefined,
    cryptoMode: ((pluginConfig.cryptoMode as string) || "sign_encrypt") as CryptoMode,
  };
}

function resolveModel(api: OpenClawPluginApi): string | null {
  try {
    const cfg = api.config as Record<string, unknown>;
    if (typeof cfg.model === "string") return cfg.model;

    const rt = cfg.agentRuntime as Record<string, unknown> | undefined;
    if (typeof rt?.model === "string") return rt.model;

    const models = cfg.models as Record<string, unknown> | undefined;
    if (typeof models?.default === "string") return models.default;

    const fresh = api.runtime.config.loadConfig() as Record<string, unknown> | null;
    if (typeof fresh?.model === "string") return fresh.model;

    return null;
  } catch {
    return null;
  }
}

// ── DM System Event Formatting ───────────────────────────────

function formatDmEvent(
  from: { name?: string; agent_id: string },
  message: Record<string, unknown>,
): string {
  const who = `${from.name || from.agent_id} (${from.agent_id})`;
  const type = (message.type as string) || "text";

  switch (type) {
    case "text":
      return `[Ringforge DM from ${who}] ${message.text}`;
    case "task_request":
      return `[Ringforge Task from ${who}] "${message.task}": ${message.description || ""}${message.priority === "high" ? " ⚡ HIGH" : ""}`;
    case "query":
      return `[Ringforge Query from ${who}] ${message.question}`;
    case "status_request":
      return `[Ringforge Status Request from ${who}] Requesting status.`;
    case "data":
      return `[Ringforge Data from ${who}] "${message.label}": ${JSON.stringify(message.payload).slice(0, 500)}`;
    case "task_result":
      return `[Ringforge Result from ${who}] ref=${message.ref}: ${JSON.stringify(message.result).slice(0, 500)}`;
    default:
      return `[Ringforge DM from ${who}] [${type}]: ${JSON.stringify(message).slice(0, 500)}`;
  }
}

// ── Plugin Definition ────────────────────────────────────────

const ringforgePlugin = {
  id: "ringforge",
  name: "Ringforge",
  description: "Connect to a Ringforge agent mesh fleet",
  version: "0.5.2",

  configSchema: {
    parse(value: unknown) {
      return value && typeof value === "object" ? value : {};
    },
    uiHints: {
      enabled: { label: "Enabled", help: "Enable Ringforge mesh" },
      server: { label: "Server URL", placeholder: "wss://ringforge.wejoona.com" },
      apiKey: { label: "API Key", sensitive: true, placeholder: "rf_live_..." },
      fleetId: { label: "Fleet ID" },
      agentName: { label: "Agent Name", help: "Display name in the mesh" },
      capabilities: { label: "Capabilities", help: "Comma-separated" },
      autoReply: {
        label: "Auto-Reply",
        help: "Auto-send LLM replies to DM senders (default: true)",
      },
      cryptoMode: {
        label: "Crypto Mode",
        help: "none | sign | encrypt | sign_encrypt (default: sign_encrypt)",
      },
      contextRefreshMs: {
        label: "Context Refresh (ms)",
        help: "How often to refresh context (default: 300000)",
      },
      maxContextChars: {
        label: "Max Context Chars",
        help: "Max chars for context injection (default: 4000)",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig, api.config?.identity?.agentName || api.name);

    if (!config) {
      api.logger.info("Ringforge: disabled (need server + apiKey)");
      return;
    }

    const pc = (api.pluginConfig || {}) as Record<string, unknown>;
    const autoReply = pc.autoReply !== false;
    const refreshMs = Number(pc.contextRefreshMs) || 5 * 60 * 1000;
    const maxCtxChars = Number(pc.maxContextChars) || 4000;

    // ── Instantiate subsystems ──

    let lastModel: string | null = null;
    let pendingTaskExecution: { taskId: string; prompt: string; sessionId?: string; role?: string } | null = null;
    let taskExecutionTimer: ReturnType<typeof setTimeout> | null = null;
    let taskExecutionLock = false;
    const queuedDmEvents: Array<{ from: any; message: any; eventText: string }> = [];
    
    // Gap 1: Parallel session tracking
    const activeSessions = new Map<string, { role: string; taskId: string; startedAt: number }>();

    const client = new RingforgeClient(config, {
      onConnected: (agentId) => {
        api.logger.info(`Ringforge: connected as ${config.agentName} (${agentId})`);
      },
      onDisconnected: (reason) => {
        api.logger.info(`Ringforge: disconnected (${reason})`);
      },
      onDirectMessage: (from, message) => {
        const name = from.name || from.agent_id;
        const preview =
          message.type === "text" ? (message.text as string) : JSON.stringify(message).slice(0, 80);
        api.logger.info(`Ringforge DM from ${name}: ${preview}`);
        pushIncomingMessage(from, message);

        const injection = (message as Record<string, unknown>).injection || "immediate";
        if (injection === "silent") return;

        const eventText = formatDmEvent(from, message as Record<string, unknown>);

        // Bug 6: Queue DMs while task is executing to avoid collision
        if (taskExecutionLock) {
          queuedDmEvents.push({ from, message, eventText });
          api.logger.info(`Ringforge: queued DM (task executing), ${queuedDmEvents.length} queued`);
          return;
        }

        try {
          api.runtime.system.enqueueSystemEvent(eventText, { sessionKey: "agent:main:main" });
          dmHandler.trackIncoming(from, message, eventText);
          api.logger.info(`Ringforge: injected DM, ${dmHandler.pendingCount} pending`);
        } catch (err) {
          api.logger.warn(`Ringforge: DM injection failed: ${err}`);
        }
      },
      onRoster: (agents) => {
        updateRoster(agents);
        api.logger.info(`Ringforge: roster ${agents.length} agents`);
      },
      onPresenceJoined: (a) => api.logger.info(`Ringforge: ${a.name || a.agent_id} joined`),
      onPresenceLeft: (id) => api.logger.info(`Ringforge: ${id} left`),
      onActivity: (a) => api.logger.info(`Ringforge: [${a.kind}] ${a.description}`),
      onCryptoKeyReceived: (kid) => api.logger.info(`Ringforge: crypto key received (${kid})`),
      onCryptoKeyRotated: (kid) => api.logger.info(`Ringforge: crypto key rotated (${kid})`),
      onTaskExecute: (payload) => {
        const p = (payload as Record<string, unknown>)?.payload as Record<string, unknown> || payload;
        const taskId = p?.task_id as string;
        const prompt = p?.prompt as string;
        const sessionId = p?.session_id as string | undefined;
        const role = p?.role as string | undefined;
        if (!taskId || !prompt) {
          api.logger.warn("Ringforge: task:execute missing task_id or prompt");
          return;
        }
        api.logger.info(`Ringforge: task:execute ${taskId} (session=${sessionId || "default"}, role=${role || "none"}): ${prompt.slice(0, 80)}`);

        // Track this task for auto-reply via agent_end
        pendingTaskExecution = { taskId, prompt, sessionId, role };
        taskExecutionLock = true;

        // Bug 5: Start timeout timer — if agent_end doesn't fire within 90s, send error
        if (taskExecutionTimer) clearTimeout(taskExecutionTimer);
        taskExecutionTimer = setTimeout(() => {
          if (pendingTaskExecution && pendingTaskExecution.taskId === taskId) {
            api.logger.warn(`Ringforge: task ${taskId} timed out after 90s`);
            client.sendTaskResult(taskId, {}, "execution_timeout");
            pendingTaskExecution = null;
            taskExecutionLock = false;
            taskExecutionTimer = null;
            // Drain queued DMs
            drainQueuedDms();
          }
        }, 90_000);

        // Track active session for parallel execution
        if (sessionId) {
          activeSessions.set(sessionId, { role: role || "general", taskId, startedAt: Date.now() });
        }

        // Determine session key — use session_id if provided for isolation
        const sessionKey = sessionId
          ? `agent:main:task:${sessionId}`
          : "agent:main:main";

        // Build role-prefixed prompt if role specified
        const eventText = role
          ? `[Ringforge Task ${taskId} | Role: ${role}] ${prompt}`
          : `[Ringforge Task ${taskId}] ${prompt}`;

        // Try isolated session, fall back to main with role prefix
        try {
          api.runtime.system.enqueueSystemEvent(eventText, { sessionKey });
        } catch (err) {
          // Fallback: inject into main session with role context
          const fallbackText = role
            ? `[Ringforge Task ${taskId} | Role: ${role} | ISOLATED CONTEXT] ${prompt}`
            : eventText;
          try {
            api.runtime.system.enqueueSystemEvent(fallbackText, { sessionKey: "agent:main:main" });
          } catch (err2) {
            api.logger.warn(`Ringforge: task injection failed: ${err2}`);
            client.sendTaskResult(taskId, {}, String(err2));
          }
        }
      },
      onOrchestrationStateChanged: (payload) => {
        api.logger.info(`Ringforge: orchestration state changed: ${JSON.stringify(payload).slice(0, 200)}`);
      },
    });

    const dmHandler = new DmHandler(client, { autoReply });

    const ctxMgr = new ContextManager(client, {
      refreshIntervalMs: refreshMs,
      injectContext: true,
      maxContextChars: maxCtxChars,
    });

    // ── Detect model ──
    const model = resolveModel(api);
    if (model) {
      config.model = model;
      lastModel = model;
      api.logger.info(`Ringforge: model ${model}`);
    }

    // ── Hooks ──

    // Context injection + model change detection
    api.on("before_agent_start", (_event, _ctx) => {
      // Model change
      const m = resolveModel(api);
      if (m && m !== lastModel) {
        lastModel = m;
        if (client.isConnected) {
          client.updatePresence({ model: m, state: "busy" });
        }
      }

      // Inject context
      const prompt = ctxMgr.buildPromptContext();
      if (prompt) return { prependContext: prompt };
      return undefined;
    });

    // Helper to drain queued DMs after task execution completes
    function drainQueuedDms() {
      while (queuedDmEvents.length > 0) {
        const dm = queuedDmEvents.shift()!;
        try {
          api.runtime.system.enqueueSystemEvent(dm.eventText, { sessionKey: "agent:main:main" });
          dmHandler.trackIncoming(dm.from, dm.message, dm.eventText);
        } catch (err) {
          api.logger.warn(`Ringforge: queued DM injection failed: ${err}`);
        }
      }
    }

    // Auto-reply to DMs + task execution results
    api.on("agent_end", (event, _ctx) => {
      // Bug 6: Handle pending task execution FIRST (priority over DM auto-reply)
      if (pendingTaskExecution) {
        const task = pendingTaskExecution;
        pendingTaskExecution = null;

        // Bug 5: Clear timeout timer
        if (taskExecutionTimer) {
          clearTimeout(taskExecutionTimer);
          taskExecutionTimer = null;
        }

        try {
          const messages = event.messages || [];
          const lastAssistant = [...messages].reverse().find(
            (m: any) => m.role === "assistant" && m.content,
          );
          if (lastAssistant) {
            const content = typeof lastAssistant.content === "string"
              ? lastAssistant.content
              : JSON.stringify(lastAssistant.content);
            client.sendTaskResult(task.taskId, { 
              response: content.slice(0, 10000),
              session_id: task.sessionId,
              role: task.role
            });
            api.logger.info(`Ringforge: sent task result for ${task.taskId} (session=${task.sessionId || "default"})`);
          } else {
            client.sendTaskResult(task.taskId, {}, "no_assistant_response");
          }
        } catch (err) {
          api.logger.warn(`Ringforge: task result error: ${err}`);
          client.sendTaskResult(task.taskId, {}, String(err));
        }
        // Clean up session tracking
        if (task.sessionId) {
          activeSessions.delete(task.sessionId);
        }

        // Release lock and drain queued DMs
        taskExecutionLock = false;
        drainQueuedDms();
        return; // Don't process DM replies on the same agent_end cycle
      }

      // Handle pending DM replies (only if no task was pending)
      if (!dmHandler.hasPending()) return;
      try {
        if (dmHandler.handleAgentEnd(event.messages || [])) {
          api.logger.info("Ringforge: auto-replied to DM");
        }
      } catch (err) {
        api.logger.warn(`Ringforge: agent_end DM error: ${err}`);
      }
    });

    // ── Tools ──
    const tools = createRingforgeTools(client, ctxMgr);
    for (const tool of tools) {
      api.registerTool(tool as any, { name: tool.name });
    }

    // ── Command ──
    api.registerCommand({
      name: "ringforge",
      description: "Ringforge mesh status",
      handler: () => {
        const s = client.isConnected ? "🟢 Connected" : "🔴 Disconnected";
        const id = client.currentAgentId || "—";
        const up = Math.floor(client.uptimeMs / 1000);
        const pending = dmHandler.pendingCount;
        const ctx = ctxMgr.isStale() ? "stale" : "fresh";
        const tasks = (ctxMgr.getContext() as any)?.agent?.tasks?.count ?? "?";
        const crypto = client.hasCrypto ? "🔒 on" : "off";
        const sessions = activeSessions.size;
        return {
          text: [
            `Ringforge: ${s}`,
            `Agent: ${config.agentName} (${id})`,
            `Fleet: ${config.fleetId}`,
            `Uptime: ${up}s`,
            `Auto-reply: ${autoReply ? "on" : "off"}`,
            `Pending DMs: ${pending}`,
            `Active sessions: ${sessions}`,
            `Context: ${ctx} (${tasks} tasks)`,
            `Crypto: ${crypto}`,
          ].join("\n"),
        };
      },
    });

    // ── Service lifecycle ──
    api.registerService({
      id: "ringforge-mesh",
      start: async () => {
        api.logger.info(`Ringforge: connecting to ${config.server}...`);
        client.connect();
        dmHandler.start();

        // Wait for WS + join, then start context
        setTimeout(async () => {
          if (client.isConnected) {
            try {
              await ctxMgr.start();
              api.logger.info("Ringforge: context manager active");
            } catch (err) {
              api.logger.warn(`Ringforge: context start failed: ${err}`);
            }
          }
        }, 5000);
      },
      stop: () => {
        api.logger.info("Ringforge: shutting down");
        ctxMgr.stop();
        dmHandler.stop();
        client.disconnect();
      },
    });
  },
};

export default ringforgePlugin;
