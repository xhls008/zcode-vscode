// SessionController — orchestrates one ZCode kernel session over the app-server
// protocol: handshake (create/resume + subscribe), streaming turns, mid-turn
// steer, session controls, plan/permission interactions, and checkpoint rewind.
// It owns an AppServerClient and emits high-level events the chat view renders.

import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { AppServerClient, AppServerError, Disposable } from "./kernel/client";
import { resolveKernel } from "./kernel/resolve";
import { buildRuntimeModel } from "./kernel/runtimeModel";
import {
  AppServerEvent,
  AppServerMessage,
  Json,
  ModelChoice,
  SessionControls,
  compactParams,
  createParams,
  resumeParams,
  sendParams,
  sessionIdFromResult,
  setModeParams,
  setModelParams,
  setThoughtParams,
  stateControls,
  stateIsTurnEnd,
  stateTurnError,
  stateWatermark,
  steerParams,
  subscribeParams,
  usageParams,
} from "./kernel/protocol";
import { AppServerTurn } from "./kernel/turn";
import {
  InteractionRequest,
  encodeInteractionReply,
  parseInteractionRequest,
} from "./kernel/interactions";
import {
  CheckpointEntry,
  RewindTarget,
  checkpointFromEvent,
  conversationTarget,
  fileRewindParams,
  parseApplyFileRewind,
  parseRewindPreview,
  rewindFailure,
  rewindParams,
  rewindTargetLabel,
} from "./kernel/rewind";
import {
  ReplayMessage,
  SessionRow,
  parseResumeMessages,
  parseSessionList,
  parseSteerResult,
  sessionListParams,
} from "./kernel/sessions";

const HANDSHAKE_TIMEOUT = 30_000;
const CONTROL_TIMEOUT = 30_000;

export interface SessionSnapshot {
  sessionId?: string;
  mode?: string;
  modelId?: string;
  modelLabel?: string;
  models: ModelChoice[];
  thought?: string;
  thoughtLevels: string[];
  contextUsed?: number;
  contextWindow?: number;
}

export interface ToolInfo {
  index: number;
  name: string;
  input: string;
  output: string;
  success: boolean;
  durationMs?: number;
}

export interface TurnEndInfo {
  note?: string;
  error?: string;
}

/** Typed event surface (see emit calls for payload shapes). */
export interface SessionController {
  on(event: "turnStart", listener: () => void): this;
  on(event: "assistantText", listener: (text: string) => void): this;
  on(event: "reasoning", listener: (text: string) => void): this;
  on(event: "toolStart", listener: (tool: ToolInfo) => void): this;
  on(event: "toolFinish", listener: (tool: ToolInfo) => void): this;
  on(event: "turnEnd", listener: (info: TurnEndInfo) => void): this;
  on(event: "state", listener: (snapshot: SessionSnapshot) => void): this;
  on(event: "interaction", listener: (req: InteractionRequest) => void): this;
  on(event: "interactionResolved", listener: (requestId: string) => void): this;
  on(event: "notice", listener: (text: string) => void): this;
  on(event: "error", listener: (text: string) => void): this;
  on(event: "replay", listener: (messages: ReplayMessage[]) => void): this;
  on(event: "closed", listener: () => void): this;
}

export class SessionController extends EventEmitter {
  private client?: AppServerClient;
  private subscription?: Disposable;
  private sessionId?: string;
  private turn?: AppServerTurn;
  private turnActive = false;
  private readonly checkpoints: CheckpointEntry[] = [];
  private readonly snapshot: SessionSnapshot = { models: [], thoughtLevels: [] };
  // Interaction dedupe: the kernel resends the same requestId under fresh
  // envelope ids with backoff until answered.
  private readonly pendingInteractions = new Map<string, { request: InteractionRequest; envelopeId: Json }>();
  private readonly answeredInteractions = new Set<string>();
  // rewind.triggered outcome, captured between the rewind request and its judge.
  private lastRewind?: { strategy?: string; reason?: string };

