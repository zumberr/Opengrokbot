import { track } from "@/lib/analytics";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Mic, Send, Square, Users, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { MausAvatar } from "./Avatar";
import { expressionForBot } from "@/lib/mascot";

const MAX_COLLABORATORS = 7;

export function Composer({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [collaboratorIds, setCollaboratorIds] = useState<string[]>([]);
  const teamRef = useRef<HTMLDivElement>(null);
  const baseText = useRef("");

  const collaborators = useMemo(
    () => state.bots.filter((candidate) => candidate.id !== bot.id && !candidate.hidden),
    [state.bots, bot.id],
  );
  const selectedBots = collaboratorIds
    .map((id) => state.bots.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Bot => Boolean(candidate));
  const collaboration = state.collaborations[bot.id];

  useEffect(() => {
    setCollaboratorIds([]);
    setTeamOpen(false);
  }, [bot.id]);

  useEffect(() => {
    if (!teamOpen) return;
    const close = (event: MouseEvent) => {
      if (!teamRef.current?.contains(event.target as Node)) setTeamOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [teamOpen]);

  const send = () => {
    if (!text.trim() || bot.busy) return;
    dispatch({
      type: "send",
      botId: bot.id,
      text: text.trim(),
      collaboratorIds: collaboratorIds.length ? collaboratorIds : undefined,
    });
    track("message_sent", {
      driver: bot.modelSelection?.instanceId,
      team_size: collaboratorIds.length + 1,
    });
    setText("");
    setCollaboratorIds([]);
    setTeamOpen(false);
  };

  useEffect(() => {
    if (!recording) return;
    const bridge = window.ogb;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text === "string") {
        const base = baseText.current;
        setText(base ? `${base} ${line.text}` : line.text);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      setRecording(false);
      if (code === 1) {
        setSpeechError("Dictation needs Microphone + Speech Recognition access in Windows Privacy settings.");
      }
    });
    void bridge.speechStart();
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording]);

  const toggleMic = () => {
    if (!window.ogb) {
      setSpeechError("Voice input needs the desktop app — run npm run dev:desktop.");
      return;
    }
    baseText.current = text.trim();
    setRecording((value) => !value);
  };

  const toggleCollaborator = (id: string) => {
    setCollaboratorIds((current) =>
      current.includes(id)
        ? current.filter((candidate) => candidate !== id)
        : current.length < MAX_COLLABORATORS
          ? [...current, id]
          : current,
    );
  };

  return (
    <div className="relative z-20 px-5 pb-5 pt-2">
      {speechError && (
        <div className="mx-auto mb-2 max-w-[960px] rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}

      <div className="composer-shell mx-auto max-w-[960px]">
        {(selectedBots.length > 0 || collaboration) && (
          <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-hairline/60 px-4 py-2">
            <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-accent">
              <Users size={13} /> Team run
            </span>
            {selectedBots.map((member) => (
              <button
                key={member.id}
                onClick={() => toggleCollaborator(member.id)}
                className="flex items-center gap-1.5 rounded-full border border-hairline bg-inset/80 py-1 pl-1 pr-2 text-[12px] text-ink hover:border-accent/50"
                title={`Remove ${member.name}`}
              >
                <MausAvatar color={member.color} expression={expressionForBot(member)} size={20} />
                <span className="max-w-28 truncate">{member.name}</span>
                <X size={11} className="text-ink-secondary" />
              </button>
            ))}
            {collaboration && (
              <span className="ml-auto flex items-center gap-2 font-mono text-[11px] text-ink-secondary">
                <span className="status-pulse" />
                {collaboration.total - collaboration.pending}/{collaboration.total} drafts ready
              </span>
            )}
          </div>
        )}

        <div className="flex items-end gap-2 p-2.5">
          <div ref={teamRef} className="relative">
            <button
              onClick={() => setTeamOpen((value) => !value)}
              disabled={bot.busy || collaborators.length === 0}
              className={cn(
                "flex h-10 items-center gap-1.5 rounded-xl border px-3 text-[12px] font-semibold transition",
                collaboratorIds.length
                  ? "border-accent/50 bg-accent/12 text-accent"
                  : "border-hairline bg-inset text-ink-secondary hover:border-ink-secondary/50 hover:text-ink",
                "disabled:cursor-not-allowed disabled:opacity-40",
              )}
              title="Add bots to this task"
            >
              <Users size={16} />
              <span className="hidden sm:inline">Team</span>
              <ChevronDown size={12} />
            </button>

            {teamOpen && (
              <div className="animate-pop-in absolute bottom-[calc(100%+10px)] left-0 w-[300px] overflow-hidden rounded-2xl border border-hairline bg-panel/95 p-2 shadow-2xl shadow-black/70 backdrop-blur-xl">
                <div className="px-2 pb-2 pt-1">
                  <div className="text-[12px] font-bold uppercase tracking-[0.14em] text-ink">Build a bot team</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-ink-secondary">
                    Up to {MAX_COLLABORATORS} peers draft in parallel. {bot.name} delivers the final synthesis.
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {collaborators.map((member) => {
                    const selected = collaboratorIds.includes(member.id);
                    const disabled = member.busy || (!selected && collaboratorIds.length >= MAX_COLLABORATORS);
                    return (
                      <button
                        key={member.id}
                        disabled={disabled}
                        onClick={() => toggleCollaborator(member.id)}
                        className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-raised/70 disabled:opacity-40"
                      >
                        <MausAvatar color={member.color} expression={expressionForBot(member)} size={30} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-ink">{member.name}</span>
                          <span className="block truncate text-[11px] text-ink-secondary">
                            {member.busy ? "Already working" : member.title || "Available collaborator"}
                          </span>
                        </span>
                        <span className={cn("grid size-5 place-items-center rounded-md border", selected ? "border-accent bg-accent text-white" : "border-hairline")}>
                          {selected && <Check size={13} />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <textarea
            value={text}
            rows={1}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
              if (event.key === "Escape" && recording) setRecording(false);
            }}
            placeholder={recording ? "Listening…" : bot.busy ? `${bot.name} is working…` : `Brief ${bot.name}${collaboratorIds.length ? " and the team" : ""}`}
            className="max-h-36 min-h-10 flex-1 resize-none bg-transparent px-2 py-2.5 text-[14px] leading-5 text-ink placeholder:text-ink-secondary/65 focus:outline-none"
          />

          {bot.busy ? (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
              className="grid size-10 shrink-0 place-items-center rounded-xl border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20"
              title="Stop"
            >
              <Square size={14} className="fill-current" />
            </button>
          ) : (
            <>
              <button
                onClick={toggleMic}
                className={cn(
                  "grid size-10 shrink-0 place-items-center rounded-xl text-ink-secondary hover:bg-raised hover:text-ink",
                  recording && "animate-pulse bg-danger/15 text-danger",
                )}
                title={recording ? "Stop dictation (Esc)" : "Dictate"}
              >
                <Mic size={17} />
              </button>
              <button
                onClick={send}
                disabled={!text.trim()}
                className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-[#04110d] shadow-[0_0_24px_rgba(92,246,190,0.2)] transition hover:-translate-y-0.5 hover:bg-accent-border disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-30"
                title={collaboratorIds.length ? "Start team run" : "Send"}
              >
                <Send size={17} />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="mx-auto mt-2 max-w-[960px] text-center font-mono text-[10px] uppercase tracking-[0.12em] text-ink-secondary/50">
        Enter to send · Shift + Enter for a new line · Team runs synthesize peer drafts
      </div>
    </div>
  );
}
