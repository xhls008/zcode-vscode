// The chat side panel: a WebviewViewProvider that owns a SessionController,
// bridges host↔webview messages, and drives native VSCode pickers for model /
// mode / thought / rewind / resume.

import * as vscode from "vscode";
import { SessionController, buildAttachments } from "./session";
import { KernelNotFoundError } from "./kernel/resolve";
import { RewindTarget, checkpointShortId } from "./kernel/rewind";

const MODES = ["plan", "build", "edit", "yolo", "auto"];

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "zcode.chatView";

  private view?: vscode.WebviewView;
  private controller?: SessionController;
  private connecting?: Promise<void>;
  private readonly output: vscode.OutputChannel;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("ZCode");
    context.subscriptions.push(this.output);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.onWebviewMessage(msg));
    view.onDidDispose(() => {
      this.controller?.dispose();
      this.controller = undefined;
      this.connecting = undefined;
    });
    // Kick off a connection as soon as the panel opens.
    void this.ensureConnected();
  }

  // ---- connection -------------------------------------------------------

  private workspacePath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private makeController(): SessionController {
    const config = vscode.workspace.getConfiguration("zcode");
    const controller = new SessionController(this.workspacePath(), {
      appDirOverride: config.get<string>("appDir") || undefined,
      forceSystemNode: config.get<boolean>("forceSystemNode") || false,
      thoughtDefault: config.get<string>("thoughtDefault") || undefined,
      log: (line) => this.output.appendLine(line),
    });
    this.wire(controller);
    return controller;
  }

  private ensureConnected(resumeId?: string): Promise<void> {
    if (this.controller && !resumeId) {
      return this.connecting ?? Promise.resolve();
    }
    if (resumeId) {
      this.controller?.dispose();
      this.controller = undefined;
    }
    if (!this.controller) {
      this.controller = this.makeController();
      this.connecting = this.controller
        .connect(resumeId)
        .then(() => {
          this.post({ type: "state", snapshot: this.controller!.state });
          this.post({ type: "notice", text: resumeId ? "session resumed" : "connected to ZCode kernel" });
        })
        .catch((err) => {
          const message = err instanceof KernelNotFoundError ? err.message : `failed to start kernel: ${err.message}`;
          this.post({ type: "error", text: message });
          vscode.window.showErrorMessage(`ZCode: ${message}`);
          this.controller?.dispose();
          this.controller = undefined;
        });
    }
    return this.connecting ?? Promise.resolve();
  }

  private wire(controller: SessionController): void {
    controller.on("turnStart", () => this.post({ type: "turnStart" }));
    controller.on("assistantText", (text) => this.post({ type: "assistantText", text }));
    controller.on("reasoning", (text) => this.post({ type: "reasoning", text }));
    controller.on("toolStart", (tool) => this.post({ type: "toolStart", tool }));
    controller.on("toolFinish", (tool) => this.post({ type: "toolFinish", tool }));
    controller.on("turnEnd", (info) => this.post({ type: "turnEnd", info }));
    controller.on("state", (snapshot) => this.post({ type: "state", snapshot }));
    controller.on("interaction", (request) => this.post({ type: "interaction", request }));
    controller.on("interactionResolved", (requestId) => this.post({ type: "interactionResolved", requestId }));
    controller.on("notice", (text) => this.post({ type: "notice", text }));
    controller.on("error", (text) => this.post({ type: "error", text }));
    controller.on("replay", (messages) => this.post({ type: "replay", messages }));
    controller.on("closed", () => this.post({ type: "notice", text: "kernel connection closed" }));
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  // ---- webview → host ---------------------------------------------------

  private async onWebviewMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case "send":
        await this.handleSend(String(msg.text ?? ""));
        break;
      case "cancel":
        this.controller?.cancel();
        break;
      case "interactionReply":
        this.controller?.answerInteraction(String(msg.requestId), Number(msg.index));
        break;
      case "pickModel":
        await this.pickModel();
        break;
      case "pickMode":
        await this.pickMode();
        break;
      case "pickThought":
        await this.pickThought();
        break;
      case "compact":
        this.controller?.compact();
        break;
      case "newSession":
        await this.newSession();
        break;
      case "resume":
        await this.resumeSession();
        break;
      case "rewind":
        await this.rewind();
        break;
      default:
        break;
    }
  }

  private async handleSend(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    await this.ensureConnected();
    const controller = this.controller;
    if (!controller) {
      return;
    }
    try {
      const attachments = buildAttachments(trimmed, this.workspacePath());
      const outcome = await controller.send(trimmed, attachments);
      if (outcome === "steered") {
        this.post({ type: "notice", text: "steered into the running turn" });
      }
    } catch (err: any) {
      this.post({ type: "error", text: `send failed: ${err.message}` });
    }
  }

  // ---- native pickers ---------------------------------------------------

  async pickModel(): Promise<void> {
    await this.ensureConnected();
    const controller = this.controller;
    if (!controller) {
      return;
    }
    const models = controller.state.models;
    if (models.length === 0) {
      vscode.window.showInformationMessage("ZCode: no models advertised yet — send a message first.");
      return;
    }
    const current = controller.state.modelId;
    const pick = await vscode.window.showQuickPick(
      models.map((m) => ({
        label: m.label,
        description: m.provider,
        detail: refModelId(m.reference) === current ? "current" : undefined,
        model: m,
      })),
      { placeHolder: "Switch model" },
    );
    if (pick) {
      controller.setModel(pick.model);
    }
  }

  async pickMode(): Promise<void> {
    await this.ensureConnected();
    const controller = this.controller;
    if (!controller) {
      return;
    }
    const current = controller.state.mode;
    const pick = await vscode.window.showQuickPick(
      MODES.map((m) => ({ label: m, description: m === current ? "current" : undefined })),
      { placeHolder: "Switch mode" },
    );
    if (pick) {
      controller.setMode(pick.label);
    }
  }

  async pickThought(): Promise<void> {
    await this.ensureConnected();
    const controller = this.controller;
    if (!controller) {
      return;
    }
    const levels = controller.state.thoughtLevels.length > 0 ? controller.state.thoughtLevels : ["enabled", "disabled"];
    const current = controller.state.thought;
    const pick = await vscode.window.showQuickPick(
      levels.map((l) => ({ label: l, description: l === current ? "current" : undefined })),
      { placeHolder: "Thought level" },
    );
    if (pick) {
      controller.setThought(pick.label);
    }
  }

  // ---- commands ---------------------------------------------------------

  async newSession(): Promise<void> {
    this.controller?.closeSession();
    this.controller?.dispose();
    this.controller = undefined;
    this.connecting = undefined;
    this.post({ type: "reset" });
    await this.ensureConnected();
  }

  async resumeSession(): Promise<void> {
    await this.ensureConnected();
    const controller = this.controller;
    if (!controller) {
      return;
    }
    let sessions;
    try {
      sessions = await controller.listSessions();
    } catch (err: any) {
      vscode.window.showErrorMessage(`ZCode: could not list sessions: ${err.message}`);
      return;
    }
    if (sessions.length === 0) {
      vscode.window.showInformationMessage("ZCode: no sessions to resume.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({ label: s.title || s.id.slice(0, 8), description: s.directory, id: s.id })),
      { placeHolder: "Resume a session" },
    );
    if (pick) {
      this.post({ type: "reset" });
      await this.ensureConnected(pick.id);
    }
  }

  async rewind(): Promise<void> {
    await this.ensureConnected();
    const controller = this.controller;
    if (!controller) {
      return;
    }
    const checkpoints = controller.checkpointList;
    const items: Array<vscode.QuickPickItem & { target: RewindTarget }> = [
      { label: "Latest checkpoint", target: { kind: "latestCheckpoint" } },
      ...checkpoints
        .slice()
        .reverse()
        .map((c) => ({
          label: `checkpoint ${checkpointShortId(c.id)}`,
          description: `${c.files} file${c.files === 1 ? "" : "s"}`,
          target: { kind: "checkpoint", checkpointId: c.id } as RewindTarget,
        })),
    ];
    if (checkpoints.length === 0) {
      vscode.window.showInformationMessage("ZCode: no checkpoints captured yet.");
      return;
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Rewind to checkpoint" });
    if (!pick) {
      return;
    }
    try {
      const preview = await controller.previewRewind(pick.target);
      const fileList = preview ? [...preview.safe, ...preview.unsafeFiles].map((f) => f.path).join(", ") : "";
      const confirm = await vscode.window.showWarningMessage(
        `Rewind to ${pick.label}?` + (fileList ? `\nFiles: ${fileList}` : ""),
        { modal: true },
        "Rewind",
      );
      if (confirm !== "Rewind") {
        return;
      }
      const result = await controller.applyRewind(pick.target);
      this.post({ type: result.ok ? "notice" : "error", text: result.message });
    } catch (err: any) {
      this.post({ type: "error", text: `rewind failed: ${err.message}` });
    }
  }

  cancel(): void {
    this.controller?.cancel();
  }

  compact(): void {
    this.controller?.compact();
  }

  focusInput(): void {
    this.post({ type: "focusInput" });
  }

  // ---- html -------------------------------------------------------------

  private html(webview: vscode.Webview): string {
    const nonce = nonce32();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>ZCode</title>
</head>
<body>
  <div id="transcript" aria-live="polite"></div>
  <div id="interaction" class="hidden"></div>
  <footer id="footer">
    <div id="statusbar">
      <button class="chip" id="chip-model" title="Switch model">model</button>
      <button class="chip" id="chip-mode" title="Switch mode">mode</button>
      <button class="chip" id="chip-thought" title="Thought level">think</button>
      <span class="chip flat" id="chip-context"></span>
    </div>
    <div id="composer">
      <textarea id="input" rows="1" placeholder="Message ZCode…  (Enter to send, Shift+Enter for newline)"></textarea>
      <button id="send" title="Send">Send</button>
      <button id="stop" class="hidden" title="Cancel turn">Stop</button>
    </div>
    <div id="toolbar">
      <button class="link" id="btn-new">New</button>
      <button class="link" id="btn-resume">Resume</button>
      <button class="link" id="btn-rewind">Rewind</button>
      <button class="link" id="btn-compact">Compact</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function refModelId(reference: any): string | undefined {
  return typeof reference?.modelId === "string" ? reference.modelId : undefined;
}

function nonce32(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
