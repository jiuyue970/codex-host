import { parseDesktopControllerArguments, runDesktopController } from "./production-controller.js";
import { initializeProcessLog, logError, logInfo } from "./process-log.js";

initializeProcessLog("desktop-controller");

const abort = new AbortController();
const stop = (): void => abort.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await runDesktopController(parseDesktopControllerArguments(process.argv.slice(2)), abort.signal);
  logInfo("Desktop Controller finished");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`codexhost Desktop Controller: ${message}`);
  logError(`Desktop Controller failed: ${message}`);
  process.exitCode = 1;
} finally {
  logInfo("Desktop Controller shutting down");
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
