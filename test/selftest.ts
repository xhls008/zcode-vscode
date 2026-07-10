// Self-test for the ported app-server protocol logic. Excluded from the VSIX
// (see .vscodeignore). Run: npm run selftest.
import {
  decodeMessage,
  stateControls,
  stateIsTurnEnd,
  stateTurnError,
  stateWatermark,
  sessionIdFromResult,
} from "../src/kernel/protocol";
import { AppServerTurn } from "../src/kernel/turn";
import {
  parseInteractionRequest,
  encodeInteractionReply,
  toolInputSummary,
} from "../src/kernel/interactions";
import { buildRuntimeModel } from "../src/kernel/runtimeModel";
import { rewindFailure, conversationTarget, checkpointShortId } from "../src/kernel/rewind";
import { parseSessionList, parseResumeMessages, parseSteerResult } from "../src/kernel/sessions";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("FAIL:", name);
  }
}
function eq(name: string, a: unknown, b: unknown): void {
  ok(name + ` (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));
}

// ---- decodeMessage ----
{
  const m = decodeMessage('{"method":"session/event","params":{"payload":{"kind":"text_delta","delta":"hi"}}}');
  ok("decode text_delta event", m?.type === "event" && m.event.kind === "text_delta" && m.event.delta === "hi");

  const r = decodeMessage('{"id":5,"result":{"session":{"sessionId":"s-1"}}}');
  ok("decode numeric response", r?.type === "response" && r.id === 5);
  eq("sessionIdFromResult", sessionIdFromResult((r as any).result), "s-1");

  const e = decodeMessage('{"id":6,"error":{"message":"boom"}}');
  ok("decode error response", e?.type === "response" && e.error === "boom");

  const sr = decodeMessage('{"id":"server-3","method":"interaction/requestPermission","params":{"requestId":"rq"}}');
  ok("decode string-id server request", sr?.type === "serverRequest" && sr.id === "server-3");

  const st = decodeMessage('{"method":"state.updated","params":{"reason":"prompt_completed"}}');
  ok("decode state.updated", st?.type === "state");
  ok("turn end on prompt_completed", stateIsTurnEnd((st as any).params) === true);

  const sess = decodeMessage(
    '{"method":"session/event","params":{"type":"checkpoint.created","payload":{"checkpointId":"checkpoint_abc","fileCount":2,"targetMessageId":"m-1"}}}',
  );
  ok("session-level event via params.type", sess?.type === "event" && sess.event.kind === "checkpoint.created");
  eq("checkpoint fileCount", (sess as any).event.fileCount, 2);
}

// ---- turn accumulation ----
{
  const turn = new AppServerTurn();
  eq("text_delta accumulates", turn.apply({ kind: "text_delta", delta: "Hel", done: false }).kind, "text");
  turn.apply({ kind: "text_delta", delta: "lo", done: false });
  eq("turn text", turn.text, "Hello");
  const started = turn.apply({ kind: "tool_call", delta: "", done: false, toolCallId: "t1", toolName: "Read" });
  ok("tool started at 0", started.kind === "toolStarted" && started.index === 0);
  turn.apply({ kind: "tool_input_delta", delta: '{"file":"a.ts"}', done: false, toolCallId: "t1" });
  const done = turn.apply({ kind: "result", delta: "", done: false, toolCallId: "t1", output: "3 lines", success: true, durationMs: 12 });
  ok("tool finished", done.kind === "toolFinished");
  eq("tool output", turn.tools[0].output, "3 lines");
  eq("finish sets done", turn.apply({ kind: "finish", delta: "", done: false }).kind, "done");
}

// ---- interactions: permission ----
{
  const params = {
    requestId: "rq-1",
    toolName: "Write",
    reason: "Tool has side effects",
    riskLevel: "medium",
    input: { file_path: "/tmp/w.txt", content: "hi" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow", response: { requestId: "rq-1", optionId: "allow" } },
      { optionId: "deny", name: "Deny", kind: "deny", response: { requestId: "rq-1", optionId: "deny" } },
    ],
  };
  const req = parseInteractionRequest("interaction/requestPermission", params);
  ok("permission parsed", !!req && req.reply === "permission" && req.denyIndex === 1);
  eq("permission question has summary", req!.questions[0].question, "Write  w.txt hi  (risk medium)");
  const line = encodeInteractionReply("server-9", req!, 0);
  eq("permission reply echoes response verbatim", JSON.parse(line!).result, { requestId: "rq-1", optionId: "allow" });
  eq("permission reply envelope id", JSON.parse(line!).id, "server-9");
}

// ---- interactions: user input (plan approval) ----
{
  const params = {
    requestId: "rq-2",
    prompt: "Approve the plan?",
    toolName: "ExitPlanMode",
    schema: { interaction: "plan_approval" },
    input: { plan: "1. do a\n2. do b" },
    questions: [
      {
        header: "decision",
        question: "Proceed?",
        options: [
          { label: "Approve", value: "approve", description: "run it" },
          { label: "Keep planning", value: "revise", description: "" },
        ],
      },
    ],
  };
  const req = parseInteractionRequest("interaction/requestUserInput", params);
  ok("user-input parsed", !!req && req.reply === "answers" && req.plan === "1. do a\n2. do b");
  const line = encodeInteractionReply(42, req!, 1);
  eq("answers reply shape", JSON.parse(line!).result, { requestId: "rq-2", answers: { decision: "revise" } });
}

eq("toolInputSummary basenames", toolInputSummary('{"file_path":"/a/b/notes.txt"}'), "notes.txt");

// ---- state controls / watermark ----
{
  const params = {
    reason: "mode_changed",
    patch: {
      mode: { current: "build" },
      model: {
        current: { modelId: "glm-4.6" },
        available: [{ label: "GLM-4.6", providerLabel: "Zhipu", ref: { modelId: "glm-4.6", providerId: "bigmodel" } }],
      },
      thoughtLevel: { current: "enabled", available: [{ value: "enabled" }, { value: "disabled" }] },
    },
  };
  const c = stateControls(params)!;
  ok("controls mode", c.mode === "build");
  ok("controls model", c.models.length === 1 && c.modelCurrent === "glm-4.6");
  ok("controls thought", c.thoughtLevels.length === 2 && c.thoughtCurrent === "enabled");
  eq("watermark walk", stateWatermark({ patch: { deep: { contextUsed: 1200, contextWindow: 128000 } } }), [1200, 128000]);
  ok("turn error detects failed", stateTurnError({ patch: { status: "failed" } }) === "failed");
}

// ---- runtimeModel from real config ----
{
  const config = JSON.stringify({
    model: { main: "bigmodel/glm-4.6" },
    provider: {
      bigmodel: {
        kind: "openai-compatible",
        name: "Zhipu",
        models: { "glm-4.6": { name: "GLM-4.6" }, "glm-4.5": { name: "GLM-4.5" } },
        options: { baseURL: "https://open.bigmodel.cn/api", apiKey: "dummy-api-key-for-test" },
      },
    },
  });
  const rm = buildRuntimeModel(config, 123)!;
  ok("runtimeModel model ref", rm.model.providerId === "bigmodel" && rm.model.modelId === "glm-4.6");
  ok("runtimeModel provider kind", rm.provider.kind === "openai-compatible");
  ok(
    "runtimeModel inline apiKey union",
    rm.provider.apiKey.source === "inline" && rm.provider.apiKey.value === "dummy-api-key-for-test",
  );
  ok("runtimeModel models list", rm.provider.models.length === 2);
  ok("runtimeModel baseURL", rm.provider.baseURL === "https://open.bigmodel.cn/api");
}

// ---- rewind ----
{
  ok("rewind unavailable → failure", rewindFailure("unavailable", "target_not_found", "") !== undefined);
  ok("rewind active_chain → success", rewindFailure("active_chain", undefined, "") === undefined);
  ok("rewind no event → failure", rewindFailure(undefined, undefined, "") !== undefined);
  const checkpoints = [{ id: "checkpoint_abc123ef", files: 1, messageId: "m-7" }];
  const convo = conversationTarget({ kind: "latestCheckpoint" }, checkpoints);
  ok("conversationTarget → message", convo?.kind === "message" && convo.messageId === "m-7");
  eq("checkpointShortId", checkpointShortId("checkpoint_abc123ef00"), "abc123ef");
}

// ---- sessions ----
{
  const list = parseSessionList(
    { sessions: [
      { sessionId: "s1", title: "other", workspace: { workspacePath: "/x" }, updatedAt: 10 },
      { sessionId: "s2", title: "", workspace: { workspacePath: "/cwd" }, updatedAt: 5, status: "running" },
    ] },
    "/cwd",
  );
  ok("session list: cwd first", list[0].id === "s2");
  ok("session list: running marker", list[0].title.includes("running"));
  const replay = parseResumeMessages(
    { messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hello there" }] },
    ] },
    10,
    400,
  );
  ok("resume replay two messages", replay.length === 2 && replay[0].role === "user");
  ok("steer queued", parseSteerResult({ kind: "queued" }).kind === "queued");
  ok("steer rejected reason", parseSteerResult({ kind: "rejected", reason: "no turn" }).kind === "rejected");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
