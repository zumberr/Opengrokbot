import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "externalCli";

type Preset = "gemini" | "copilot" | "grokBuild" | "cursor" | "cline" | "opencode" | "kilo";

interface ExternalCliConfig {
  preset: Preset;
  cli: string;
}

const PRESETS: Record<Preset, { label: string; cli: string; models: ModelCatalog }> = {
  gemini: {
    label: "Gemini / Antigravity",
    cli: "agy",
    models: {
      default: "gemini-3.5-flash",
      options: [
        { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
        { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
        { id: "gemini-3-flash", label: "Gemini 3 Flash" },
      ],
    },
  },
  copilot: {
    label: "GitHub Copilot",
    cli: "copilot",
    models: {
      default: "auto",
      options: [
        { id: "auto", label: "Copilot Auto" },
        { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
      ],
    },
  },
  grokBuild: {
    label: "Grok Build",
    cli: "grok",
    models: {
      default: "grok-4.6",
      options: [
        { id: "grok-4.6", label: "Grok Build · Grok 4.6" },
        { id: "grok-4.5", label: "Grok Build · Grok 4.5" },
      ],
    },
  },
  cursor: {
    label: "Cursor Composer",
    cli: "cursor-agent",
    models: {
      default: "composer-2.5",
      options: [
        { id: "composer-2.5", label: "Composer 2.5" },
        { id: "composer-2-fast", label: "Composer 2 Fast" },
        { id: "auto", label: "Cursor Auto" },
      ],
    },
  },
  cline: {
    label: "Cline",
    cli: "cline",
    models: {
      default: "configured",
      options: [{ id: "configured", label: "Configured Cline model" }],
    },
  },
  opencode: {
    label: "OpenCode",
    cli: "opencode",
    models: {
      default: "opencode/kimi-k2.7-code",
      options: [
        { id: "opencode-go/kimi-k2.7-code", label: "Kimi K2.7 Code · Go" },
        { id: "opencode-go/qwen3.7-plus", label: "Qwen 3.7 Plus · Go" },
        { id: "opencode-go/deepseek-v4-flash", label: "DeepSeek V4 Flash · Go" },
        { id: "opencode-go/gpt-5.6-luna", label: "GPT-5.6 Luna · Go" },
        { id: "opencode/kimi-k2.7-code", label: "Kimi K2.7 Code" },
        { id: "opencode/qwen3.7-plus", label: "Qwen 3.7 Plus" },
        { id: "opencode/deepseek-v4-flash-free", label: "DeepSeek V4 Flash · Free" },
        { id: "opencode/mimo-v2.5-free", label: "MiMo V2.5 · Free" },
        { id: "opencode/north-mini-code-free", label: "North Mini Code · Free" },
        { id: "opencode/grok-build-0.1", label: "Grok Build 0.1" },
        { id: "opencode/grok-4.5", label: "Grok 4.5" },
        { id: "opencode/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
        { id: "opencode/gemini-3.1-pro", label: "Gemini 3.1 Pro" },
        { id: "opencode/gpt-5.6-luna", label: "GPT-5.6 Luna" },
        { id: "opencode/gpt-5.6-terra", label: "GPT-5.6 Terra" },
        { id: "opencode/gpt-5.6-sol", label: "GPT-5.6 Sol" },
      ],
    },
  },
  kilo: {
    label: "Kilo",
    cli: "kilo",
    models: {
      default: "kilo/kilo-auto/free",
      options: [
        { id: "kilo/kilo-auto/free", label: "Kilo Auto · Free" },
        { id: "kilo/moonshotai/kimi-k2.7-code", label: "Kimi K2.7 Code" },
        { id: "kilo/cohere/north-mini-code:free", label: "North Mini Code · Free" },
        { id: "kilo/x-ai/grok-4.6", label: "Grok 4.6" },
      ],
    },
  },
};

function decodeConfig(raw: unknown): ExternalCliConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  const preset = typeof value.preset === "string" && value.preset in PRESETS ? (value.preset as Preset) : "opencode";
  return {
    preset,
    cli: typeof value.cli === "string" ? value.cli : PRESETS[preset].cli,
  };
}

function promptFor(turn: SendTurnInput) {
  const history = turn.transcript?.length
    ? [
        "Conversation context:",
        ...turn.transcript.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`),
      ].join("\n\n")
    : "";
  return [turn.system, history, `Current request:\n${turn.text}`].filter(Boolean).join("\n\n");
}

const EXTENSION_ROOTS = [
  join(homedir(), ".vscode", "extensions"),
  join(homedir(), ".cursor", "extensions"),
  join(homedir(), ".windsurf", "extensions"),
  join(homedir(), ".antigravity", "extensions"),
];

function extensionDirectories(prefixes: string[]) {
  const matches: string[] = [];
  for (const root of EXTENSION_ROOTS) {
    try {
      for (const name of readdirSync(root)) {
        if (prefixes.some((prefix) => name.toLowerCase().startsWith(prefix))) matches.push(join(root, name));
      }
    } catch {}
  }
  return matches.sort((a, b) => basename(b).localeCompare(basename(a), undefined, { numeric: true }));
}

function bundledExtensionCommand(preset: Preset): string | null {
  if (process.platform !== "win32") return null;
  if (preset === "kilo") {
    for (const directory of extensionDirectories(["kilocode.kilo-code-"])) {
      const executable = join(directory, "bin", "kilo.exe");
      if (existsSync(executable)) return executable;
    }
  }
  return null;
}

function detectedEditorSurface(preset: Preset): string | null {
  const definitions: Partial<Record<Preset, { prefixes: string[]; label: string }>> = {
    cline: { prefixes: ["saoudrizwan.claude-dev-", "rooveterinaryinc.roo-cline-"], label: "Cline IDE extension" },
    kilo: { prefixes: ["kilocode.kilo-code-"], label: "Kilo IDE extension" },
    gemini: { prefixes: ["google.geminicodeassist-"], label: "Gemini Code Assist extension" },
  };
  const definition = definitions[preset];
  if (definition && extensionDirectories(definition.prefixes).length) return definition.label;
  if (preset === "cursor") {
    const cursor = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "cursor", "Cursor.exe");
    if (existsSync(cursor)) return "Cursor Desktop";
  }
  if (preset === "gemini" && existsSync(join(homedir(), ".antigravity"))) return "Google Antigravity editor";
  return null;
}

function resolveWindowsPath(cli: string): { command: string; prefix: string[] } | null {
  try {
    const paths = execFileSync("where.exe", [cli], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const executable = paths.find((value) => /\.exe$/i.test(value));
    if (executable) return { command: executable, prefix: [] };
    const cmd = paths.find((value) => /\.cmd$/i.test(value));
    const script = paths.find((value) => /\.ps1$/i.test(value)) ??
      (cmd && existsSync(cmd.replace(/\.cmd$/i, ".ps1")) ? cmd.replace(/\.cmd$/i, ".ps1") : undefined);
    if (script) {
      return {
        command: "powershell.exe",
        prefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      };
    }
    if (cmd) return { command: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", cmd] };
  } catch {}
  return null;
}

function resolveCommand(cli: string, preset: Preset): { command: string; prefix: string[] } {
  if (process.platform !== "win32" || /[\\/]/.test(cli)) return { command: cli, prefix: [] };
  const onPath = resolveWindowsPath(cli);
  if (onPath) return onPath;
  // Google replaced the consumer Gemini CLI surface with Antigravity CLI.
  // Keep the legacy name as a fallback for enterprise/older installations.
  if (preset === "gemini") {
    const alternate = resolveWindowsPath(cli === "agy" ? "gemini" : "agy");
    if (alternate) return alternate;
    const nativeAgy = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe");
    if (existsSync(nativeAgy)) return { command: nativeAgy, prefix: [] };
  }
  const bundled = bundledExtensionCommand(preset);
  if (bundled) return { command: bundled, prefix: [] };
  return { command: cli, prefix: [] };
}

function commandArgs(config: ExternalCliConfig, turn: SendTurnInput): string[] {
  const prompt = promptFor(turn);
  const model = turn.model;
  switch (config.preset) {
    case "gemini":
      return ["-p", prompt, "--output-format", "stream-json", ...(model ? ["--model", model] : [])];
    case "copilot":
      return ["-p", prompt, "--output-format", "json", "--no-color", "--no-ask-user", ...(model ? ["--model", model] : [])];
    case "grokBuild":
      return ["-p", prompt, "--output-format", "streaming-json", ...(model ? ["--model", model] : [])];
    case "cursor":
      return ["-p", prompt, "--output-format", "stream-json", ...(model ? ["--model", model] : [])];
    case "cline":
      return ["--json", prompt];
    case "kilo":
    case "opencode":
      return [
        "run",
        prompt,
        "--format",
        "json",
        ...(model && model !== "configured" ? ["--model", model] : []),
        ...(turn.reasoningEffort ? ["--variant", turn.reasoningEffort] : []),
      ];
  }
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => (part && typeof part === "object" && typeof (part as any).text === "string" ? (part as any).text : ""))
    .join("");
  return text || undefined;
}

function textFromEvent(value: any): { text?: string; final?: boolean; sessionId?: string } {
  if (!value || typeof value !== "object") return {};
  const sessionId = value.session_id ?? value.sessionId ?? value.sessionID ?? value.session?.id;
  if (typeof value.response === "string") return { text: value.response, final: true, sessionId };
  if (typeof value.result === "string") return { text: value.result, final: true, sessionId };
  if (typeof value.text === "string" && ["result", "assistant", "assistant.message"].includes(value.type)) {
    return { text: value.text, final: value.type === "result", sessionId };
  }
  if (value.type === "message" && (value.role === "assistant" || value.message?.role === "assistant")) {
    const text = contentText(value.content) ?? contentText(value.text) ?? contentText(value.message?.content);
    return text ? { text, final: false, sessionId } : { sessionId };
  }
  if (value.type === "text" && typeof value.part?.text === "string") {
    return { text: value.part.text, final: false, sessionId };
  }
  if (value.type === "text" && typeof value.data === "string") {
    return { text: value.data, final: false, sessionId };
  }
  if (/assistant.*delta|message.*delta/i.test(String(value.type ?? ""))) {
    const text = value.delta ?? value.data?.delta ?? value.data?.content;
    return typeof text === "string" ? { text, final: false, sessionId } : { sessionId };
  }
  if (/assistant|message/i.test(String(value.type ?? ""))) {
    const text = contentText(value.data?.content) ?? contentText(value.data?.text) ?? contentText(value.message?.content);
    return text ? { text, final: true, sessionId } : { sessionId };
  }
  return { sessionId };
}

export const ExternalCliDriver: ProviderDriver<ExternalCliConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "External Agent", supportsMultipleInstances: true },
  models: PRESETS.opencode.models,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ExternalCliConfig>): Promise<ProviderInstance> {
    const { instanceId, config, environment } = input;
    const preset = PRESETS[config.preset];
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { stop: () => void; turnId: string }>();
    const emit = (event: RuntimeEvent) => {
      for (const listener of [...listeners]) listener(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const args = commandArgs(config, turn);
      const resolved = resolveCommand(config.cli, config.preset);
      const child = spawn(resolved.command, [...resolved.prefix, ...args], {
        cwd: turn.cwd ?? homedir(),
        env: { ...process.env, HOME: process.env.HOME || homedir(), ...environment, NO_COLOR: "1", CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const stop = () => {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          try { child.kill("SIGTERM"); } catch {}
        }
      };
      active.set(turn.threadId, { stop, turnId });
      emit({ ...base(turn.threadId, turnId), type: "turn.started" });
      emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? preset.models.default });
      appendNative(turn.threadId, {
        dir: "out",
        source: `${config.preset}.cli`,
        msg: { args: args.map((arg, index) => index === 1 && ["-p", "run"].includes(args[0]) ? "<prompt>" : arg) },
      });

      let buffer = "";
      let stderr = "";
      let streamed = "";
      let finalText = "";
      let settled = false;
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }
        appendNative(turn.threadId, { dir: "in", source: `${config.preset}.cli`, msg: event });
        const parsed = textFromEvent(event);
        if (parsed.sessionId) {
          emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: String(parsed.sessionId), model: turn.model ?? preset.models.default });
        }
        if (!parsed.text?.trim()) return;
        if (parsed.final) finalText = parsed.text;
        else {
          streamed += parsed.text;
          emit({ ...base(turn.threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: parsed.text });
        }
      };
      const settle = (ok: boolean, reason: string | null) => {
        if (settled) return;
        settled = true;
        active.delete(turn.threadId);
        const text = finalText || streamed;
        // A failed provider may have printed a partial answer before exiting.
        // Never settle that text into history: the next smart candidate must
        // receive a clean transcript and become the only visible answer.
        if (ok && text.trim()) emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        if (!ok) {
          emit({
            ...base(turn.threadId, turnId),
            type: "runtime.error",
            message: `${preset.label} failed${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
        }
        emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok, stopReason: reason, cost: null });
      };
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          handleLine(line);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on("error", (error) => {
        stderr += ` ${error.message}`;
        settle(false, "spawn_error");
      });
      child.on("close", (code) => {
        if (buffer.trim()) handleLine(buffer);
        settle(code === 0 && Boolean((finalText || streamed).trim()), code === 0 ? null : `exit_${code}`);
      });
      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const resolved = resolveCommand(config.cli, config.preset);
      const probe = await new Promise<{ version: string | null; reason?: string }>((resolve) => {
        let settled = false;
        const done = (value: { version: string | null; reason?: string }) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        try {
          const child = spawn(resolved.command, [...resolved.prefix, "--version"], {
            env: { ...process.env, HOME: process.env.HOME || homedir(), ...environment },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => { stdout += chunk; });
          child.stderr.on("data", (chunk) => { stderr += chunk; });
          child.on("error", (error) => done({ version: null, reason: error.message }));
          child.on("close", (code) => {
            const output = (stdout || stderr).trim();
            done(code === 0 ? { version: output || "installed" } : { version: null, reason: output || `exit ${code}` });
          });
          setTimeout(() => {
            if (settled) return;
            try { child.kill("SIGTERM"); } catch {}
            done({ version: null, reason: "version check timed out" });
          }, 8000).unref();
        } catch (error) {
          done({ version: null, reason: error instanceof Error ? error.message : String(error) });
        }
      });
      const editorSurface = detectedEditorSurface(config.preset);
      return probe.version
        ? { state: "available", version: probe.version }
        : {
            state: "unavailable",
            reason: editorSurface
              ? `${editorSurface} detected, but its separate headless CLI \`${config.cli}\` is not installed`
              : `\`${config.cli}\` CLI not found or blocked${probe.reason ? ` (${probe.reason})` : ""}`,
          };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName ?? preset.label,
      enabled: input.enabled,
      models: preset.models,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async () => { throw new Error(`${preset.label} has no pending request broker`); },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => { for (const turn of active.values()) turn.stop(); },
        onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
      dispose: async () => {
        for (const turn of active.values()) turn.stop();
        listeners.clear();
      },
    };
  },
};
