// Faithful TypeScript port of the ZCode kernel `app-server` protocol, taken
// from the terminal zcode-tui's Rust implementation (src/lib.rs). The wire
// format is newline-delimited JSON with the envelope {id, method, params} —
// NOT JSON-RPC (a `jsonrpc` key is rejected). This module is pure JSON shaping
// and decoding; process spawning lives in client.ts.

export type Json = any;

/** deliveryKind that streams events continuously (vs web-remote-replayable). */
export const APP_SERVER_DELIVERY_KIND = "desktop-continuous";

export const INTERACTION_METHOD = "interaction/requestUserInput";
export const PERMISSION_METHOD = "interaction/requestPermission";

// ---- request encoding + params builders ---------------------------------

/** One request as a compact JSON line (no jsonrpc, no trailing newline). */
export function encodeRequest(id: number, method: string, params: Json): string {
  return JSON.stringify({ id, method, params });
}

export function createParams(workspacePath: string): Json {
  return { workspace: { workspaceKey: workspacePath, workspacePath } };
}

export function subscribeParams(sessionId: string): Json {
  return {
    sessionId,
    deliveryKind: APP_SERVER_DELIVERY_KIND,
    includeSnapshot: false,
  };
}

export function sendParams(sessionId: string, content: string, attachments?: Json[]): Json {
  if (!attachments || attachments.length === 0) {
    return { sessionId, content };
  }
  return { sessionId, content, attachments };
}

export function stopParams(sessionId: string): Json {
  return { sessionId };
}

/** mode ∈ plan|build|edit|yolo|auto (kernel-enforced enum). */
export function setModeParams(sessionId: string, mode: string): Json {
  return { sessionId, mode };
}

/** `model` echoed back verbatim from a state push's `model.available[].ref`. */
export function setModelParams(sessionId: string, modelRef: Json): Json {
  return { sessionId, model: modelRef };
}

/** level per the state push's `thoughtLevel.available[].value` (enabled/disabled). */
export function setThoughtParams(sessionId: string, level: string): Json {
  return { sessionId, thoughtLevel: level };
}

export function compactParams(sessionId: string): Json {
  return { sessionId };
}

/** Inject input into the RUNNING turn (same shape as send). */
export function steerParams(sessionId: string, content: string): Json {
  return { sessionId, content };
}

/**
 * `session/resume` — reopen an existing session. The runtimeModel MUST
 * accompany the resume: resume restores the conversation but NOT the model
 * runtime, and without it the first send fails ZCODE_RUNTIME_MODEL_UNAVAILABLE.
 */
export function resumeParams(sessionId: string, runtimeModel?: Json): Json {
  return runtimeModel ? { sessionId, runtimeModel } : { sessionId };
}

export function usageParams(sessionId: string): Json {
  return { sessionId };
}

/** `usage/stats` — period aggregate; kernel enum pins range to 7d|30d. */
export function usageStatsParams(range: string): Json {
  return { range };
}

export function closeParams(sessionId: string): Json {
  return { sessionId };
}

// ---- inbound message decoding -------------------------------------------

export type AppServerMessage =
  | { type: "response"; id: number; result?: Json; error?: string }
  | { type: "event"; event: AppServerEvent }
  | { type: "state"; params: Json }
  | { type: "serverRequest"; id: Json; method: string; params: Json }
  | { type: "other" };

export interface AppServerEvent {
  kind: string;
  delta: string;
  done: boolean;
  toolName?: string;
  toolCallId?: string;
  /** `result.result.content` — the tool's output text (kind=result). */
  output?: string;
  /** `result.result.success` — tool succeeded (kind=result). */
  success?: boolean;
  /** `result.duration` — tool wall time in ms. */
  durationMs?: number;
  /** `payload.fileCount` — files captured by a checkpoint.created event. */
  fileCount?: number;
  /** `payload.checkpointId` — the rewind target id. */
  checkpointId?: string;
  /** `payload.targetMessageId` (falling back to messageId). */
  targetMessageId?: string;
  /** `payload.strategy` (rewind.triggered) — active_chain | unavailable. */
  strategy?: string;
  /** `payload.reason` (rewind.triggered). */
  reason?: string;
  /** `payload.taskId` — background_task_* events (subagent/bash backgrounding). */
  taskId?: string;
  /** `payload.command` — the backgrounded shell command. */
  command?: string;
  /** `payload.status` — background task status (running|completed|lost…). */
  status?: string;
  /** `payload.pid` — background task process id. */
  pid?: number;
}

