// Server→client interaction requests: the kernel asking *us* to approve a plan
// (interaction/requestUserInput) or a side-effecting tool (interaction/
// requestPermission). Port of lib.rs. The kernel re-sends the same requestId
// under fresh envelope ids with backoff until answered, so consumers dedupe on
// requestId, and the reply must echo the envelope id verbatim.

import {
  INTERACTION_METHOD,
  PERMISSION_METHOD,
  Json,
} from "./protocol";

export type InteractionReplyKind = "answers" | "permission";

export interface InteractionOption {
  label: string;
  /** Answer value (requestUserInput) or optionId (requestPermission). */
  value: string;
  description: string;
  /** requestPermission only: the pre-baked reply `result` for this option. */
  response?: Json;
}

export interface InteractionQuestion {
  /** Doubles as the answer key in the reply: answers[header] = option.value. */
  header: string;
  question: string;
  options: InteractionOption[];
}

export interface InteractionRequest {
  requestId: string;
  prompt: string;
  /** schema.interaction (e.g. "plan_approval"), or "permission". */
  interaction: string;
  toolName: string;
  /** input.plan — the plan text under review (plan_approval). */
  plan?: string;
  questions: InteractionQuestion[];
  reply: InteractionReplyKind;
  /** Index of a protocol-level decline option (permission kind:"deny"). */
  denyIndex?: number;
}

function strAt(value: Json, key: string): string {
  const v = value?.[key];
  return typeof v === "string" ? v : "";
}

export function parseInteractionRequest(method: string, params: Json): InteractionRequest | undefined {
  if (method === INTERACTION_METHOD) {
    return parseUserInputRequest(params);
  }
  if (method === PERMISSION_METHOD) {
    return parsePermissionRequest(params);
  }
  return undefined;
}

function parseUserInputRequest(params: Json): InteractionRequest | undefined {
  const requestId = typeof params?.requestId === "string" ? params.requestId : undefined;
  if (requestId === undefined || !Array.isArray(params?.questions)) {
    return undefined;
  }
  const questions: InteractionQuestion[] = [];
  for (const q of params.questions) {
    if (!Array.isArray(q?.options)) {
      continue;
    }
    const options: InteractionOption[] = [];
    for (const o of q.options) {
      const value = typeof o?.value === "string" ? o.value : undefined;
      if (value === undefined) {
        continue;
      }
      const label = strAt(o, "label") || value;
      options.push({ label, value, description: strAt(o, "description") });
    }
    if (options.length === 0) {
      continue;
    }
    questions.push({
      header: strAt(q, "header"),
      question: strAt(q, "question"),
      options,
    });
  }
  if (questions.length === 0) {
    return undefined;
  }
  const plan = params?.input?.plan;
  return {
    requestId,
    prompt: strAt(params, "prompt"),
    interaction: typeof params?.schema?.interaction === "string" ? params.schema.interaction : "",
    toolName: strAt(params, "toolName"),
    plan: typeof plan === "string" ? plan : undefined,
    questions,
    reply: "answers",
  };
}

function parsePermissionRequest(params: Json): InteractionRequest | undefined {
  const requestId = typeof params?.requestId === "string" ? params.requestId : undefined;
  if (requestId === undefined || !Array.isArray(params?.options)) {
    return undefined;
  }
  const toolName = strAt(params, "toolName");
  const options: InteractionOption[] = [];
  for (const o of params.options) {
    const optionId = typeof o?.optionId === "string" ? o.optionId : undefined;
    const response = o?.response;
    if (optionId === undefined || response === undefined) {
      continue;
    }
    const label = strAt(o, "name") || optionId;
    options.push({ label, value: optionId, description: strAt(o, "description"), response });
  }
  if (options.length === 0) {
    return undefined;
  }
  let denyIndex: number | undefined;
  params.options.forEach((o: Json, i: number) => {
    if (denyIndex === undefined && o?.kind === "deny") {
      denyIndex = i;
    }
  });
  const summary = params?.input !== undefined ? toolInputSummary(JSON.stringify(params.input)) : "";
  const risk = strAt(params, "riskLevel");
  let question = toolName;
  if (summary) {
    question += `  ${summary}`;
  }
  if (risk) {
    question += `  (risk ${risk})`;
  }
  return {
    requestId,
    prompt: strAt(params, "reason"),
    interaction: "permission",
    toolName,
    questions: [{ header: "", question, options }],
    reply: "permission",
    denyIndex,
  };
}

/**
 * Encode the reply for `selected` (index into the first question's options) as
 * one JSON line; the envelope id is echoed back verbatim. Returns undefined if
 * out of bounds or (permission) the option lacks its reply payload.
 */
export function encodeInteractionReply(
  envelopeId: Json,
  request: InteractionRequest,
  selected: number,
): string | undefined {
  let result: Json;
  if (request.reply === "answers") {
    const answers: Record<string, string> = {};
    request.questions.forEach((question, index) => {
      const pick = index === 0 ? selected : 0;
      const option = question.options[pick];
      if (option === undefined) {
        return;
      }
      answers[question.header] = option.value;
    });
    // Bail if the selection was out of range for the first question.
    const first = request.questions[0];
    if (first && first.options[selected] === undefined) {
      return undefined;
    }
    result = { requestId: request.requestId, answers };
  } else {
    const option = request.questions[0]?.options[selected];
    if (option === undefined || option.response === undefined) {
      return undefined;
    }
    // Strict kernel schema: the option's response object and NOTHING else.
    result = option.response;
  }
  return JSON.stringify({ id: envelopeId, result });
}

/**
 * A compact one-line summary of a tool's JSON input, for the chip header:
 * {"file_path":"/a/b/notes.txt"} → notes.txt.
 */
export function toolInputSummary(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") {
    return "";
  }
  let raw = trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts = Object.values(parsed)
        .filter((v): v is string => typeof v === "string")
        .map((s) => s.split("/").pop() ?? s)
        .filter((s) => s !== "");
      raw = parts.length > 0 ? parts.join(" ") : trimmed;
    }
  } catch {
    // not JSON — keep the trimmed raw text
  }
  const collapsed = raw.split(/\s+/).filter(Boolean).join(" ");
  if ([...collapsed].length > 48) {
    return [...collapsed].slice(0, 47).join("") + "…";
  }
  return collapsed;
}
