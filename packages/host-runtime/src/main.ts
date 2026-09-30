import { initializeProcessLog, logError, logInfo } from "@codexhost/desktop-control";
import { runDelegationCli } from "./delegation-cli.js";
import { runHostRuntime } from "./run-host-runtime.js";
import { runRemoteControlAppServerBridge } from "./remote-control-app-server.js";
import { runRemoteHostCli } from "./remote-host-cli.js";
import { runClaudeAquaHarnessBroker } from "./aqua-harness-broker.js";

initializeProcessLog("host-runtime");

const arguments_ = process.argv.slice(2);
const mode =
  arguments_[0] === "--codexhost-delegation-cli"
    ? "delegation-cli"
    : arguments_[0] === "--codexhost-harness-broker"
      ? "harness-broker"
      : arguments_[0] === "--codexhost-remote"
        ? "remote"
        : arguments_[0] === "--codexhost-remote-control-bridge"
          ? "remote-control-bridge"
          : "host-runtime";
logInfo(`invocation mode=${mode}`);

try {
  process.exitCode =
    mode === "delegation-cli"
      ? await runDelegationCli({ arguments: arguments_.slice(1), environment: process.env })
      : mode === "harness-broker"
        ? await runClaudeAquaHarnessBroker(process.env, arguments_[1] ?? "claude-code")
        : mode === "remote"
          ? await runRemoteHostCli({ arguments: arguments_.slice(1), environment: process.env })
          : mode === "remote-control-bridge"
            ? await runRemoteControlAppServerBridge()
            : await runHostRuntime({ arguments: arguments_, environment: process.env });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logError(`${mode} failed: ${message}`);
  process.exitCode = 1;
} finally {
  logInfo(`${mode} finished exitCode=${String(process.exitCode)}`);
}
