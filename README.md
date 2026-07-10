# ZCode for VSCode (Unofficial)

A third-party **VSCode frontend for the ZCode CLI kernel** — the desktop
counterpart to the terminal [`zcode-tui`](https://github.com/xhls008/zcode-tui). It does not replace
the kernel; it drives it over the same reverse-engineered `app-server` stdio
protocol, so you get true token streaming, tool approvals, model/mode control,
and checkpoint rewind inside an editor panel.

> **Unofficial project:** this extension is community-built and is not
> affiliated with or endorsed by Zhipu AI or the official ZCode team.
>
> **非官方项目：** 本扩展由社区独立开发，与智谱 AI 及 ZCode 官方团队无隶属、
> 授权或背书关系。

> Note: the ZCode **desktop app** is a custom Electron + React/Tailwind app, not
> a VSCode fork — so this extension does not load inside ZCode itself. It targets
> stock **VSCode** and VSCode-compatible editors (Cursor, Windsurf, …), driving
> the same ZCode CLI kernel the desktop app ships.

## Requirements

- The **ZCode desktop package** installed (provides
  `resources/glm/zcode.cjs`). Auto-detected from `$ZCODE_APP`, `/opt/ZCode`,
  or `~/.local/opt/zcode/*/opt/ZCode`; override with the `zcode.appDir`
  setting.
- You must be **logged in** to ZCode (the kernel reads `~/.zcode/cli/config.json`).
- The kernel needs Node ≥ 22.5; the extension runs it via ZCode's embedded
  Electron-as-Node by default, so a stale system `node` is fine.
- Compatibility is verified against **ZCode desktop 3.3.4 / CLI kernel 0.15.2**.
  The resolver automatically selects the newest locally extracted ZCode package.

## Features

| Capability | Kernel method |
| --- | --- |
| Streaming chat | `session/create` → `session/subscribe` → `session/send` |
| Mid-turn steer | `session/steer` |
| Switch model / mode / thought | `session/setModel` · `session/setMode` · `session/setThoughtLevel` |
| Compact context | `session/compact` |
| Plan approval | `interaction/requestUserInput` |
| Tool permission | `interaction/requestPermission` |
| Background task lifecycle | `background_task_*` events → safe system notices |
| Checkpoint rewind | `session/rewind` → `session/applyFileRewind` |
| Resume session | `session/resume` + reconstructed `runtimeModel` |

Assistant Markdown tables use a horizontally scrollable GFM-style renderer,
matching the table usability added in ZCode desktop 3.3.4.
Background Bash tasks introduced by ZCode 3.3.4 continue to surface through the
existing running/finished tool chips and result output.
The extension also understands `background_task_*` lifecycle events and shows a
safe notice when an app-server version emits them.

## Build

```bash
npm install
npm run compile        # bundle to dist/extension.js
npm run package        # produce a .vsix
```

Press <kbd>F5</kbd> in VSCode to launch an Extension Development Host.

## Install a packaged build

Download the `.vsix` from the latest GitHub Release, then run:

```bash
code --install-extension zcode-vscode-0.2.0.vsix
```

## Layout

```
src/
├── extension.ts        activate / commands / view registration
├── chatView.ts         WebviewViewProvider — HTML + host↔webview bridge
├── session.ts          SessionController — handshake, controls, interactions
└── kernel/
    ├── resolve.ts      locate ZCode app dir + electron/node
    ├── client.ts       AppServerClient — spawn, framing, requests, events
    ├── protocol.ts     params builders + message decode + interaction codec
    ├── runtimeModel.ts build runtimeModel from ~/.zcode/cli/config.json
    └── turn.ts          streaming-turn accumulator
media/
├── main.js             webview frontend
└── main.css            webview styles (theme-aware code panels)
```

## License

MIT
