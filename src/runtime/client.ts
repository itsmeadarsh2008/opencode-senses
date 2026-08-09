import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { statSync } from "node:fs";
import { mkdir as mkdirAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

/** Path to the python interpreter inside a venv, per-platform. */
function venvPython(venv: string): string {
  return process.platform === "win32"
    ? resolvePath(venv, "Scripts", "python.exe")
    : resolvePath(venv, "bin", "python");
}

interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export type SensesMessage = {
  title?: string;
  message: string;
  variant: "info" | "success" | "warning" | "error";
};

/** Debug logging: only shown when SENSES_DEBUG=1. */
function log(...args: unknown[]): void {
  if (process.env.SENSES_DEBUG !== "1") return;
  process.stderr.write(`[senses:py] ${args.map(String).join(" ")}\n`);
}

interface PendingEntry {
  resolve: (v: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A line-delimited JSON-RPC client over the stdin/stdout of the Senses
 * Python runtime.
 *
 * The Python side owns the model lifecycle (lazy load, warm cache, unload).
 * This client owns the process, request/response correlation and reconnect.
 */
export class RuntimeClient {
  readonly ready: Promise<void>;

  private pythonPath: string;
  private readonly timeoutMs: number;
  private child: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private broken = false;
  private readonly uv: string = process.env.SENSES_UV ?? "uv";
  private readonly notify: (m: SensesMessage) => void;

  constructor(
    opts: {
      pythonPath?: string;
      timeoutMs?: number;
      notify?: (m: SensesMessage) => void;
    } = {},
  ) {
    this.pythonPath =
      opts.pythonPath ??
      process.env.SENSES_PYTHON ??
      this.resolvePython();
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.notify = opts.notify ?? (() => {});

    this.ready = this.spawn();
  }

  private message(m: SensesMessage): void {
    try {
      this.notify(m);
    } catch {
      // never let a notification failure break the runtime
    }
  }

  /**
   * Ensure an interpreter with the vision dependencies exists, installing
   * them (into a user-scoped venv) on first run. Returns the interpreter to
   * use. Manual overrides (SENSES_PYTHON, or an existing .venv next to the
   * runtime) win; auto-provision is disabled with SENSES_DISABLE_AUTO_PROVISION.
   */
  private async ensurePython(): Promise<string> {
    const current = this.pythonPath;
    log(`resolvePython() = '${current}'`);

    // 1. Explicit interpreter: trust it, don't touch.
    if (process.env.SENSES_PYTHON) return current;

    // 2. A project .venv we shipped/found already works.
    if (await this.hasMoondream(current)) return current;

    if (process.env.SENSES_DISABLE_AUTO_PROVISION) {
      throw new SensesError(
        "DEPENDENCY_MISSING",
        `interpreter '${current}' lacks 'moondream' and auto-provision is disabled. ` +
          `Set SENSES_PYTHON to an environment with moondream installed.`,
      );
    }

    // 3. Auto-provision into a user-scoped venv (survives npm cache rewrites).
    const venv = resolvePath(
      process.env.SENSES_VENV_DIR ?? resolvePath(homedir(), ".cache", "opencode-senses", "venv"),
    );
    const python = venvPython(venv);
    log(`probe venv '${python}'`);
    if (await this.hasMoondream(python)) return python;

    log(`provisioning moondream runtime into ${venv} (one-time)`);
    this.message({
      title: "Senses",
      message: "Installing the vision runtime (first run, one-time).",
      variant: "info",
    });
    await mkdirAsync(venv, { recursive: true });

    const base = process.env.PYTHON ?? "python3";
    if (await this.hasUv()) {
      // uv-first: faster, shared cross-project package cache (~/.cache/uv),
      // and it can bootstrap its own Python if the host lacks a usable one.
      try {
        await this.runProvision(
          this.uv,
          ["venv", venv, "--python", base],
          "creating virtualenv (uv)",
        );
        await this.runProvision(
          this.uv,
          ["pip", "install", "--python", python, "moondream"],
          "installing moondream (uv)",
        );
      } catch (err) {
        throw new SensesError(
          "PROVISION_FAILED",
          `uv provisioning failed: ${(err as Error).message}. ` +
            `Remove ${venv} and retry, or set SENSES_PYTHON manually.`,
        );
      }
    } else {
      // Host-interpreter fallback: python -m venv + pip.
      try {
        await this.runProvision(base, ["-m", "venv", venv], "creating virtualenv");
      } catch (err) {
        throw new SensesError(
          "PROVISION_FAILED",
          `failed to create virtualenv at ${venv}: ${(err as Error).message}. ` +
            `Install uv (curl -LsSf https://astral.sh/uv/install.sh | sh) and retry.`,
        );
      }
      const pip = venvPython(venv).replace(/python(\.exe)?$/, "pip");
      try {
        await this.runProvision(pip, ["install", "--upgrade", "pip"], "upgrading pip");
        await this.runProvision(pip, ["install", "moondream"], "installing moondream");
      } catch (err) {
        throw new SensesError(
          "PROVISION_FAILED",
          `failed to install moondream into ${venv}: ${(err as Error).message}. ` +
            `Remove ${venv} and retry, or set SENSES_PYTHON manually.`,
        );
      }
    }

    if (!(await this.hasMoondream(python))) {
      throw new SensesError(
        "PROVISION_FAILED",
        `moondream still not importable after provisioning at ${python}`,
      );
    }
    this.pythonPath = python;
    this.message({
      title: "Senses",
      message: "Vision runtime installed and ready.",
      variant: "success",
    });
    return python;
  }

  /** True if the given interpreter can import moondream. */
  private async hasMoondream(python: string): Promise<boolean> {
    try {
      await execFileAsync(
        python,
        ["-c", "import moondream; del moondream"],
        { timeout: 5_000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the uv binary is usable (overridable with SENSES_UV). */
  private async hasUv(): Promise<boolean> {
    try {
      await execFileAsync(this.uv, ["--version"], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Run a provisioning subprocess, streaming its output lines for visibility. */
  private async runProvision(
    cmd: string,
    args: string[],
    label: string,
  ): Promise<void> {
    log(`${label}...`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => log(`  ${d}`));
      child.stderr.on("data", (d) => log(`  ${d}`));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`)),
      );
    });
  }

  private resolvePython(): string {
    // Prefer a virtualenv next to the project (checked into repo layout).
    const venvCandidates = [
      resolvePath(this.repoRoot(), ".venv", "bin", "python"),
      resolvePath(this.repoRoot(), "python", ".venv", "bin", "python"),
    ];
    for (const candidate of venvCandidates) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
    return process.env.PYTHON ?? "python3";
  }

  private repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    // Walk up from the built module; the true repo root contains BOTH
    // python/runtime.py AND .venv (which dist/ deliberately does not
    // ship). If only one is found, fall back to that directory.
    let dir = here;
    let lastRuntimeDir: string | null = null;
    for (let i = 0; i < 8; i++) {
      try {
        const runtimeC = resolvePath(dir, "..", "python", "runtime.py");
        const isRuntime = statSafeIsFile(runtimeC);
        if (isRuntime) {
          lastRuntimeDir = resolvePath(dir, "..");
          const venv = resolvePath(lastRuntimeDir, ".venv", "bin", "python");
          if (statSafeIsFile(venv)) {
            return lastRuntimeDir;
          }
        }
      } catch {
        // keep climbing
      }
      if (dir === resolvePath(dir, "..")) break;
      dir = resolvePath(dir, "..");
    }
    if (lastRuntimeDir) return lastRuntimeDir;
    return process.cwd();
  }

  private async spawn(): Promise<void> {
    let pythonPath: string;
    try {
      pythonPath = await this.ensurePython();
    } catch (err) {
      this.broken = true;
      log(`provision failed: ${(err as Error).message}`);
      this.message({
        title: "Senses failed to start",
        message: (err as Error).message,
        variant: "error",
      });
      this.rejectAll(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const runtimeScript = resolvePath(this.repoRoot(), "python", "runtime.py");
    log(`spawning '${pythonPath}' runtime.py='${runtimeScript}'`);
    const child = spawn(pythonPath, [runtimeScript], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      log(chunk.toString());
    });
    child.on("error", (err) => this.onProcessError(err));
    child.on("exit", (code, signal) => this.onExit(code, signal));

    // Wait for the first response so startup failures surface before use.
    let pingOK = false;
    try {
      await Promise.race([
        this.requestOnce("ping", {}).then(() => {
          pingOK = true;
        }),
        new Promise((resolve) => setTimeout(resolve, 15_000)),
      ]);
    } catch (err) {
      log(`startup ping failed: ${(err as Error).message}`);
    }
    if (this.child && !this.broken && pingOK) {
      log("runtime ready");
    }
  }

  private onProcessError(err: Error): void {
    log(`process error: ${err.message}`);
    this.broken = true;
    this.rejectAll(new Error(`python runtime failed: ${err.message}`));
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    // A clean shutdown request (id -1) is expected; don't choke on it.
    const expected = this.child === null;
    this.broken = true;
    this.rejectAll(new Error(`python runtime exited (code=${code}, signal=${signal})`));
    this.child = null;
    if (!expected) {
      log(`runtime exited unexpectedly (code=${code}, signal=${signal})`);
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: RpcResponse;
    try {
      msg = JSON.parse(line) as RpcResponse;
    } catch {
      log(`bad JSON from runtime: ${line}`);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new SensesError(msg.error.code, msg.error.message));
    } else {
      entry.resolve(msg);
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return (this.ready as Promise<void>).then(() => this.requestOnce(method, params));
  }

  /** Send a single RPC once the runtime is up. */
  private requestOnce(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.broken) {
      return Promise.reject(new SensesError("RUNTIME_UNAVAILABLE", "senses runtime is not running"));
    }
    const id = this.nextId++;
    const req: RpcRequest = { id, method, params };

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SensesError("PROVIDER_TIMEOUT", `timed out waiting for '${method}'`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new SensesError("RUNTIME_UNAVAILABLE", "senses runtime is not running"));
        return;
      }
      this.child.stdin.write(JSON.stringify(req) + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new SensesError("RUNTIME_UNAVAILABLE", `failed to write '${method}': ${err.message}`));
        }
      });
    }).then((res) => {
      if (res.error) throw new SensesError(res.error.code, res.error.message);
      return res.result ?? {};
    });
  }

  async ping(): Promise<Record<string, unknown>> {
    return this.request("ping");
  }

  async status(): Promise<Record<string, unknown>> {
    return this.request("status");
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.broken = true;
    if (!child) return;
    try {
      child.stdin?.write(JSON.stringify({ id: -1, method: "shutdown" }) + "\n");
    } catch {
      // best effort
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await once(child, "exit").catch(() => undefined).then(() => clearTimeout(timer));
    this.rejectAll(new SensesError("SHUTDOWN", "senses runtime closed"));
  }

  private rejectAll(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

export class SensesError extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(code: string, message: string, recoverable = true) {
    super(message);
    this.name = "SensesError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

function statSafeIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}