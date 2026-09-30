import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_LOG_BYTES,
  LOG_DIRECTORY_ENV,
  initializeProcessLog,
  openProcessLog,
  resetProcessLogForTests,
  sanitizeLogMessage,
} from "../src/process-log.js";

describe("process log redaction", () => {
  it("matches the sanitizeDiagnosticTail reference for credential shapes", () => {
    // These expectations are the ground truth of
    // `sanitizeDiagnosticTail` in packages/harness-adapter/src/diagnostics.ts.
    // The Rust port in crates/platform/src/process_log.rs asserts the same set.
    expect(sanitizeLogMessage("launch failed API_KEY=sk-abc123")).toBe(
      "launch failed API_KEY=[redacted]",
    );
    expect(sanitizeLogMessage("access_token = tok_12345 and secret: s3cr3t")).toBe(
      "access_token = [redacted] and secret: [redacted]",
    );
    expect(sanitizeLogMessage("a=API_KEY=one b=PASSWORD=two")).toBe(
      "a=API_KEY=[redacted] b=PASSWORD=[redacted]",
    );
  });

  it("leaves ordinary words that merely contain a keyword alone", () => {
    expect(sanitizeLogMessage("authenticating harness pi")).toBe("authenticating harness pi");
    expect(sanitizeLogMessage("password policy is not set")).toBe("password policy is not set");
  });
});

describe("process log files", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "codexhost-process-log-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("stamps every record with an ISO timestamp, pid, level and component", () => {
    const log = openProcessLog("host-runtime", directory);
    expect(log).not.toBeNull();
    log?.info("Host chain ready");
    log?.error("inspect failed");

    const lines = readFileSync(join(directory, "host-runtime.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z pid=\d+ level=info component=host-runtime Host chain ready$/u,
    );
    expect(lines[1]).toContain(`pid=${process.pid} level=error component=host-runtime`);
  });

  it("redacts credentials on the way to disk", () => {
    const log = openProcessLog("host-runtime", directory);
    log?.error("adapter rejected API_KEY=sk-live-should-not-persist");

    const contents = readFileSync(join(directory, "host-runtime.log"), "utf8");
    expect(contents).toContain("API_KEY=[redacted]");
    expect(contents).not.toContain("sk-live-should-not-persist");
  });

  it("rotates into a single backup so disk use stays bounded", () => {
    const log = openProcessLog("host-runtime", directory, 512);
    for (let index = 0; index < 20; index += 1) {
      log?.info(`event ${index}`);
    }

    const live = readFileSync(join(directory, "host-runtime.log"), "utf8");
    const backup = readFileSync(join(directory, "host-runtime.log.1"), "utf8");
    expect(Buffer.byteLength(live)).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(backup)).toBeLessThanOrEqual(512);
    expect(`${live}${backup}`).toContain("event 19");
  });

  it("never splits a record across the rotation boundary", () => {
    const log = openProcessLog("host-runtime", directory, 16);
    log?.info("an event far longer than the configured cap");

    const contents = readFileSync(join(directory, "host-runtime.log"), "utf8");
    expect(contents.trim().split("\n")).toHaveLength(1);
    expect(contents).toContain("an event far longer than the configured cap");
  });

  it("keeps a default budget large enough to be useful", () => {
    expect(DEFAULT_MAX_LOG_BYTES).toBe(5 * 1024 * 1024);
  });

  it.skipIf(process.platform === "win32")("keeps the log owner-only", () => {
    const nested = join(directory, "nested", "logs");
    const log = openProcessLog("host-runtime", nested);
    log?.info("sensitive surroundings");

    expect(statSync(nested).mode & 0o777).toBe(0o700);
    expect(statSync(join(nested, "host-runtime.log")).mode & 0o777).toBe(0o600);
  });
});

describe("process log directory resolution", () => {
  afterEach(() => {
    resetProcessLogForTests();
  });

  it("prefers the directory the Launcher already resolved", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexhost-log-env-"));
    try {
      const log = initializeProcessLog("desktop-controller", {
        [LOG_DIRECTORY_ENV]: directory,
      } as NodeJS.ProcessEnv);
      expect(log?.path).toBe(join(directory, "desktop-controller.log"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("degrades to a disabled log rather than refusing to start", () => {
    expect(
      initializeProcessLog("desktop-controller", {
        [LOG_DIRECTORY_ENV]: "/dev/null/impossible",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});
