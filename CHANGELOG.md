# Changelog

All notable changes to the ZCode VSCode extension are documented here.

## [0.2.0] - 2026-07-10

### Added

- GFM-style Markdown tables render inside a horizontally scrollable container,
  matching the table usability introduced by ZCode desktop 3.3.4.
- A DOM-free webview Markdown smoke test now covers table rendering, escaping,
  inline formatting, and non-table pipe text in CI.
- Background task lifecycle events are decoded and, when emitted by app-server,
  shown as concise system notices without repeating the full shell command.

### Compatibility

- Verified the extension end to end against ZCode desktop 3.3.4 and CLI kernel
  0.15.2: app-server connect, state controls, streaming send, and turn completion.
- Verified ZCode 3.3.4 background Bash tasks stay compatible with the existing
  tool-chip pipeline: the background launch and result-read events both render
  through the standard tool start/finish protocol.
- Defensively decode the kernel's `background_task_started` / `_updated` /
  `_completed` events (taskId, command, status, pid) into a session notice so
  they are never silently dropped. The tested 0.15.2 app-server exposed the
  background Bash flow through standard Bash/Read tool events and did not emit
  separate lifecycle messages in that run.
- Corrected the README architecture note: ZCode desktop is a custom Electron app;
  this extension targets VSCode and compatible editors while reusing its kernel.

## [0.1.0] - 2026-07-10

Initial release. A VSCode frontend for the ZCode CLI kernel, the desktop
counterpart to the terminal `zcode-tui`. Both drive the same kernel
`app-server` stdio protocol.

### Added

- **Streaming chat** in an activity-bar side panel: token-by-token answers,
  reasoning fold, and syntax-highlighted code panels.
- **Tool chips** — running/finished tool calls with folded output.
- **Kernel session controls**: switch model (`session/setModel`), switch mode
  (`session/setMode`), cycle thought level (`session/setThoughtLevel`), and
  compact context (`session/compact`).
- **Approvals**: plan approval (`interaction/requestUserInput`) and build-mode
  tool permission (`interaction/requestPermission`), answered in-panel.
- **Mid-turn steer** — typing while a turn streams injects into the running
  turn (`session/steer`) instead of queueing.
- **Checkpoint rewind** (`session/rewind` → `session/applyFileRewind`) with a
  safe file-restore preview.
- **Session resume** with `runtimeModel` reconstruction so the first send on a
  resumed session does not fail `ZCODE_RUNTIME_MODEL_UNAVAILABLE`.
- **Context watermark** and model·mode footer.
- `@file` attachments for the current message.
