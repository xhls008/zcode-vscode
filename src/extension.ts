import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("zcode.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("zcode.cancel", () => provider.cancel()),
    vscode.commands.registerCommand("zcode.pickModel", () => provider.pickModel()),
    vscode.commands.registerCommand("zcode.pickMode", () => provider.pickMode()),
    vscode.commands.registerCommand("zcode.pickThought", () => provider.pickThought()),
    vscode.commands.registerCommand("zcode.compact", () => provider.compact()),
    vscode.commands.registerCommand("zcode.rewind", () => provider.rewind()),
    vscode.commands.registerCommand("zcode.resumeSession", () => provider.resumeSession()),
    vscode.commands.registerCommand("zcode.focusInput", () => provider.focusInput()),
  );
}

export function deactivate(): void {
  // Controllers dispose via the webview's onDidDispose.
}
