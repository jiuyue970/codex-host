import type { CodexhostError } from "@codexhost/shared-contracts";

import type { ExternalRendererAgent, RendererAgentAvailability } from "./agent-selection-state.js";
import type { RendererCodexAccountState } from "./renderer-codex-account-state.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import type { RendererAdapterStatus } from "./versioned-renderer-adapter.js";

/**
 * Which Hosts the Renderer can reach, and when to look again.
 *
 * Split out of renderer-binding-probe.ts on one boundary: this module decides
 * *whether a Host is reachable and how long until we ask again*. What the
 * Renderer then does about it — reconciling composers, reloading Model
 * catalogs, repainting — stays in the probe, because that is UI work and this
 * is state. The probe reaches in through inspectHost and is called back.
 */

export type HarnessAvailability = Partial<Record<ExternalRendererAgent, RendererAgentAvailability>>;
export type HarnessWebUiAvailability = Record<ExternalRendererAgent, boolean>;
export type HarnessAvailabilityErrors = Partial<
  Record<ExternalRendererAgent, CodexhostError | undefined>
>;

export interface HostHarnessAvailabilityState {
  codexAccounts: RendererCodexAccountState | null;
  availability: HarnessAvailability;
  errors: HarnessAvailabilityErrors;
  webUi: HarnessWebUiAvailability;
  requestGeneration: number;
  request: { client: RendererModelClient; promise: Promise<void> } | null;
  retryTimer: number | null;
  retryAttempt: number;
  /// Whether a control bridge has ever been resolved for this Host. Lets the
  /// settings page tell "still starting up" apart from "was connected, then
  /// went away", which are very different operator actions.
  everConnected: boolean;
}

/// Outcome of resolving the control bridge for one Host. "absent" and
/// "unregistered" used to collapse into a single null, which sent users
/// looking for ten broken Harnesses when the real problem was one missing
/// process — and gave no hint which process.
export type HostClientResolution =
  | { readonly state: "connected"; readonly client: RendererModelClient }
  | { readonly state: "absent" }
  | { readonly state: "unregistered" };

const AVAILABILITY_RETRY_DELAYS = [500, 1000, 2000, 4000, 8000] as const;
const AVAILABILITY_HEARTBEAT_INTERVAL = 30_000;

/// When to re-check a Host that has not attached a control bridge yet.
///
/// The first attempts race Host boot and stay tight. Past that burst the
/// bridge is still worth waiting for: a Host that finished starting late used
/// to be given up on after ~15s, which left the page permanently stale until
/// someone re-ran diagnostics by hand. So the schedule falls back to a slow
/// heartbeat instead of stopping.
export function availabilityRetryDelay(attempt: number): number {
  return AVAILABILITY_RETRY_DELAYS[attempt] ?? AVAILABILITY_HEARTBEAT_INTERVAL;
}

/// Resolve the control bridge for one Host from an explicit client, for
/// callers that already hold a specific client rather than the shared one.
export function clientForHostFrom(
  control: RendererModelClient | null,
  hostId: string | null,
): RendererModelClient | null {
  if (!control || !hostId) return null;
  if (control.clientForHost) return control.clientForHost(hostId);
  // Only legacy controls without Host identity are local. An explicit null
  // means the route is still unknown, which is never permission to send a
  // local request.
  if (!control.currentHostId) return hostId === "local" ? control : null;
  return control.currentHostId() === hostId ? control : null;
}

export function refreshConnectionHosts(
  hostIds: Iterable<string>,
  refreshHost: (hostId: string) => Promise<void>,
): Promise<void> {
  return Promise.all([...hostIds].map((hostId) => refreshHost(hostId))).then(() => undefined);
}

export interface HostConnectionOptions {
  readonly externalAgents: readonly ExternalRendererAgent[];
  readonly isDisposed: () => boolean;
  readonly modelControl: () => RendererModelClient | null;
  readonly adapterStatus: () => RendererAdapterStatus;
  readonly inspectHost: (
    hostId: string,
    refresh: boolean,
    retry: boolean,
    force: boolean,
  ) => Promise<void>;
}

