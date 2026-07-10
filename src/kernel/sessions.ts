// session/list, session/resume replay, and session/steer result parsing.
// Ports of lib.rs.

import { Json } from "./protocol";

export interface SessionRow {
  id: string;
  title: string;
  directory: string;
  timeUpdated: number;
}

/**
 * Parse a session/list result into picker rows: current-cwd sessions first,
 * then by recency. Sessions still `running` get a marker suffix.
 */
export function parseSessionList(result: Json, cwd: string): SessionRow[] {
  const sessions = result?.sessions;
  if (!Array.isArray(sessions)) {
    return [];
  }
  const rows: Array<{ current: boolean; row: SessionRow }> = [];
  for (const s of sessions) {
    const id = s?.sessionId;
    if (typeof id !== "string") {
      continue;
    }
    const directory = typeof s?.workspace?.workspacePath === "string" ? s.workspace.workspacePath : "";
    let title = typeof s?.title === "string" ? s.title : "";
    if (title === "") {
      title = directory.split("/").pop() ?? "";
    }
    if (s?.status === "running") {
      title += "  · running";
    }
    const timeUpdated = typeof s?.updatedAt === "number" ? s.updatedAt : 0;
    rows.push({ current: directory === cwd, row: { id, title, directory, timeUpdated } });
  }
  rows.sort((a, b) => {
    if (a.current !== b.current) {
      return a.current ? -1 : 1;
    }
    return b.row.timeUpdated - a.row.timeUpdated;
  });
  return rows.map((r) => r.row);
}

export interface ReplayMessage {
  /** "user" | "assistant". */
  role: string;
  /** Concatenated text parts, truncated to the preview cap. */
  preview: string;
}

/** Extract the LAST up-to-`limit` renderable messages from a resume result. */
export function parseResumeMessages(result: Json, limit: number, cap: number): ReplayMessage[] {
  const messages = result?.messages;
  if (!Array.isArray(messages)) {
    return [];
  }
  const replay: ReplayMessage[] = [];
  for (const message of messages) {
    const role = message?.info?.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    if (!Array.isArray(message?.parts)) {
      continue;
    }
    const text = message.parts
      .filter((p: Json) => p?.type === "text" && typeof p?.text === "string")
      .map((p: Json) => p.text)
      .join("\n");
    const trimmed = text.trim();
    if (trimmed === "") {
      continue;
    }
    const chars = [...trimmed];
    let preview = chars.slice(0, cap).join("");
    if (chars.length > cap) {
      preview += "…";
    }
    replay.push({ role, preview });
  }
  return replay.length > limit ? replay.slice(replay.length - limit) : replay;
}

export type SteerOutcome =
  | { kind: "queued" }
  | { kind: "rejected"; reason: string }
  | { kind: "unknown" };

export function parseSteerResult(result: Json): SteerOutcome {
  switch (result?.kind) {
    case "queued":
      return { kind: "queued" };
    case "rejected":
      return { kind: "rejected", reason: typeof result?.reason === "string" ? result.reason : "rejected" };
    default:
      return { kind: "unknown" };
  }
}

export function sessionListParams(): Json {
  return {};
}
