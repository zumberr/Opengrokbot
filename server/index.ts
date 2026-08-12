// OpenMausBot server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { readFileSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, join } from "node:path";

import * as box from "./box.ts";
import * as composio from "./composio.ts";
import { ensureDirs, instanceConfigs, loadConfig, saveConfig, EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { MAX_BOTS, Store, type Message } from "./store.ts";

const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

ensureDirs();
const cfg = loadConfig();
const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
await registry.load(instanceConfigs(cfg));

const bus = new EventBus();
bus.attach(registry.instances());

// default selection for new bots: first available instance, claude preferred
async function defaultSelection() {
  const described = await registry.describe();
  const available = described.filter((d) => d.snapshot.state === "available");
  const pick = available.find((d) => d.driverKind === "claudeAgent") ?? available[0] ?? described[0];
  return { instanceId: pick?.instanceId ?? "claude", model: pick?.models.default || "claude-sonnet-5" };
}
let bootSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const store = new Store(() => bootSelection);
bootSelection = await defaultSelection();
store.seedIfEmpty();

// ── SSE fan-out to clients ─────────────────────────────────────────────
const sseClients = new Set<ServerResponse>();
function broadcast(payload: unknown) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...sseClients]) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ── server-side event folding (upstream's ingestion worker, miniature) ──
// The canonical stream is the source of truth; the persisted transcript
// and every client view are projections of it.
const toolMessageByItem = new Map<string, string>(); // itemId -> messageId
const askMessageByRequest = new Map<string, string>(); // requestId -> messageId

type CollaborationTurn = {
  collaborationId: string;
  coordinatorId: string;
  phase: "draft" | "synthesis";
  output: string[];
};

type CollaborationRun = {
  id: string;
  coordinatorId: string;
  participantIds: string[];
  prompt: string;
  pending: Set<string>;
  responses: Map<string, string>;
};

const collaborationTurns = new Map<string, CollaborationTurn>();
const collaborations = new Map<string, CollaborationRun>();

type SmartRole = "developer" | "supervisor" | "leader" | "creative" | "balanced";
type SmartCandidate = {
  instanceId: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  label: string;
};
type SmartRun = {
  botId: string;
  candidates: SmartCandidate[];
  index: number;
  failures: string[];
  launch: () => Promise<void>;
};

const SMART_POLICIES: Record<SmartRole, { label: string; description: string; candidates: SmartCandidate[] }> = {
  developer: {
    label: "Developer",
    description: "Open and efficient coding agents first; premium models only as fallback.",
    candidates: [
      { instanceId: "grok-build", model: "grok-4.6", label: "Grok Build · Grok 4.6" },
      { instanceId: "composer", model: "composer-2.5", label: "Composer 2.5 · Cursor" },
      { instanceId: "opencode", model: "opencode-go/kimi-k2.7-code", label: "Kimi K2.7 Code · OpenCode Go" },
      { instanceId: "opencode", model: "opencode-go/qwen3.7-plus", label: "Qwen 3.7 Plus · OpenCode Go" },
      { instanceId: "opencode", model: "opencode-go/deepseek-v4-flash", label: "DeepSeek V4 Flash · OpenCode Go" },
      { instanceId: "opencode", model: "opencode/deepseek-v4-flash-free", label: "DeepSeek V4 Flash Free" },
      { instanceId: "opencode", model: "opencode/mimo-v2.5-free", label: "MiMo V2.5 Free" },
      { instanceId: "opencode", model: "opencode/north-mini-code-free", label: "North Mini Code Free" },
      { instanceId: "kilo", model: "kilo/kilo-auto/free", label: "Kilo Auto Free" },
      { instanceId: "gemini", model: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { instanceId: "copilot", model: "auto", label: "GitHub Copilot Auto" },
      { instanceId: "codex", model: "gpt-5.6-luna", reasoningEffort: "medium", label: "GPT-5.6 Luna · medium" },
    ],
  },
  supervisor: {
    label: "Supervisor",
    description: "Reviews developer output for regressions, unsafe changes, and missing verification.",
    candidates: [
      { instanceId: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium", label: "GPT-5.6 Sol · medium" },
      { instanceId: "codex", model: "gpt-5.6-terra", reasoningEffort: "medium", label: "GPT-5.6 Terra · medium" },
      { instanceId: "gemini", model: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
      { instanceId: "grok-build", model: "grok-4.6", label: "Grok 4.6" },
      { instanceId: "claude", model: "claude-sonnet-5", label: "Claude Sonnet 5" },
    ],
  },
  leader: {
    label: "Leader",
    description: "Final quality gate with deeper reasoning after supervisor review.",
    candidates: [
      { instanceId: "codex", model: "gpt-5.6-sol", reasoningEffort: "high", label: "GPT-5.6 Sol · high" },
      { instanceId: "grok-build", model: "grok-4.6", label: "Grok 4.6" },
      { instanceId: "gemini", model: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
      { instanceId: "claude", model: "claude-opus-5", label: "Claude Opus 5" },
      { instanceId: "codex", model: "gpt-5.6-terra", reasoningEffort: "high", label: "GPT-5.6 Terra · high" },
    ],
  },
  creative: {
    label: "Creative",
    description: "Idea generation, design, writing, and high-variance exploration.",
    candidates: [
      { instanceId: "grok-build", model: "grok-4.6", label: "Grok 4.6" },
      { instanceId: "grok", model: "grok-4.6", label: "Grok 4.6 API" },
      { instanceId: "gemini", model: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
      { instanceId: "claude", model: "claude-opus-5", label: "Claude Opus 5" },
      { instanceId: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium", label: "GPT-5.6 Sol · medium" },
    ],
  },
  balanced: {
    label: "Auto",
    description: "Balanced automatic route for mixed everyday work.",
    candidates: [
      { instanceId: "opencode", model: "opencode-go/kimi-k2.7-code", label: "Kimi K2.7 Code · OpenCode Go" },
      { instanceId: "codex", model: "gpt-5.6-luna", reasoningEffort: "medium", label: "GPT-5.6 Luna · medium" },
      { instanceId: "grok-build", model: "grok-4.6", label: "Grok Build · Grok 4.6" },
      { instanceId: "composer", model: "composer-2.5", label: "Composer 2.5 · Cursor" },
      { instanceId: "gemini", model: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { instanceId: "claude", model: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { instanceId: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium", label: "GPT-5.6 Sol · medium" },
    ],
  },
};

const smartRuns = new Map<string, SmartRun>();
let availabilityCache: { at: number; available: Set<string> } | null = null;

async function availableInstances() {
  if (availabilityCache && Date.now() - availabilityCache.at < 30_000) return availabilityCache.available;
  const described = await registry.describe();
  const available = new Set(described.filter((item) => item.snapshot.state === "available").map((item) => item.instanceId));
  availabilityCache = { at: Date.now(), available };
  return available;
}

async function smartCandidates(role: SmartRole) {
  const available = await availableInstances();
  return SMART_POLICIES[role].candidates.filter((candidate) => available.has(candidate.instanceId));
}

function appendAndBroadcast(threadId: string, message: Omit<Message, "id" | "at">) {
  const full = store.appendMessage(threadId, message);
  broadcast({ kind: "message", threadId, message: full });
  return full;
}

function completeCollaborationDraft(botId: string, threadId: string) {
  const turn = collaborationTurns.get(threadId);
  if (!turn || turn.phase !== "draft") return;
  collaborationTurns.delete(threadId);
  const run = collaborations.get(turn.collaborationId);
  if (!run) return;

  run.responses.set(botId, turn.output.join("\n").trim() || "No response was produced.");
  run.pending.delete(botId);
  broadcast({
    kind: "collaboration",
    collaborationId: run.id,
    coordinatorId: run.coordinatorId,
    pending: run.pending.size,
    total: run.participantIds.length,
  });
  if (run.pending.size) return;

  const coordinator = store.bot(run.coordinatorId);
  if (!coordinator) {
    collaborations.delete(run.id);
    return;
  }

  const peerIds = run.participantIds.filter((id) => id !== run.coordinatorId);
  for (const peerId of peerIds) {
    const peer = store.bot(peerId);
    if (!peer) continue;
    appendAndBroadcast(coordinator.threadId, {
      role: "user",
      kind: "text",
      text: run.responses.get(peerId) ?? "No response was produced.",
      senderBotId: peer.id,
      senderName: peer.name,
      senderColor: peer.color,
      collaborationId: run.id,
    });
  }

  const peerBrief = peerIds
    .map((id) => {
      const peer = store.bot(id);
      return `### ${peer?.name ?? "Collaborator"}\n${run.responses.get(id) ?? "No response was produced."}`;
    })
    .join("\n\n");
  const synthesis = [
    `This is the synthesis phase of team run ${run.id}.`,
    `Original request: ${run.prompt}`,
    "Review the collaborators' drafts below. Produce one decisive final answer for the user, resolving conflicts and keeping the strongest details.",
    peerBrief,
  ].join("\n\n");

  collaborations.delete(run.id);
  setTimeout(() => {
    void startTurn(coordinator.id, synthesis, {
      collaborationId: run.id,
      phase: "synthesis",
      displayText: "Team drafts received. Building the final synthesis…",
      senderName: "Team orchestrator",
    }).catch((error) => {
      appendAndBroadcast(coordinator.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `team synthesis failed: ${(error as Error).message.slice(0, 140)}`, ok: false },
      });
    });
  }, 0);
}

bus.subscribe((event: RuntimeEvent) => {
  broadcast({ kind: "runtime", event });
  const bot = store.botByThread(event.threadId);
  if (!bot) return;

  const pushMessage = (m: Omit<Message, "id" | "at">) => {
    const message = store.appendMessage(event.threadId, m);
    broadcast({ kind: "message", threadId: event.threadId, message });
    return message;
  };

  switch (event.type) {
    case "session.started":
      if (event.sessionId && event.providerInstanceId) {
        store.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId);
      }
      break;
    case "item.completed":
      if (event.itemType === "assistant_text") {
        pushMessage({ role: "bot", kind: "text", text: event.text });
        const collaboration = collaborationTurns.get(event.threadId);
        if (collaboration) collaboration.output.push(event.text);
      } else if (event.itemType === "tool" && event.itemId) {
        const messageId = toolMessageByItem.get(event.itemId);
        if (messageId) {
          const patched = store.patchMessage(event.threadId, messageId, {
            tool: { name: store.messagesFor(event.threadId).find((m) => m.id === messageId)?.tool?.name ?? "tool", ok: event.ok },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
          toolMessageByItem.delete(event.itemId);
        }
        // the bot just finished acting — refresh its screen preview now
        pokeScreenPoller(bot.id);
      }
      break;
    case "item.started":
      if (event.itemType === "tool") {
        const message = pushMessage({ role: "bot", kind: "activity", tool: { name: event.title ?? "tool" } });
        if (event.itemId) toolMessageByItem.set(event.itemId, message.id);
      }
      break;
    case "request.opened": {
      const permission = event.requestType === "permission";
      const message = pushMessage({
        role: "bot",
        kind: "options",
        card: {
          title: permission ? "Approval needed" : "Your bot has a question",
          subtitle: event.summary,
          options: event.choices?.length ? event.choices : permission ? ["Allow", "Deny"] : [],
          requestId: event.requestId,
        },
      });
      if (event.requestId) askMessageByRequest.set(event.requestId, message.id);
      break;
    }
    case "request.resolved": {
      const messageId = event.requestId ? askMessageByRequest.get(event.requestId) : null;
      if (messageId) {
        const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId);
        if (existing?.card && !existing.card.answered) {
          const patched = store.patchMessage(event.threadId, messageId, {
            card: { ...existing.card, answered: event.behavior, dismissed: event.source !== "user" },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
        }
        if (event.requestId) askMessageByRequest.delete(event.requestId);
      }
      break;
    }
    case "runtime.error": {
      const smart = smartRuns.get(event.threadId);
      if (smart) smart.failures.push(event.message);
      else pushMessage({ role: "bot", kind: "activity", tool: { name: `error: ${event.message.slice(0, 160)}`, ok: false } });
      break;
    }
    case "turn.completed": {
      const smart = smartRuns.get(event.threadId);
      if (!event.ok && smart && smart.index + 1 < smart.candidates.length) {
        const previous = smart.candidates[smart.index];
        smart.index += 1;
        const next = smart.candidates[smart.index];
        pushMessage({
          role: "bot",
          kind: "activity",
          tool: { name: `Smart fallback: ${previous.label} → ${next.label}`, ok: true },
        });
        void smart.launch().catch((error) => {
          smartRuns.delete(event.threadId);
          pushMessage({
            role: "bot",
            kind: "activity",
            tool: { name: `all smart routes failed: ${(error as Error).message.slice(0, 130)}`, ok: false },
          });
          store.patchBot(bot.id, { busy: false, unread: true });
          broadcast({ kind: "bot", bot: store.bot(bot.id) });
          completeCollaborationDraft(bot.id, event.threadId);
        });
        break;
      }
      if (smart) {
        smartRuns.delete(event.threadId);
        if (!event.ok && smart.failures.length) {
          pushMessage({
            role: "bot",
            kind: "activity",
            tool: { name: `all smart routes failed: ${smart.failures.at(-1)!.slice(0, 130)}`, ok: false },
          });
        }
      }
      // the last live frame becomes a settled inline screen message —
      // the screenshot-in-chat moment
      const frame = stopScreenPoller(bot.id);
      if (frame) pushMessage({ role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
      store.patchBot(bot.id, { busy: false, unread: true });
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      completeCollaborationDraft(bot.id, event.threadId);
      break;
    }
  }
});

// ── live screen: poll the bot's box while it works ────────────────────
// Frames stream to clients as SSE {kind:'screen'} (the "Bot's screen"
// panel); the final frame is folded into the transcript on turn end.
type Frame = { png: string; mime: string };
const screenPollers = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; capture: () => Promise<void>; last: Frame | null }
>();

function startScreenPoller(botId: string) {
  if (screenPollers.has(botId) || !box.boxConfigured(cfg)) return;
  let inFlight = false;
  const capture = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { png, format } = await box.screenshotBox(cfg, botId);
      const frame = { png, mime: format === "jpeg" ? "image/jpeg" : "image/png" };
      entry.last = frame;
      broadcast({ kind: "screen", botId, ...frame });
    } catch {
      /* box asleep or mid-command — try again next tick */
    } finally {
      inFlight = false;
    }
  };
  const entry = {
    timer: setInterval(capture, 4000),
    capture,
    last: null as Frame | null,
  };
  screenPollers.set(botId, entry);
}

/** Event-driven refresh: capture NOW (the bot just acted on its screen)
 * instead of waiting for the next interval tick. */
function pokeScreenPoller(botId: string) {
  void screenPollers.get(botId)?.capture();
}

function stopScreenPoller(botId: string): Frame | null {
  const entry = screenPollers.get(botId);
  if (!entry) return null;
  clearInterval(entry.timer);
  screenPollers.delete(botId);
  return entry.last;
}

// Local computer-use contract written by Electron main on startup
// (~/Library/Application Support/OpenMausBot/cua-connection.json). Read
// fresh each turn — Electron may restart or permissions may change.
function readCuaConnection(): { command: string; args: string[]; env: Record<string, string> } | null {
  const dirs = ["OpenMausBot", "openmausbot", "OpenGrokBot", "opengrokbot"];
  for (const dir of dirs) {
    try {
      const p1 = join(homedir(), "Library", "Application Support", dir, "cua-connection.json");
      const conn = JSON.parse(readFileSync(p1, "utf8"));
      if (conn && conn.mode !== "unavailable" && conn.mcpCommand) {
        return { command: conn.mcpCommand, args: conn.mcpArgs ?? ["mcp"], env: conn.mcpEnv ?? {} };
      }
    } catch {}
    try {
      const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
      const p2 = join(appData, dir, "cua-connection.json");
      const conn = JSON.parse(readFileSync(p2, "utf8"));
      if (conn && conn.mode !== "unavailable" && conn.mcpCommand) {
        return { command: conn.mcpCommand, args: conn.mcpArgs ?? ["mcp"], env: conn.mcpEnv ?? {} };
      }
    } catch {}
  }
  return null;
}

// ── turn dispatch (upstream ProviderCommandReactor, miniature) ──────────
type StartTurnOptions = {
  collaborationId?: string;
  coordinatorId?: string;
  phase?: "draft" | "synthesis";
  displayText?: string;
  senderBotId?: string;
  senderName?: string;
};

async function startTurn(botId: string, text: string, options: StartTurnOptions = {}) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
  if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });

  const role = bot.smartRole ?? "balanced";
  const candidates: SmartCandidate[] = bot.routingMode === "manual"
    ? [{ ...bot.modelSelection, label: bot.modelSelection.model }]
    : await smartCandidates(role);
  const initialInstance = registry.get(candidates[0]?.instanceId ?? "");
  if (!candidates.length || !initialInstance) {
    throw Object.assign(
      new Error(
        bot.routingMode === "manual"
          ? `provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`
          : `no providers are available for the ${SMART_POLICIES[role].label} smart route`,
      ),
      { status: 409 },
    );
  }

  const sender = options.senderBotId ? store.bot(options.senderBotId) : null;
  const userMessage = store.appendMessage(bot.threadId, {
    role: "user",
    kind: "text",
    text: options.displayText ?? text,
    ...(options.senderBotId ? { senderBotId: options.senderBotId } : {}),
    ...(options.senderName || sender?.name ? { senderName: options.senderName ?? sender?.name } : {}),
    ...(sender ? { senderColor: sender.color } : {}),
    ...(options.collaborationId ? { collaborationId: options.collaborationId } : {}),
  });
  broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });

  // transcript for API-backed drivers: settled text turns only
  const transcript = store
    .messagesFor(bot.threadId)
    .filter((m) => m.kind === "text" && m.text && m.id !== userMessage.id)
    .slice(-40)
    .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: m.text! }));

  const persona = [
    `You are ${bot.name}, a personal bot in OpenMausBot.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
  ]
    .filter(Boolean)
    .join(" ");

  // busy flips immediately so the composer locks; the dispatch itself runs
  // in the background — box provisioning can take ~90s and must never
  // hang the HTTP request
  store.patchBot(bot.id, { busy: true, unread: false });
  broadcast({ kind: "bot", bot: store.bot(bot.id) });

  if (options.collaborationId && options.coordinatorId && options.phase) {
    collaborationTurns.set(bot.threadId, {
      collaborationId: options.collaborationId,
      coordinatorId: options.coordinatorId,
      phase: options.phase,
      output: [],
    });
  }

  void (async () => {
    try {
      const integrations: NonNullable<Parameters<typeof initialInstance.adapter.sendTurn>[0]["integrations"]> = {};
      if (cfg.composio?.key) integrations.composio = { key: cfg.composio.key, url: cfg.composio.url };
      const wants = bot.computer; // 'cloud' | 'local' | 'off' | undefined(auto)
      if (wants !== "off" && wants !== "local" && box.boxConfigured(cfg)) {
        let b = await box.findBox(cfg, bot.id).catch(() => null);
        // the Computer driver runs ON the box — provision it on first use
        if (!b && initialInstance.driverKind === "boxAgent") {
          broadcast({ kind: "computer", botId: bot.id, state: "provisioning" });
          await box.provisionBox(cfg, bot.id, bot.name);
          b = await box.findBox(cfg, bot.id).catch(() => null);
        }
        if (b) integrations.computer = { boxId: b.id, token: cfg.box!.token! };
      }
      // local computer (this Mac) via the Electron-hosted cua-driver: the
      // Electron main process owns the daemon (TCC attribution) and writes
      // its spawn contract to cua-connection.json; the harness only reads it
      if (!integrations.computer && wants !== "off" && wants !== "cloud") {
        const cua = readCuaConnection();
        if (cua) integrations.localComputer = cua;
      }

      const launch = async (): Promise<void> => {
        const smart = smartRuns.get(bot.threadId);
        const candidate = smart ? smart.candidates[smart.index] : candidates[0];
        const instance = registry.get(candidate.instanceId);
        if (!instance) throw new Error(`${candidate.label} became unavailable`);
        store.patchBot(bot.id, {
          lastRoute: {
            instanceId: candidate.instanceId,
            model: candidate.model,
            ...(candidate.reasoningEffort ? { reasoningEffort: candidate.reasoningEffort } : {}),
          },
        });
        broadcast({ kind: "bot", bot: store.bot(bot.id) });
        try {
          await instance.adapter.sendTurn({
            threadId: bot.threadId,
            text,
            model: candidate.model,
            reasoningEffort: candidate.reasoningEffort,
            resumeCursor: bot.resumeCursors[candidate.instanceId],
            transcript,
            system:
              persona +
              ` Smart role: ${SMART_POLICIES[role].label}. ` +
              (role === "developer"
                ? "Implement scoped changes carefully and validate them. Do not modify unrelated code."
                : role === "supervisor"
                  ? "Review prior work for defects, unsafe behavior, regressions, missing tests, and scope drift. Be evidence-driven."
                  : role === "leader"
                    ? "Act as the final quality gate. Recheck supervisor conclusions and reject unsafe or unverified work."
                    : role === "creative"
                      ? "Explore distinctive, high-quality creative options while respecting hard constraints."
                      : "Choose the most useful balance of execution, verification, and clarity.") +
              " You may collaborate with other bots when the user starts a team run. Treat messages labelled as coming from another bot as peer work: verify it, improve it, and clearly resolve disagreements." +
              (integrations.computer && instance.driverKind !== "boxAgent"
                ? " You have your own cloud computer — use the computer tools whenever browsing or acting on a desktop helps."
                : integrations.localComputer
                  ? " You can act on the user's computer through computer tools. Inspect state first and act carefully."
                  : ""),
            integrations,
          });
        } catch (error) {
          const current = smartRuns.get(bot.threadId);
          if (current && current.index + 1 < current.candidates.length) {
            current.failures.push((error as Error).message);
            const previous = current.candidates[current.index];
            current.index += 1;
            const next = current.candidates[current.index];
            appendAndBroadcast(bot.threadId, {
              role: "bot",
              kind: "activity",
              tool: { name: `Smart fallback: ${previous.label} → ${next.label}`, ok: true },
            });
            await current.launch();
            return;
          }
          throw error;
        }
      };
      if (bot.routingMode !== "manual") {
        smartRuns.set(bot.threadId, { botId: bot.id, candidates, index: 0, failures: [], launch });
      }
      await launch();
      if (integrations.computer) startScreenPoller(bot.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const failure = store.appendMessage(bot.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `error: ${message.slice(0, 160)}`, ok: false },
      });
      broadcast({ kind: "message", threadId: bot.threadId, message: failure });
      store.patchBot(bot.id, { busy: false });
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      smartRuns.delete(bot.threadId);
      completeCollaborationDraft(bot.id, bot.threadId);
    }
  })();
}

// ── config hot-reload ─────────────────────────────────────────────────
function configStatus() {
  return {
    xai: { configured: Boolean(cfg.xai?.key) },
    custom: { configured: Boolean(cfg.custom?.key), url: cfg.custom?.url },
    composio: { configured: Boolean(cfg.composio?.key), apiKeyConfigured: Boolean(cfg.composio?.apiKey) },
    box: { configured: Boolean(cfg.box?.token) },
  };
}

/** Rebuild the provider fleet after a config change so new keys take
 * effect without a server restart (kills any in-flight turns). */
async function reloadProviders() {
  smartRuns.clear();
  bus.detachAll();
  await registry.disposeAll();
  await registry.load(instanceConfigs(cfg));
  bus.attach(registry.instances());
  availabilityCache = null;
}

// ── HTTP plumbing ─────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  try {
    // ── events stream ──
    if (method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
      sseClients.add(res);
      const keepalive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch {}
      }, 25_000);
      req.on("close", () => {
        clearInterval(keepalive);
        sseClients.delete(res);
      });
      return;
    }

    // ── bots ──
    if (method === "GET" && path === "/api/bots") {
      return json(res, 200, {
        bots: store.bots.map((b) => ({ ...b, messages: store.messagesFor(b.threadId) })),
        maxBots: MAX_BOTS,
      });
    }
    if (method === "GET" && path === "/api/smart-routing") {
      const available = await availableInstances();
      return json(res, 200, {
        profiles: Object.entries(SMART_POLICIES).map(([id, policy]) => ({
          id,
          label: policy.label,
          description: policy.description,
          candidates: policy.candidates.map((candidate) => ({
            ...candidate,
            available: available.has(candidate.instanceId),
          })),
        })),
      });
    }
    if (method === "POST" && path === "/api/bots") {
      const bot = store.createBot();
      store.patchBot(bot.id, { modelSelection: await defaultSelection() });
      return json(res, 201, { bot: { ...store.bot(bot.id)!, messages: store.messagesFor(bot.threadId) } });
    }
    let m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (body.routingMode !== undefined && !["smart", "manual"].includes(body.routingMode)) {
        return json(res, 400, { error: "routingMode must be smart or manual" });
      }
      if (body.smartRole !== undefined && !["developer", "supervisor", "leader", "creative", "balanced"].includes(body.smartRole)) {
        return json(res, 400, { error: "unknown smart role" });
      }
      const patch: Record<string, unknown> = {};
      for (const key of ["name", "title", "description", "notifications", "modelSelection", "routingMode", "smartRole", "unread", "computer", "color", "mascotExpression", "pinned", "hidden"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      const bot = store.patchBot(m[1], patch);
      if (!bot) return json(res, 404, { error: "no such bot" });
      broadcast({ kind: "bot", bot });
      return json(res, 200, { bot });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // a running turn dies with its bot
      smartRuns.delete(bot.threadId);
      await registry.get(bot.lastRoute?.instanceId ?? bot.modelSelection.instanceId)?.adapter.interruptTurn(bot.threadId).catch(() => {});
      stopScreenPoller(bot.id);
      store.deleteBot(bot.id);
      for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
        try {
          unlinkSync(join(dir, `${bot.threadId}.ndjson`));
        } catch {}
      }
      broadcast({ kind: "bot.deleted", botId: bot.id });
      return json(res, 200, { ok: true });
    }

    // onboarding/ask cards persist their answered/dismissed state
    m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) return json(res, 404, { error: "no such card" });
      const body = await readBody(req);
      const patched = store.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(body.answered !== undefined ? { answered: body.answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
      return json(res, 200, { message: patched });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      await startTurn(m[1], text);
      return json(res, 202, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/collaborate$/);
    if (m && method === "POST") {
      const coordinator = store.bot(m[1]);
      if (!coordinator) return json(res, 404, { error: "no such coordinator bot" });
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const requested: string[] = Array.isArray(body.botIds)
        ? body.botIds.map((id: unknown) => String(id))
        : [];
      const peerIds = [...new Set(requested)].filter((id) => id !== coordinator.id);
      if (!peerIds.length) return json(res, 400, { error: "choose at least one collaborator" });
      if (peerIds.length > 7) return json(res, 400, { error: "a team run supports up to 7 collaborators" });
      const participants = [coordinator.id, ...peerIds].map((id) => store.bot(id));
      if (participants.some((bot) => !bot)) return json(res, 404, { error: "one or more collaborators no longer exist" });
      const unavailable = participants.find((bot) => bot!.busy);
      if (unavailable) {
        return json(res, 409, {
          error: `${unavailable.name} is already working`,
        });
      }

      const id = crypto.randomUUID();
      const run: CollaborationRun = {
        id,
        coordinatorId: coordinator.id,
        participantIds: participants.map((bot) => bot!.id),
        prompt: text,
        pending: new Set(participants.map((bot) => bot!.id)),
        responses: new Map(),
      };
      collaborations.set(id, run);
      broadcast({ kind: "collaboration", collaborationId: id, coordinatorId: coordinator.id, pending: participants.length, total: participants.length });

      for (const participant of participants) {
        const isCoordinator = participant!.id === coordinator.id;
        const prompt = isCoordinator
          ? `${text}\n\nYou are coordinating a team run. Create your own draft now; after the other bots finish, you will receive their drafts and produce the final synthesis.`
          : `Team request from ${coordinator.name}:\n\n${text}\n\nCreate an independent, concrete draft for ${coordinator.name} to review. Do not merely agree; flag risks and improve the plan.`;
        void startTurn(participant!.id, prompt, {
          collaborationId: id,
          coordinatorId: coordinator.id,
          phase: "draft",
          displayText: text,
          ...(isCoordinator ? {} : { senderBotId: coordinator.id }),
        }).catch((error) => {
          run.responses.set(participant!.id, `Failed to respond: ${(error as Error).message}`);
          run.pending.delete(participant!.id);
          if (!run.pending.size) completeCollaborationDraft(participant!.id, participant!.threadId);
        });
      }
      return json(res, 202, { ok: true, collaborationId: id });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const instance = registry.get(bot.lastRoute?.instanceId ?? bot.modelSelection.instanceId);
      if (!instance) return json(res, 409, { error: "provider unavailable" });
      await instance.adapter.respondToRequest(bot.threadId, String(body.requestId), {
        behavior: body.behavior,
        message: body.message,
      });
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const instance = registry.get(bot.lastRoute?.instanceId ?? bot.modelSelection.instanceId);
      smartRuns.delete(bot.threadId);
      await instance?.adapter.interruptTurn(bot.threadId);
      return json(res, 200, { ok: true });
    }

    // identity handshake for the packaged app's port fallback: the forked
    // child proves it is OURS by echoing its pid (a stray dev server has
    // the same API shape but a different pid)
    if (method === "GET" && path === "/api/health") {
      return json(res, 200, { app: "openmausbot", pid: process.pid, static: Boolean(STATIC_DIR) });
    }

    // ── provider instances (model picker) ──
    if (method === "GET" && path === "/api/instances") {
      return json(res, 200, { instances: await registry.describe() });
    }

    // ── app config (API keys — never echoed back, booleans only) ──
    if (method === "GET" && path === "/api/config") {
      return json(res, 200, configStatus());
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      const patch: Record<string, object> = {};
      for (const key of ["xai", "custom", "composio", "box"] as const) {
        if (body[key] && typeof body[key] === "object") patch[key] = body[key];
      }
      if (!Object.keys(patch).length) return json(res, 400, { error: "nothing to save" });
      saveConfig(patch);
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      const status = configStatus();
      broadcast({ kind: "config", ...status });
      return json(res, 200, status);
    }

    // ── connectors (Composio) ──
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source } = await composio.listToolkits(cfg);
      return json(res, 200, { configured: Boolean(cfg.composio?.key), source, cards });
    }
    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      if (!cfg.composio?.key) return json(res, 200, { configured: false, services: {} });
      const status = await composio.connectionStatus(cfg, services.length ? services : composio.CURATED_SLUGS);
      return json(res, 200, { configured: true, services: status });
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (m && method === "POST") return json(res, 200, await composio.authorizeService(cfg, m[1]));
    m = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (m && method === "DELETE") return json(res, 200, await composio.removeService(cfg, m[1]));

    // ── the bot's cloud computer (Box) ──
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer$/);
    if (m && method === "GET") return json(res, 200, await box.boxStatus(cfg, m[1]));
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/(provision|join|sleep|exec|screenshot)$/);
    if (m && method === "POST") {
      const botId = m[1];
      const bot = store.bot(botId);
      if (!bot) return json(res, 404, { error: "no such bot" });
      switch (m[2]) {
        case "provision":
          return json(res, 200, await box.provisionBox(cfg, botId, bot.name));
        case "join":
          return json(res, 200, await box.joinBox(cfg, botId));
        case "sleep":
          return json(res, 200, await box.sleepBox(cfg, botId));
        case "exec": {
          const body = await readBody(req);
          return json(res, 200, await box.execOnBox(cfg, botId, String(body.command ?? "")));
        }
        case "screenshot":
          return json(res, 200, await box.screenshotBox(cfg, botId));
      }
    }

    // packaged app: the server serves the built UI too (window → :8799 for
    // everything, no dev proxy to die). OMB_STATIC_DIR is set by Electron.
    if (method === "GET" && !path.startsWith("/api/") && STATIC_DIR) {
      const safe = path === "/" ? "/index.html" : path.replace(/\.\./g, "");
      const file = join(STATIC_DIR, safe);
      try {
        const data = readFileSync(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        return res.end(data);
      } catch {
        // SPA fallback
        try {
          const data = readFileSync(join(STATIC_DIR, "index.html"));
          res.writeHead(200, { "content-type": "text/html" });
          return res.end(data);
        } catch {
          /* fall through to 404 */
        }
      }
    }

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as any)?.status ?? 500;
    return json(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`openmausbot server on http://127.0.0.1:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void registry.disposeAll().finally(() => process.exit(0));
  });
}