function asStr(v: Json): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNum(v: Json): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function asBool(v: Json): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** Decode a single inbound protocol line. Unparseable lines → undefined. */
export function decodeMessage(line: string): AppServerMessage | undefined {
  let value: Json;
  try {
    value = JSON.parse(line.trim());
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  // Server→client request: method AND id together (the kernel expects a reply).
  // Must be checked before the response branch — its envelope id is a string
  // ("server-N"); ignoring it hangs plan-mode turns until the 600s backstop.
  const method = asStr(value.method);
  if (method !== undefined && value.id !== undefined) {
    return {
      type: "serverRequest",
      id: value.id,
      method,
      params: value.params ?? null,
    };
  }

  // Response: numeric id, with result or error.
  if (typeof value.id === "number") {
    const error =
      value.error != null
        ? asStr(value.error.message) ?? "app-server error"
        : undefined;
    return { type: "response", id: value.id, result: value.result, error };
  }

  switch (method) {
    case "session/event": {
      const payload = value.params?.payload;
      if (payload == null || typeof payload !== "object") {
        return undefined;
      }
      // Streaming payloads carry their own `kind`; session-level events
      // (checkpoint.created, turn.*) do NOT — pass params.type through so they
      // are consumable instead of dropped.
      const kind = asStr(payload.kind) ?? asStr(value.params?.type);
      if (kind === undefined) {
        return undefined;
      }
      const result = payload.result;
      return {
        type: "event",
        event: {
          kind,
          delta: asStr(payload.delta) ?? "",
          done: asBool(payload.done) ?? false,
          toolName: asStr(payload.toolName),
          toolCallId: asStr(payload.toolCallId),
          output: asStr(result?.content),
          success: asBool(result?.success),
          durationMs: asNum(payload.duration),
          fileCount: asNum(payload.fileCount),
          checkpointId: asStr(payload.checkpointId),
          targetMessageId: asStr(payload.targetMessageId) ?? asStr(payload.messageId),
          strategy: asStr(payload.strategy),
          reason: asStr(payload.reason),
          taskId: asStr(payload.taskId),
          command: asStr(payload.command),
          status: asStr(payload.status),
          pid: asNum(payload.pid),
        },
      };
    }
    case "state.updated":
      return { type: "state", params: value.params ?? null };
    default:
      return { type: "other" };
  }
}

/** Extract `session.sessionId` from a session/create (or resume) result. */
export function sessionIdFromResult(result: Json): string | undefined {
  return asStr(result?.session?.sessionId);
}

// ---- state.updated interpretation ---------------------------------------

/**
 * Whether a state.updated marks the running turn as finished. The kernel signals
 * completion with reason == "prompt_completed" (there is no `finish` event); a
 * status patch to `completed` is a version-tolerant fallback. idle/ready are
 * deliberately NOT treated as turn-end.
 */
export function stateIsTurnEnd(params: Json): boolean {
  if (asStr(params?.reason) === "prompt_completed") {
    return true;
  }
  return asStr(params?.patch?.status) === "completed";
}

/** Returns the offending word if the turn ended abnormally, else undefined. */
export function stateTurnError(params: Json): string | undefined {
  const bad = ["error", "failed", "aborted", "cancelled", "canceled", "interrupted"];
  const isBad = (s?: string) => s != null && bad.includes(s.toLowerCase());
  for (const candidate of [asStr(params?.reason), asStr(params?.patch?.status), asStr(params?.status)]) {
    if (isBad(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Recursively find a (used, window) context watermark anywhere in the patch. */
export function stateWatermark(params: Json): [number, number] | undefined {
  const usedKeys = ["contextUsed", "used", "tokensUsed", "contextTokens"];
  const windowKeys = ["contextWindow", "window", "total", "maxTokens"];
  function walk(value: Json): [number, number] | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found) {
          return found;
        }
      }
      return undefined;
    }
    if (value != null && typeof value === "object") {
      let used: number | undefined;
      let window: number | undefined;
      for (const k of usedKeys) {
        if (typeof value[k] === "number") {
          used = value[k];
          break;
        }
      }
      for (const k of windowKeys) {
        if (typeof value[k] === "number") {
          window = value[k];
          break;
        }
      }
      if (used !== undefined && window !== undefined && window > 0) {
        return [used, window];
      }
      for (const key of Object.keys(value)) {
        const found = walk(value[key]);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  }
  return walk(params);
}

export interface ModelChoice {
  label: string;
  provider: string;
  /** `available[].ref`, echoed back verbatim in session/setModel. */
  reference: Json;
}

export interface SessionControls {
  mode?: string;
  models: ModelChoice[];
  modelCurrent?: string;
  thoughtLevels: string[];
  thoughtCurrent?: string;
}

/** Control-surface state carried by a state.updated patch; undefined if none. */
export function stateControls(params: Json): SessionControls | undefined {
  const patch = params?.patch;
  if (patch == null || typeof patch !== "object") {
    return undefined;
  }
  const models: ModelChoice[] = Array.isArray(patch.model?.available)
    ? patch.model.available
        .map((m: Json): ModelChoice | undefined => {
          const label = asStr(m?.label);
          const reference = m?.ref;
          if (label === undefined || reference === undefined) {
            return undefined;
          }
          return { label, provider: asStr(m?.providerLabel) ?? "", reference };
        })
        .filter((m: ModelChoice | undefined): m is ModelChoice => m !== undefined)
    : [];
  const thoughtLevels: string[] = Array.isArray(patch.thoughtLevel?.available)
    ? patch.thoughtLevel.available
        .map((l: Json) => asStr(l?.value))
        .filter((v: string | undefined): v is string => v !== undefined)
    : [];
  const controls: SessionControls = {
    mode: asStr(patch.mode?.current),
    models,
    modelCurrent: asStr(patch.model?.current?.modelId),
    thoughtLevels,
    thoughtCurrent: asStr(patch.thoughtLevel?.current),
  };
  const empty =
    controls.mode === undefined &&
    controls.models.length === 0 &&
    controls.modelCurrent === undefined &&
    controls.thoughtLevels.length === 0 &&
    controls.thoughtCurrent === undefined;
  return empty ? undefined : controls;
}

export interface TodoItem {
  text: string;
  done: boolean;
}

/** Parse a todo list from a projection/state value (best-effort, tolerant). */
export function parseTodos(value: Json): TodoItem[] | undefined {
  const list = findTodoArray(value);
  if (!list) {
    return undefined;
  }
  const items: TodoItem[] = [];
  for (const t of list) {
    if (t == null || typeof t !== "object") {
      continue;
    }
    const text = asStr(t.content) ?? asStr(t.text) ?? asStr(t.title);
    if (text === undefined) {
      continue;
    }
    const status = asStr(t.status);
    const done =
      status != null
        ? status.toLowerCase() === "completed" || status.toLowerCase() === "done"
        : asBool(t.completed) ?? false;
    items.push({ text, done });
  }
  return items;
}

function findTodoArray(value: Json): Json[] | undefined {
  if (Array.isArray(value)) {
    if (value.some((t) => t && typeof t === "object" && (t.content || t.text || t.title))) {
      return value;
    }
    for (const item of value) {
      const found = findTodoArray(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (value != null && typeof value === "object") {
    if (Array.isArray(value.todos)) {
      return value.todos;
    }
    for (const key of Object.keys(value)) {
      const found = findTodoArray(value[key]);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}
