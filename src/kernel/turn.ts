// Accumulates a streaming turn from session/event deltas. Body text arrives as
// text_delta (like Anthropic content_block_delta); tool calls arrive as a
// start/input/result sequence correlated by toolCallId. Port of lib.rs
// AppServerTurn + TurnDelta.

import { AppServerEvent } from "./protocol";

export interface AppToolCall {
  callId: string;
  name: string;
  /** Accumulated tool_input_delta JSON (the arguments). */
  input: string;
  /** Tool output text (result.result.content). */
  output: string;
  success: boolean;
  durationMs?: number;
  finished: boolean;
}

export type TurnDelta =
  | { kind: "none" }
  | { kind: "text" }
  | { kind: "reasoning" }
  | { kind: "toolStarted"; index: number }
  | { kind: "toolFinished"; index: number }
  | { kind: "done" };

const NONE: TurnDelta = { kind: "none" };

export class AppServerTurn {
  text = "";
  reasoning = "";
  tools: AppToolCall[] = [];
  done = false;
  /** checkpoint.created events seen this turn (one per gated tool write). */
  checkpoints = 0;
  /** Sum of those events' fileCount — the turn's files-changed total. */
  filesChanged = 0;

  private toolIndex(callId: string): number {
    return this.tools.findIndex((t) => t.callId === callId);
  }

  /** Apply one event, returning what changed so the caller can react. */
  apply(event: AppServerEvent): TurnDelta {
    switch (event.kind) {
      case "text_delta":
        this.text += event.delta;
        return { kind: "text" };
      case "reasoning_delta":
        this.reasoning += event.delta;
        return { kind: "reasoning" };
      // First sighting of a tool (start marker or full call) registers it.
      case "tool_input_start":
      case "tool_call": {
        const callId = event.toolCallId;
        if (callId === undefined) {
          return NONE;
        }
        const idx = this.toolIndex(callId);
        if (idx >= 0) {
          if (event.toolName) {
            this.tools[idx].name = event.toolName;
          }
          return NONE;
        }
        this.tools.push({
          callId,
          name: event.toolName ?? "",
          input: "",
          output: "",
          success: false,
          finished: false,
        });
        return { kind: "toolStarted", index: this.tools.length - 1 };
      }
      case "tool_input_delta": {
        const callId = event.toolCallId;
        if (callId !== undefined) {
          const idx = this.toolIndex(callId);
          if (idx >= 0) {
            this.tools[idx].input += event.delta;
          }
        }
        return NONE;
      }
      case "result": {
        const callId = event.toolCallId;
        if (callId === undefined) {
          return NONE;
        }
        const idx = this.toolIndex(callId);
        if (idx < 0) {
          return NONE;
        }
        const tool = this.tools[idx];
        if (event.output !== undefined) {
          tool.output = event.output;
        }
        tool.success = event.success ?? true;
        tool.durationMs = event.durationMs;
        tool.finished = true;
        return { kind: "toolFinished", index: idx };
      }
      case "finish":
        this.done = true;
        return { kind: "done" };
      case "text_end":
        if (event.done) {
          this.done = true;
          return { kind: "done" };
        }
        return NONE;
      // Session-level checkpoint (params.type passthrough): one per gated tool
      // write; fileCount sums into the turn's change total.
      case "checkpoint.created":
        this.checkpoints += 1;
        this.filesChanged += event.fileCount ?? 0;
        return NONE;
      default:
        return NONE;
    }
  }
}
