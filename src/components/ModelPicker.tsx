import { useEffect, useRef, useState } from "react";
import {
  BrainCircuit,
  Check,
  ChevronDown,
  Code2,
  Crown,
  Palette,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useStore, type Bot, type InstanceInfo, type SmartRole } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { cn } from "@/lib/cn";

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

function roleIcon(role: SmartRole, size = 15) {
  switch (role) {
    case "developer":
      return <Code2 size={size} />;
    case "supervisor":
      return <ShieldCheck size={size} />;
    case "leader":
      return <Crown size={size} />;
    case "creative":
      return <Palette size={size} />;
    default:
      return <BrainCircuit size={size} />;
  }
}

export function ModelPicker({ bot, className }: { bot: Bot; className?: string }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"smart" | "manual">(bot.routingMode === "manual" ? "manual" : "smart");
  const [railId, setRailId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const selection = bot.modelSelection;
  const active = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const routeInstance = state.instances.find((instance) => instance.instanceId === bot.lastRoute?.instanceId);
  const selectedRole = bot.smartRole ?? "balanced";
  const activeProfile = state.smartProfiles.find((profile) => profile.id === selectedRole);
  const railInstance =
    state.instances.find((instance) => instance.instanceId === (railId ?? selection.instanceId)) ?? state.instances[0];
  const isSmart = bot.routingMode !== "manual";

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pickModel = (instance: InstanceInfo, model: string) => {
    dispatch({ type: "setModel", botId: bot.id, selection: { instanceId: instance.instanceId, model } });
    setOpen(false);
  };

  const pickRole = (role: SmartRole) => {
    dispatch({ type: "setSmartRole", botId: bot.id, role });
    setOpen(false);
  };

  const buttonTitle = isSmart
    ? `${activeProfile?.label ?? "Smart routing"}${bot.lastRoute ? ` · last route: ${routeInstance?.displayName ?? bot.lastRoute.instanceId} / ${bot.lastRoute.model}` : ""}`
    : `${active?.displayName ?? selection.instanceId} · ${modelLabel(active, selection.model)}`;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setRailId(selection.instanceId);
          setMode(isSmart ? "smart" : "manual");
          setOpen((value) => !value);
        }}
        className={cn(
          "group flex min-w-0 items-center gap-2 rounded-full border py-1 pl-2 pr-2.5 text-[13px] transition",
          isSmart
            ? "border-violet-400/25 bg-violet-400/[0.08] text-ink hover:bg-violet-400/[0.13]"
            : "border-hairline/40 bg-raised/60 text-ink hover:bg-raised",
        )}
        title={buttonTitle}
      >
        <span className={cn("flex size-5 items-center justify-center rounded-full", isSmart && "bg-violet-400/15 text-violet-300")}>
          {isSmart ? <Sparkles size={13} /> : active ? <ProviderMark driverKind={active.driverKind} instanceId={active.instanceId} size={14} /> : null}
        </span>
        <span className="max-w-[180px] truncate font-medium">
          {isSmart ? activeProfile?.label ?? "Smart · Balanced" : modelLabel(active, selection.model)}
        </span>
        <ChevronDown size={13} className="text-ink-secondary transition group-aria-expanded:rotate-180" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Model routing"
          data-model-picker-content
          className="absolute right-0 top-full z-30 mt-2 w-[min(440px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-2xl shadow-black/60"
        >
          <div className="border-b border-hairline/40 bg-panel/70 p-2">
            <div className="grid grid-cols-2 rounded-xl bg-inset/70 p-1">
              <button
                type="button"
                onClick={() => setMode("smart")}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition",
                  mode === "smart" ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                )}
              >
                <Sparkles size={14} /> Smart
              </button>
              <button
                type="button"
                onClick={() => setMode("manual")}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition",
                  mode === "manual" ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                )}
              >
                <ProviderMark driverKind={active?.driverKind ?? "custom"} instanceId={active?.instanceId} size={13} /> Manual
              </button>
            </div>
          </div>

          {mode === "smart" ? (
            <div className="max-h-[min(560px,70vh)] overflow-y-auto p-3">
              <div className="mb-3 px-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-violet-400/15 text-violet-300">
                    <Sparkles size={15} />
                  </span>
                  Automatic routing
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-secondary">
                  Pick the job. OpenGrok chooses the best available model and moves through the fallback chain if it fails.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {state.smartProfiles.map((profile) => {
                  const selected = isSmart && selectedRole === profile.id;
                  const ready = profile.candidates.filter((candidate) => candidate.available).length;
                  return (
                    <button
                      type="button"
                      key={profile.id}
                      onClick={() => pickRole(profile.id)}
                      className={cn(
                        "relative min-h-[92px] rounded-xl border p-3 text-left transition",
                        selected
                          ? "border-violet-400/45 bg-violet-400/[0.09] shadow-[0_0_0_1px_rgba(167,139,250,.08)]"
                          : "border-hairline/40 bg-panel/50 hover:border-hairline hover:bg-raised/60",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn("flex size-7 items-center justify-center rounded-lg", selected ? "bg-violet-400/20 text-violet-300" : "bg-inset text-ink-secondary")}>
                          {roleIcon(profile.id)}
                        </span>
                        {selected ? (
                          <Check size={15} className="text-violet-300" />
                        ) : (
                          <span className={cn("text-[10px] font-medium", ready ? "text-emerald-400" : "text-amber-400")}>
                            {ready}/{profile.candidates.length} ready
                          </span>
                        )}
                      </div>
                      <div className="mt-2 text-[13px] font-semibold text-ink">{profile.label}</div>
                      <div className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-ink-secondary">{profile.description}</div>
                    </button>
                  );
                })}
              </div>

              {activeProfile && (
                <div className="mt-3 rounded-xl border border-hairline/40 bg-inset/45 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">Fallback chain</span>
                    <span className="rounded-full bg-raised px-2 py-0.5 text-[10px] text-ink-secondary">automatic</span>
                  </div>
                  <div className="space-y-1.5">
                    {activeProfile.candidates.map((candidate, index) => (
                      <div key={`${candidate.instanceId}:${candidate.model}`} className="flex min-w-0 items-center gap-2 text-[11px]">
                        <span className="w-4 text-right font-mono text-ink-tertiary">{index + 1}</span>
                        <span className={cn("size-1.5 shrink-0 rounded-full", candidate.available ? "bg-emerald-400" : "bg-ink-tertiary/40")} />
                        <span className={cn("min-w-0 flex-1 truncate", candidate.available ? "text-ink" : "text-ink-secondary/55")}>{candidate.label}</span>
                        {candidate.reasoningEffort && (
                          <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 font-mono text-[9px] text-ink-secondary">{candidate.reasoningEffort}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex max-h-[min(500px,65vh)] min-h-[280px]">
              <div className="flex w-14 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/40 bg-panel p-2">
                {state.instances.map((instance) => {
                  const unavailable = instance.snapshot.state !== "available";
                  const onRail = instance.instanceId === railInstance?.instanceId;
                  return (
                    <button
                      type="button"
                      key={instance.instanceId}
                      onClick={() => setRailId(instance.instanceId)}
                      title={unavailable ? `${instance.displayName} — ${instance.snapshot.reason ?? "unavailable"}` : instance.displayName}
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-lg transition",
                        onRail ? "bg-raised ring-1 ring-hairline/60" : "hover:bg-raised/60",
                        unavailable && "opacity-35",
                      )}
                    >
                      <ProviderMark driverKind={instance.driverKind} instanceId={instance.instanceId} size={18} />
                    </button>
                  );
                })}
              </div>

              <div className="min-w-0 flex-1 overflow-y-auto p-3">
                {railInstance ? (
                  <>
                    <div className="mb-2 px-2 pt-1">
                      <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                        <ProviderMark driverKind={railInstance.driverKind} instanceId={railInstance.instanceId} size={15} />
                        {railInstance.displayName}
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-ink-secondary">
                        {railInstance.snapshot.state === "available"
                          ? railInstance.snapshot.version ?? "ready"
                          : railInstance.snapshot.reason ?? "unavailable"}
                      </div>
                    </div>
                    {railInstance.models.options.map((option) => {
                      const current = !isSmart && selection.instanceId === railInstance.instanceId && selection.model === option.id;
                      const disabled = railInstance.snapshot.state !== "available";
                      return (
                        <button
                          type="button"
                          key={option.id}
                          disabled={disabled}
                          onClick={() => pickModel(railInstance, option.id)}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-[12px] transition",
                            disabled ? "cursor-not-allowed text-ink-secondary/45" : "text-ink hover:bg-raised/60",
                            current && "bg-raised",
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{option.label}</span>
                            {option.id === railInstance.models.default && (
                              <span className="shrink-0 rounded bg-inset px-1 py-px text-[9px] text-ink-secondary">default</span>
                            )}
                          </span>
                          {current && <Check size={14} className="shrink-0 text-accent" />}
                        </button>
                      );
                    })}
                  </>
                ) : (
                  <div className="px-2 py-3 text-[13px] text-ink-secondary">No providers — is the server running?</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
