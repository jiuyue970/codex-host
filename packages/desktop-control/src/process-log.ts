import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Environment variable the Launcher uses to hand down its resolved log
 * directory. Child processes read it instead of re-deriving a platform path. */
export const LOG_DIRECTORY_ENV = "CODEXHOST_LOG_DIR";

/** Disk budget per component: the live file plus one rotated backup. */
export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

const REDACTED = "[redacted]";

/** Mirrors `SENSITIVE_VALUE_PATTERN` in `packages/harness-adapter/src/diagnostics.ts`
 * and the Rust port in `crates/platform/src/process_log.rs`. All three MUST
 * redact the same text; a credential that looks different per language defeats
 * the point of redacting it at all. */
const SENSITIVE_VALUE_PATTERN =
  /(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)(\s*[:=]\s*)([^\s,;]+)/giu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;

/** Replaces credential-shaped values, then caps the tail. */
export function sanitizeLogMessage(value: string): string {
  return value
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(SENSITIVE_VALUE_PATTERN, `$1$2${REDACTED}`);
}

function stateRoot(environment: NodeJS.ProcessEnv): string | null {
  const explicit = environment[LOG_DIRECTORY_ENV];
  if (explicit) return explicit;
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Logs", "codexhost");
    case "win32": {
      const localAppData = environment.LOCALAPPDATA;
      return localAppData ? join(localAppData, "codexhost", "logs") : null;
    }
    default: {
      const state = environment.XDG_STATE_HOME;
      if (state) return join(state, "codexhost");
      return join(homedir(), ".local", "state", "codexhost");
    }
  }
}

export interface ProcessLog {
  /** Absolute path of the live log file, useful for operator-facing messages. */
  path: string;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Opens a size-bounded per-component log. Returns `null` when the directory
 * or file cannot be opened: a process that cannot log must still start. */
export function openProcessLog(
  component: string,
  directory: string,
  maxBytes: number = DEFAULT_MAX_LOG_BYTES,
): ProcessLog | null {
  try {
    // Logs can name user directories, ports and Harness identities, so the
    // directory is owner-only rather than inheriting the ambient umask.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Creating an existing directory is a no-op, and an earlier run may have
    // left it group- or world-readable. Tighten it either way.
    chmodSync(directory, 0o700);
  } catch {
    return null;
  }
  const path = join(directory, `${component}.log`);
  try {
    closeSync(openSync(path, "a", 0o600));
    // Same reasoning as the directory: the mode argument only applies on
    // creation, so a log left behind by an older build stays readable.
    chmodSync(path, 0o600);
  } catch {
    return null;
  }
  const write = (level: string, message: string): void => {
    const record = `${new Date().toISOString()} pid=${process.pid} level=${level} component=${component} ${sanitizeLogMessage(message)}\n`;
    try {
      if (exceedsCap(path, Buffer.byteLength(record), maxBytes)) rotate(path);
      const handle = openSync(path, "a", 0o600);
      try {
        writeSync(handle, record);
      } finally {
        closeSync(handle);
      }
    } catch {
      // A failing log must never take the process down with it.
    }
  };
  return {
    path,
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}

function exceedsCap(path: string, incoming: number, maxBytes: number): boolean {
  if (maxBytes <= 0) return false;
  let current = 0;
  try {
    current = statSync(path).size;
  } catch {
    return false;
  }
  return current + incoming > maxBytes;
}

/** Keeps disk use bounded at `2 * maxBytes`: the live file becomes `.1` and a
 * fresh file takes its place. */
function rotate(path: string): void {
  const backup = `${path}.1`;
  try {
    rmSync(backup, { force: true });
    renameSync(path, backup);
  } catch {
    // A failed rotation only means the cap is enforced a little later.
  }
}

let installed: ProcessLog | null | undefined;

/** Installs the process-wide log for this component. Repeated calls return the
 * log installed by the first caller. */
export function initializeProcessLog(
  component: string,
  environment: NodeJS.ProcessEnv = process.env,
): ProcessLog | null {
  if (installed !== undefined) return installed;
  const directory = stateRoot(environment);
  installed = directory ? openProcessLog(component, directory) : null;
  installed?.info(`${component} started pid=${process.pid}`);
  return installed;
}

export function logInfo(message: string): void {
  installed?.info(message);
}

export function logWarn(message: string): void {
  installed?.warn(message);
}

export function logError(message: string): void {
  installed?.error(message);
}

/** Test seam: drops the installed log so the next `initializeProcessLog` call
 * resolves afresh. */
export function resetProcessLogForTests(): void {
  installed = undefined;
}
