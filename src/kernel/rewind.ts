// Checkpoint capture and the two-leg rewind flow. Port of lib.rs. Checkpoints
// are pre-tool-execution snapshots. session/rewind FORCE-applies file restores
// and COERCES checkpoint targets to a workspace rewind, so file restores go
// through session/applyFileRewind instead, and success is judged on the
// rewind.triggered event's strategy — NEVER the envelope (a bad rewind still
// returns a success envelope).

import { AppServerEvent, Json } from "./protocol";

export interface CheckpointEntry {
  id: string;
  /** fileCount — files captured by the snapshot. */
  files: number;
  /** targetMessageId — the turn's user message (message-kind conversation leg). */
  messageId?: string;
}

/** Capture a checkpoint.created event as a rewind target, or undefined. */
export function checkpointFromEvent(event: AppServerEvent): CheckpointEntry | undefined {
  if (event.kind !== "checkpoint.created" || event.checkpointId === undefined) {
    return undefined;
  }
  return {
    id: event.checkpointId,
    files: event.fileCount ?? 0,
    messageId: event.targetMessageId,
  };
}

/** "checkpoint_90c0d5df-…" → "90c0d5df". */
export function checkpointShortId(id: string): string {
  return id.replace(/^checkpoint_/, "").slice(0, 8);
}

export type RewindTarget =
  | { kind: "latestCheckpoint" }
  | { kind: "checkpoint"; checkpointId: string }
  | { kind: "message"; messageId: string }
  | { kind: "turn"; turnIndex: number };

export function rewindTargetJson(target: RewindTarget): Json {
  switch (target.kind) {
    case "latestCheckpoint":
      return { kind: "latestCheckpoint" };
    case "checkpoint":
      return { kind: "checkpoint", checkpointId: target.checkpointId };
    case "message":
      return { kind: "message", messageId: target.messageId };
    case "turn":
      return { kind: "turn", turnIndex: target.turnIndex };
  }
}

export function rewindTargetLabel(target: RewindTarget): string {
  switch (target.kind) {
    case "latestCheckpoint":
      return "latest checkpoint";
    case "checkpoint":
      return `checkpoint ${checkpointShortId(target.checkpointId)}`;
    case "message":
      return `message ${target.messageId.slice(0, 16)}`;
    case "turn":
      return `turn ${target.turnIndex}`;
  }
}

/**
 * Translate a picker target into the conversation-scope leg's message target.
 * session/rewind honors scope:"conversation" only for message-kind targets;
 * checkpoint kinds get coerced to a forced file rewind. Returns undefined when
 * the checkpoint has no captured messageId.
 */
export function conversationTarget(
  picker: RewindTarget,
  checkpoints: CheckpointEntry[],
): RewindTarget | undefined {
  let entry: CheckpointEntry | undefined;
  switch (picker.kind) {
    case "checkpoint":
      entry = checkpoints.find((c) => c.id === picker.checkpointId);
      break;
    case "latestCheckpoint":
      entry = checkpoints[checkpoints.length - 1];
      break;
    case "message":
    case "turn":
      return picker;
  }
  if (!entry || entry.messageId === undefined) {
    return undefined;
  }
  return { kind: "message", messageId: entry.messageId };
}

export function rewindParams(sessionId: string, target: RewindTarget, scope: string): Json {
  return { sessionId, target: rewindTargetJson(target), scope };
}

export function fileRewindParams(sessionId: string, target: RewindTarget): Json {
  return { sessionId, target: rewindTargetJson(target) };
}

export interface RewindFile {
  path: string;
  /** safeFiles: action ("restore"); unsafeFiles: reason ("external_modified"). */
  note: string;
  /** Joined toolNames. */
  tools: string;
}

function rewindFiles(result: Json, key: string, noteKey: string): RewindFile[] {
  const files = result?.[key];
  if (!Array.isArray(files)) {
    return [];
  }
  const out: RewindFile[] = [];
  for (const file of files) {
    const path = file?.path;
    if (typeof path !== "string") {
      continue;
    }
    const tools = Array.isArray(file?.toolNames)
      ? file.toolNames.filter((n: Json) => typeof n === "string").join(", ")
      : "";
    out.push({ path, note: typeof file?.[noteKey] === "string" ? file[noteKey] : "", tools });
  }
  return out;
}

export interface RewindPreview {
  canApply: boolean;
  safe: RewindFile[];
  unsafeFiles: RewindFile[];
  ignored: number;
}

/** Parse a previewFileRewind result. Missing canApply → undefined. */
export function parseRewindPreview(result: Json): RewindPreview | undefined {
  if (typeof result?.canApply !== "boolean") {
    return undefined;
  }
  return {
    canApply: result.canApply,
    safe: rewindFiles(result, "safeFiles", "action"),
    unsafeFiles: rewindFiles(result, "unsafeFiles", "reason"),
    ignored: Array.isArray(result?.ignoredFiles) ? result.ignoredFiles.length : 0,
  };
}

export interface FileRewindOutcome {
  applied: boolean;
  response: string;
  unsafeFiles: RewindFile[];
}

export function parseApplyFileRewind(result: Json): FileRewindOutcome {
  return {
    applied: typeof result?.applied === "boolean" ? result.applied : false,
    response: typeof result?.response === "string" ? result.response : "",
    unsafeFiles: result?.preview ? rewindFiles(result.preview, "unsafeFiles", "reason") : [],
  };
}

/**
 * Judge a session/rewind outcome from its rewind.triggered event. Returns the
 * failure text, or undefined on success. NEVER trust the envelope.
 */
export function rewindFailure(strategy: string | undefined, reason: string | undefined, response: string): string | undefined {
  if (strategy === "unavailable") {
    return response !== "" ? response : `rewind unavailable: ${reason ?? "unknown reason"}`;
  }
  if (strategy !== undefined) {
    return undefined;
  }
  return `no rewind.triggered event observed (kernel said: ${response !== "" ? response : "nothing"})`;
}
