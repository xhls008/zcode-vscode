# Changelog

All notable changes to the ZCode VSCode extension are documented here.

## [0.1.0] — Unreleased

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
