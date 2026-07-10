// A long-lived connection to `zcode app-server`: one child process (own process
// group), a stdout line decoder, and a stdin handle for requests. Requests get
// monotonic numeric ids and resolve via a pending map; server→client requests,
// session events, and state updates are emitted for the session controller.
// Port of lib.rs AppServerConn, adapted to Node's event-driven model.

import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import { KernelLaunch } from "./resolve";
import { AppServerMessage, decodeMessage, encodeRequest, Json } from "./protocol";

export type Disposable = { dispose(): void };

interface Pending {
  resolve: (value: Json) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class AppServerError extends Error {}

export class AppServerClient {
  private child?: ChildProcess;
  private stdoutBuf = "";
  private nextId = 1;
  private aliveFlag = false;
  private readonly pending = new Map<number, Pending>();
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly launch: KernelLaunch,
    private readonly cwd: string,
    private readonly log?: (line: string) => void,
  ) {
    this.emitter.setMaxListeners(50);
  }

  get isAlive(): boolean {
    return this.aliveFlag;
  }

  get runtime(): string {
    return this.launch.runtime;
  }

  start(): void {
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.cwd,
      env: this.launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group so cancel() can kill the whole tree
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    // stderr is buffered separately so a kernel warning never lands mid-JSON.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.log?.(`stderr: ${chunk.trimEnd()}`));
    child.on("exit", (code, signal) => this.onExit(code, signal));
    child.on("error", (err) => {
      this.log?.(`spawn error: ${err.message}`);
      this.onExit(-1, null);
    });
    this.child = child;
    this.aliveFlag = true;
    this.log?.(`app-server spawned (${this.launch.runtime})`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line.trim() === "") {
        continue;
      }
      const message = decodeMessage(line);
      if (!message) {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: AppServerMessage): void {
    if (message.type === "response") {
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        if (message.error !== undefined) {
          waiter.reject(new AppServerError(message.error));
        } else {
          waiter.resolve(message.result ?? null);
        }
        return; // responses to our requests are consumed, not emitted
      }
      // Orphan response (already timed out) — drop.
      return;
    }
    this.emitter.emit("message", message);
  }

  private onExit(code: number | null, signal: string | null): void {
    if (!this.aliveFlag) {
      return;
    }
    this.aliveFlag = false;
    for (const [, waiter] of this.pending) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.reject(new AppServerError("app-server connection closed"));
    }
    this.pending.clear();
    this.log?.(`app-server exited (code=${code}, signal=${signal})`);
    this.emitter.emit("exit", code, signal);
  }

  /** Subscribe to inbound events / state updates / server requests. */
  onMessage(handler: (message: AppServerMessage) => void): Disposable {
    this.emitter.on("message", handler);
    return { dispose: () => this.emitter.off("message", handler) };
  }

  onExitOnce(handler: (code: number | null, signal: string | null) => void): Disposable {
    this.emitter.once("exit", handler);
    return { dispose: () => this.emitter.off("exit", handler) };
  }

  private write(line: string): void {
    if (!this.aliveFlag || !this.child?.stdin) {
      throw new AppServerError("app-server connection closed");
    }
    this.child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
  }

  /** Send a request and await its response. timeoutMs=0 waits indefinitely. */
  request(method: string, params: Json, timeoutMs = 0): Promise<Json> {
    const id = this.nextId++;
    this.log?.(`-> #${id} ${method}`); // method + id only; params may carry credentials
    return new Promise<Json>((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AppServerError(`${method} timed out`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      try {
        this.write(encodeRequest(id, method, params));
      } catch (err) {
        this.pending.delete(id);
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        reject(err as Error);
      }
    });
  }

  /** Fire-and-forget request; the response (if any) is ignored/logged. */
  fire(method: string, params: Json): void {
    this.request(method, params).catch((err) => this.log?.(`${method} failed: ${err.message}`));
  }

  /** Write a pre-encoded reply line verbatim (interaction replies echo the
   *  kernel's own string envelope id, so they bypass the numeric id counter). */
  reply(line: string): void {
    this.log?.("-> interaction reply");
    this.write(line);
  }

  /** Kill the kernel process group and reap it. */
  cancel(): void {
    if (!this.child || this.child.pid === undefined) {
      return;
    }
    const pid = this.child.pid;
    try {
      process.kill(-pid, "SIGKILL"); // negative pid → whole process group
    } catch {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    this.aliveFlag = false;
  }

  dispose(): void {
    this.cancel();
    this.emitter.removeAllListeners();
  }
}