  constructor(
    private readonly workspacePath: string,
    private readonly options: {
      appDirOverride?: string;
      forceSystemNode?: boolean;
      thoughtDefault?: string;
      log?: (line: string) => void;
    },
  ) {
    super();
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  get isBusy(): boolean {
    return this.turnActive;
  }

  get state(): SessionSnapshot {
    return { ...this.snapshot };
  }

  // ---- lifecycle --------------------------------------------------------

  /** Start the kernel and open a fresh session (or resume `resumeId`). */
  async connect(resumeId?: string): Promise<void> {
    const launch = resolveKernel({
      appDirOverride: this.options.appDirOverride,
      forceSystemNode: this.options.forceSystemNode,
    });
    const client = new AppServerClient(launch, this.workspacePath, this.options.log);
    this.client = client;
    client.start();
    this.subscription = client.onMessage((m) => this.route(m));
    client.onExitOnce(() => {
      this.turnActive = false;
      this.emit("closed");
    });

    if (resumeId) {
      const runtimeModel = this.loadRuntimeModel();
      const result = await client.request("session/resume", resumeParams(resumeId, runtimeModel), HANDSHAKE_TIMEOUT);
      this.sessionId = sessionIdFromResult(result) ?? resumeId;
      await client.request("session/subscribe", subscribeParams(this.sessionId), HANDSHAKE_TIMEOUT);
      const replay = parseResumeMessages(result, 20, 400);
      if (replay.length > 0) {
        this.emit("replay", replay);
      }
    } else {
      const result = await client.request("session/create", createParams(this.workspacePath), HANDSHAKE_TIMEOUT);
      const id = sessionIdFromResult(result);
      if (!id) {
        throw new AppServerError("session/create returned no sessionId");
      }
      this.sessionId = id;
      await client.request("session/subscribe", subscribeParams(id), HANDSHAKE_TIMEOUT);
      if (this.options.thoughtDefault) {
        // Best-effort: only lands if the kernel exposes the control.
        client.fire("session/setThoughtLevel", setThoughtParams(id, this.options.thoughtDefault));
      }
    }
    this.snapshot.sessionId = this.sessionId;
  }

  private loadRuntimeModel(): Json | undefined {
    try {
      const configPath = path.join(os.homedir(), ".zcode", "cli", "config.json");
      const json = fs.readFileSync(configPath, "utf8");
      return buildRuntimeModel(json, Date.now());
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.subscription?.dispose();
    this.client?.dispose();
    this.removeAllListeners();
  }

  /** Best-effort close of the current session (kept for /new semantics). */
  closeSession(): void {
    if (this.client && this.sessionId) {
      this.client.fire("session/close", { sessionId: this.sessionId });
    }
  }

  // ---- sending / steering ----------------------------------------------

  /**
   * Send a prompt. During a live turn this steers the running turn instead of
   * queueing. Returns "sent" | "steered" | "rejected".
   */
  async send(prompt: string, attachments?: Json[]): Promise<"sent" | "steered" | "rejected"> {
    const client = this.requireClient();
    const id = this.requireSession();
    if (this.turnActive) {
      const result = await client.request("session/steer", steerParams(id, prompt), CONTROL_TIMEOUT);
      const outcome = parseSteerResult(result);
      if (outcome.kind === "rejected") {
        this.emit("notice", `steer rejected: ${outcome.reason}`);
        return "rejected";
      }
      return "steered";
    }
    this.startTurn();
    const sendAttachments = attachments && attachments.length > 0 ? attachments : undefined;
    await client.request("session/send", sendParams(id, prompt, sendAttachments), CONTROL_TIMEOUT);
    return "sent";
  }

  private startTurn(): void {
    this.turn = new AppServerTurn();
    this.turnActive = true;
    this.emit("turnStart");
  }

  cancel(): void {
    // Kill the kernel process group (mirrors the TUI's hard cancel); the caller
    // reconnects for the next turn.
    if (this.turnActive) {
      this.turnActive = false;
      this.emit("turnEnd", { note: "cancelled" });
    }
    this.client?.cancel();
  }

  // ---- controls ---------------------------------------------------------

  setMode(mode: string): void {
    const client = this.client;
    const id = this.sessionId;
    if (client && id) {
      client.fire("session/setMode", setModeParams(id, mode));
      this.emit("notice", `mode → ${mode}`);
    }
  }

  setModel(model: ModelChoice): void {
    const client = this.client;
    const id = this.sessionId;
    if (client && id) {
      client.fire("session/setModel", setModelParams(id, model.reference));
      this.emit("notice", `model → ${model.label}`);
    }
  }

  setThought(level: string): void {
    const client = this.client;
    const id = this.sessionId;
    if (client && id) {
      client.fire("session/setThoughtLevel", setThoughtParams(id, level));
      this.emit("notice", `thinking → ${level}`);
    }
  }

  compact(): void {
    const client = this.client;
    const id = this.sessionId;
    if (client && id) {
      client.fire("session/compact", compactParams(id));
      this.emit("notice", "compacting context…");
    }
  }

  async usage(): Promise<Json> {
    const client = this.requireClient();
    const id = this.requireSession();
    return client.request("session/usage", usageParams(id), CONTROL_TIMEOUT);
  }

  // ---- interactions -----------------------------------------------------

  answerInteraction(requestId: string, optionIndex: number): void {
    const entry = this.pendingInteractions.get(requestId);
    if (!entry || !this.client) {
      return;
    }
    const line = encodeInteractionReply(entry.envelopeId, entry.request, optionIndex);
    if (!line) {
      this.emit("error", "could not encode interaction reply");
      return;
    }
    this.client.reply(line);
    this.pendingInteractions.delete(requestId);
    this.answeredInteractions.add(requestId);
    this.emit("interactionResolved", requestId);
  }

  // ---- rewind -----------------------------------------------------------

  get checkpointList(): CheckpointEntry[] {
    return [...this.checkpoints];
  }

  /** Read and clear the last rewind.triggered outcome (fixed return type so the
   *  field's post-await narrowing doesn't collapse the caller to `never`). */
  private consumeRewindOutcome(): { strategy?: string; reason?: string } {
    const rw = this.lastRewind;
    this.lastRewind = undefined;
    return rw ?? {};
  }

  /** Preview which files a rewind to `target` would restore. */
  async previewRewind(target: RewindTarget): Promise<ReturnType<typeof parseRewindPreview>> {
    const client = this.requireClient();
    const id = this.requireSession();
    const result = await client.request("session/previewFileRewind", fileRewindParams(id, target), CONTROL_TIMEOUT);
    return parseRewindPreview(result);
  }

  /**
   * Apply a rewind: the conversation leg (session/rewind, message-scoped, judged
   * on rewind.triggered) then the safe file-restore leg (session/applyFileRewind).
   */
  async applyRewind(target: RewindTarget): Promise<{ ok: boolean; message: string }> {
    const client = this.requireClient();
    const id = this.requireSession();

    // Conversation leg — translate checkpoint picks to a message target so
    // session/rewind does not coerce it into a forced file rewind.
    const convo = conversationTarget(target, this.checkpoints);
    if (convo) {
      this.lastRewind = undefined;
      const result = await client.request("session/rewind", rewindParams(id, convo, "conversation"), CONTROL_TIMEOUT);
      const response = typeof (result as Json)?.response === "string" ? (result as Json).response : "";
      // Give the rewind.triggered event a moment to arrive.
      await delay(150);
      const rw = this.consumeRewindOutcome();
      const failure = rewindFailure(rw.strategy, rw.reason, response);
      if (failure) {
        return { ok: false, message: `rewind to ${rewindTargetLabel(target)} failed: ${failure}` };
      }
    }

    // File leg — safe restore only.
    const applyResult = await client.request("session/applyFileRewind", fileRewindParams(id, target), CONTROL_TIMEOUT);
    const outcome = parseApplyFileRewind(applyResult);
    if (!outcome.applied && outcome.unsafeFiles.length > 0) {
      const files = outcome.unsafeFiles.map((f) => `${f.note} ${f.path}`).join(", ");
      return { ok: true, message: `rewound conversation; files skipped (externally modified): ${files}` };
    }
    return { ok: true, message: `rewound to ${rewindTargetLabel(target)}${outcome.applied ? " (files restored)" : ""}` };
  }

  // ---- sessions ---------------------------------------------------------

  async listSessions(): Promise<SessionRow[]> {
    const client = this.requireClient();
    const result = await client.request("session/list", sessionListParams(), CONTROL_TIMEOUT);
    return parseSessionList(result, this.workspacePath);
  }

  // ---- message routing --------------------------------------------------

  private route(message: AppServerMessage): void {
    switch (message.type) {
      case "event": {
        const event = message.event;
        const checkpoint = checkpointFromEvent(event);
        if (checkpoint) {
          this.checkpoints.push(checkpoint);
        }
        if (event.kind === "rewind.triggered") {
          this.lastRewind = { strategy: event.strategy, reason: event.reason };
        }
        // ZCode 3.3.4 background tasks (subagent/bash backgrounding). These are
        // session-level and may arrive outside a turn, so handle them before the
        // turn guard instead of silently dropping their lifecycle updates.
        if (
          event.kind === "background_task_started" ||
          event.kind === "background_task_updated" ||
          event.kind === "background_task_completed"
        ) {
          this.emit("notice", formatBackgroundTask(event));
          return;
        }
        if (!this.turn || !this.turnActive) {
          return;
        }
        const delta = this.turn.apply(event);
        switch (delta.kind) {
          case "text":
            this.emit("assistantText", this.turn.text);
            break;
          case "reasoning":
            this.emit("reasoning", this.turn.reasoning);
            break;
          case "toolStarted":
            this.emit("toolStart", this.toolInfo(delta.index));
            break;
          case "toolFinished":
            this.emit("toolFinish", this.toolInfo(delta.index));
            break;
          case "done":
            this.finishTurn();
            break;
          default:
            break;
        }
        break;
      }
      case "state": {
        this.mergeControls(stateControls(message.params));
        const watermark = stateWatermark(message.params);
        if (watermark) {
          [this.snapshot.contextUsed, this.snapshot.contextWindow] = watermark;
        }
        this.emit("state", { ...this.snapshot });
        if (this.turnActive) {
          const err = stateTurnError(message.params);
          if (err) {
            this.finishTurn(err);
          } else if (stateIsTurnEnd(message.params)) {
            this.finishTurn();
          }
        }
        break;
      }
      case "serverRequest": {
        const request = parseInteractionRequest(message.method, message.params);
        if (!request) {
          return;
        }
        if (this.answeredInteractions.has(request.requestId)) {
          return; // already handled; ignore the kernel's stragglers
        }
        const existing = this.pendingInteractions.get(request.requestId);
        if (existing) {
          existing.envelopeId = message.id; // refresh the reply target, no re-emit
          return;
        }
        this.pendingInteractions.set(request.requestId, { request, envelopeId: message.id });
        this.emit("interaction", request);
        break;
      }
      default:
        break;
    }
  }

  private toolInfo(index: number): ToolInfo {
    const tool = this.turn!.tools[index];
    return {
      index,
      name: tool.name,
      input: tool.input,
      output: tool.output,
      success: tool.success,
      durationMs: tool.durationMs,
    };
  }

  private finishTurn(error?: string): void {
    if (!this.turnActive) {
      return;
    }
    this.turnActive = false;
    const parts: string[] = [];
    if (this.turn && this.turn.filesChanged > 0) {
      parts.push(`${this.turn.filesChanged} file${this.turn.filesChanged === 1 ? "" : "s"} changed`);
    }
    this.emit("turnEnd", { note: parts.join(", ") || undefined, error });
  }

  private mergeControls(controls?: SessionControls): void {
    if (!controls) {
      return;
    }
    if (controls.mode !== undefined) {
      this.snapshot.mode = controls.mode;
    }
    if (controls.models.length > 0) {
      this.snapshot.models = controls.models;
    }
    if (controls.modelCurrent !== undefined) {
      this.snapshot.modelId = controls.modelCurrent;
      const found = this.snapshot.models.find((m) => refModelId(m.reference) === controls.modelCurrent);
      if (found) {
        this.snapshot.modelLabel = found.label;
      }
    }
    if (controls.thoughtLevels.length > 0) {
      this.snapshot.thoughtLevels = controls.thoughtLevels;
    }
    if (controls.thoughtCurrent !== undefined) {
      this.snapshot.thought = controls.thoughtCurrent;
    }
  }

  private requireClient(): AppServerClient {
    if (!this.client || !this.client.isAlive) {
      throw new AppServerError("no live kernel connection");
    }
    return this.client;
  }

  private requireSession(): string {
    if (!this.sessionId) {
      throw new AppServerError("no active session");
    }
    return this.sessionId;
  }
}

function refModelId(reference: Json): string | undefined {
  return typeof reference?.modelId === "string" ? reference.modelId : undefined;
}

/** One-line summary of a background_task_* event for a system notice. */
export function formatBackgroundTask(event: AppServerEvent): string {
  const verb =
    event.kind === "background_task_started"
      ? "started"
      : event.kind === "background_task_completed"
        ? event.status ?? "completed"
        : "updated";
  const tool = event.toolName || "task";
  let line = `background ${tool} ${verb}`;
  if (event.taskId) {
    const id = event.taskId.length > 20 ? `${event.taskId.slice(0, 17)}…` : event.taskId;
    line += ` · ${id}`;
  }
  if (event.pid !== undefined) {
    line += ` (pid ${event.pid})`;
  }
  return line;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract @file mentions from prompt text and build send attachments. */
export function buildAttachments(prompt: string, cwd: string): Json[] {
  const mentions = extractFileMentions(prompt);
  const attachments: Json[] = [];
  for (const mention of mentions) {
    const resolved = path.resolve(cwd, mention);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    const filename = path.basename(resolved);
    const ext = path.extname(resolved).slice(1).toLowerCase();
    const imageMime = imageMimeFor(ext);
    attachments.push(
      imageMime
        ? { kind: "image", filename, mimeType: imageMime, sizeBytes: stat.size, localPath: resolved }
        : { kind: "file", filename, mimeType: fileMimeFor(ext), sizeBytes: stat.size, localPath: resolved },
    );
  }
  return attachments;
}

function extractFileMentions(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function imageMimeFor(ext: string): string | undefined {
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function fileMimeFor(ext: string): string {
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "json":
      return "application/json";
    case "yaml":
    case "yml":
      return "application/yaml";
    case "toml":
      return "application/toml";
    case "xml":
      return "application/xml";
    case "html":
    case "htm":
      return "text/html";
    case "css":
      return "text/css";
    case "csv":
      return "text/csv";
    case "pdf":
      return "application/pdf";
    case "svg":
      return "image/svg+xml";
    case "js":
    case "mjs":
      return "text/javascript";
    default:
      return "text/plain";
  }
}