export interface HostConnection {
  stateFor(hostId: string): HostHarnessAvailabilityState;
  activeHostId(): string;
  setActiveHostId(hostId: string): void;
  activeState(): HostHarnessAvailabilityState;
  publish(): void;
  resetRetry(hostId: string): void;
  scheduleRetry(hostId: string): void;
  clientForHost(hostId: string): RendererModelClient | null;
  resolutionFor(hostId: string): HostClientResolution;
  knownHostIds(): Iterable<string>;
  /// Drop every per-Host state and subscriber. Used when the probe is disposed
  /// so a late callback cannot resurrect state for a Renderer that is gone.
  reset(): void;
  /// Abort every in-flight availability inspection and cancel its pending
  /// retry. Bumping the generation is what makes an already-resolved promise
  /// discard its result instead of writing stale availability.
  invalidateRequests(): void;
}

/// Explains a resolution state in operator terms. It sits beside the
/// resolution type because the wording is the contract: an operator who reads
/// "unregistered" must be able to tell a dead process from a Host that was
/// never wired up.
export function hostConnectionDiagnostic(
  state: HostClientResolution["state"],
  hostId: string,
): string {
  switch (state) {
    case "absent":
      return (
        `The codexhost Host has not attached a Renderer control bridge for "${hostId}". ` +
        "The Launcher, Desktop Controller and Host Runtime are not running, or the " +
        "Renderer Adapter is still installing. Restart codexhost — re-running " +
        "diagnostics on this page cannot reattach a bridge that was never built."
      );
    case "unregistered":
      return (
        `A Renderer control bridge is attached, but it has no client registered for "${hostId}". ` +
        "This Host is not part of the running codexhost runtime."
      );
    case "connected":
      return "";
  }
}

export function createHostConnection(options: HostConnectionOptions): HostConnection {
  const createState = (): HostHarnessAvailabilityState => ({
    codexAccounts: null,
    availability: Object.fromEntries(
      options.externalAgents.map((agent) => [agent, "checking"]),
    ) as HarnessAvailability,
    // Derived from the same agent list the Renderer installs, so adding an
    // Agent upstream cannot leave one entry here uninitialized.
    errors: Object.fromEntries(
      options.externalAgents.map((agent) => [agent, undefined]),
    ) as HarnessAvailabilityErrors,
    webUi: Object.fromEntries(
      options.externalAgents.map((agent) => [agent, false]),
    ) as HarnessWebUiAvailability,
    requestGeneration: 0,
    request: null,
    retryTimer: null,
    retryAttempt: 0,
    everConnected: false,
  });
  const states = new Map<string, HostHarnessAvailabilityState>();
  const stateFor = (hostId: string): HostHarnessAvailabilityState => {
    let state = states.get(hostId);
    if (!state) {
      state = createState();
      states.set(hostId, state);
    }
    return state;
  };

  let activeHostId = "local";
  const listeners = new Set<() => void>();
  const publish = (): void => {
    for (const listener of listeners) listener();
  };

  const resetRetry = (hostId: string): void => {
    const state = stateFor(hostId);
    if (state.retryTimer !== null) {
      window.clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryAttempt = 0;
  };

  const scheduleRetry = (hostId: string): void => {
    const state = stateFor(hostId);
    if (options.isDisposed() || state.retryTimer !== null) return;
    const delay = availabilityRetryDelay(state.retryAttempt);
    state.retryAttempt += 1;
    state.retryTimer = window.setTimeout(() => {
      state.retryTimer = null;
      void options.inspectHost(hostId, true, true, false);
    }, delay);
  };

  const resolve = (hostId: string): HostClientResolution => {
    const control = options.modelControl();
    if (!control) return { state: "absent" };
    const client = clientForHostFrom(control, hostId);
    return client ? { state: "connected", client } : { state: "unregistered" };
  };

  const connection: HostConnection = {
    stateFor,
    activeHostId: () => activeHostId,
    setActiveHostId: (hostId) => {
      activeHostId = hostId;
    },
    activeState: () => stateFor(activeHostId),
    publish,
    resetRetry,
    scheduleRetry,
    clientForHost: (hostId) => {
      const resolved = resolve(hostId);
      return resolved.state === "connected" ? resolved.client : null;
    },
    resolutionFor: resolve,
    knownHostIds: () => states.keys(),
    reset: () => {
      states.clear();
      activeHostId = "local";
      listeners.clear();
    },
    invalidateRequests: () => {
      for (const state of states.values()) {
        state.requestGeneration += 1;
        state.request = null;
        state.codexAccounts?.dispose();
        if (state.retryTimer !== null) {
          window.clearTimeout(state.retryTimer);
          state.retryTimer = null;
        }
      }
    },
  };
  return connection;
}
