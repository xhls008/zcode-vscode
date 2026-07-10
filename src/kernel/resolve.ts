// Locate the ZCode desktop package and decide how to run its CLI kernel.
// Ported from the zcode-tui install.sh wrapper: the kernel needs Node ≥ 22.5
// (for node:sqlite), so we prefer ZCode's embedded Electron-as-Node and only
// fall back to a system node that is new enough.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

export interface ResolveOptions {
  /** zcode.appDir setting; empty/undefined → auto-detect. */
  appDirOverride?: string;
  /** zcode.forceSystemNode setting. */
  forceSystemNode?: boolean;
}

export interface KernelLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  appDir: string;
  runtime: "electron" | "node";
}

export class KernelNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelNotFoundError";
  }
}

function hasKernel(dir: string): boolean {
  return dir !== "" && fs.existsSync(path.join(dir, "resources", "glm", "zcode.cjs"));
}

/**
 * Resolve the ZCode app dir, mirroring the wrapper's probe order:
 * override, then $ZCODE_APP, then /opt/ZCode, then the newest
 * `~/.local/opt/zcode/<version>/opt/ZCode`.
 */
export function findAppDir(override?: string): string | undefined {
  if (override && hasKernel(override)) {
    return override;
  }
  const env = process.env.ZCODE_APP;
  if (env && hasKernel(env)) {
    return env;
  }
  if (hasKernel("/opt/ZCode")) {
    return "/opt/ZCode";
  }
  const base = path.join(os.homedir(), ".local", "opt", "zcode");
  let latest: string | undefined;
  try {
    for (const entry of fs.readdirSync(base).sort()) {
      const dir = path.join(base, entry, "opt", "ZCode");
      if (hasKernel(dir)) {
        latest = dir; // sorted ascending → last wins ("latest" version)
      }
    }
  } catch {
    // no ~/.local/opt/zcode — fine
  }
  return latest;
}

function electronUsable(electronBin: string): boolean {
  if (!fs.existsSync(electronBin)) {
    return false;
  }
  try {
    execFileSync(electronBin, ["-e", ""], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore",
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}

function systemNodeRecent(): boolean {
  try {
    execFileSync(
      "node",
      ["-e", 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'],
      { stdio: "ignore", timeout: 8000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Build the spawn descriptor for `zcode app-server`, or throw a clear error. */
export function resolveKernel(opts: ResolveOptions): KernelLaunch {
  const appDir = findAppDir(opts.appDirOverride);
  if (!appDir) {
    throw new KernelNotFoundError(
      "ZCode CLI kernel not found. Checked the zcode.appDir setting, $ZCODE_APP, " +
        "/opt/ZCode and ~/.local/opt/zcode/*/opt/ZCode. Install the ZCode desktop " +
        "package or set the zcode.appDir setting.",
    );
  }
  const zcodeCjs = path.join(appDir, "resources", "glm", "zcode.cjs");
  const electronBin = path.join(appDir, "zcode");

  if (!opts.forceSystemNode && electronUsable(electronBin)) {
    return {
      command: electronBin,
      args: [zcodeCjs, "app-server"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      appDir,
      runtime: "electron",
    };
  }
  if (systemNodeRecent()) {
    return {
      command: "node",
      args: [zcodeCjs, "app-server"],
      env: { ...process.env },
      appDir,
      runtime: "node",
    };
  }
  throw new KernelNotFoundError(
    "No usable Node runtime for the ZCode kernel. ZCode's embedded Electron could " +
      "not start and the system node is older than 22.5 (needed for node:sqlite). " +
      "Install Node ≥ 22.5 or enable ZCode's Electron.",
  );
}
