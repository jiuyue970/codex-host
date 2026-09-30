import { harnessIdSchema } from "@codexhost/shared-contracts";
import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { afterEach, assert, describe, expect, it, vi } from "vitest";

import type * as RendererComposerDom from "../src/renderer-composer-dom.js";
import {
  isRendererModelPickerDisabled,
  type RendererModelControlView,
} from "../src/renderer-model-picker.js";
import type { RendererRequestOptions } from "../src/renderer-request-sender.js";
import type { installRendererSidebarAgentIcons } from "../src/renderer-sidebar-agent-icons.js";
import type { RendererConnectionDiagnostics } from "../src/settings/connections-page.js";
import type { RendererSessionImportClient } from "../src/settings/session-import-page.js";
import type * as VersionedRendererAdapter from "../src/versioned-renderer-adapter.js";

const testState = vi.hoisted(() => ({
  composer: null as unknown as Element,
  editor: null as unknown as Element,
  sendButton: null as unknown as HTMLButtonElement,
  renderedModelViews: [] as RendererModelControlView[],
  selectModel: null as null | ((modelId: string) => void),
  getConnectionDiagnostics: null as null | (() => RendererConnectionDiagnostics | null),
  getSessionImportClient: null as null | (() => RendererSessionImportClient | null),
  sidebarOptions: null as null | Parameters<typeof installRendererSidebarAgentIcons>[0],
  documentListeners: new Map<string, EventListener>(),
  modelTarget: ["conversation", "thread-a"] as readonly unknown[],
  prewarmClears: 0,
}));

vi.mock("../src/renderer-composer-dom.js", async (importOriginal) => {
  const original = await importOriginal<typeof RendererComposerDom>();
  return {
    ...original,
    composerForEditor: () => testState.composer,
    composerForElement: () => testState.composer,
    editorForElement: () => testState.editor,
    eventElement: () => testState.composer,
    mountComposerAgentControl: (
      ...args: Parameters<typeof RendererComposerDom.mountComposerAgentControl>
    ) => {
      testState.selectModel = args[7];
      return {
        composer: testState.composer,
        composerId: "composer-1",
        root: { isConnected: true, remove: vi.fn() },
        picker: { root: { isConnected: true } },
        modelPicker: { root: { isConnected: true }, trigger: {} },
        permissionModePicker: { root: { isConnected: true } },
        nativeModelControl: null,
        nativePermissionModeControl: null,
        nativeContextUsageControl: null,
        nativePermissionModeControlVerified: false,
        credits: { anchor: null, place: vi.fn(), root: { remove: vi.fn() } },
        usage: null,
        harnessCommands: {
          setCommands: vi.fn(),
          setExecuting: vi.fn(),
          setLocale: vi.fn(),
          placeBefore: vi.fn(),
          dispose: vi.fn(),
        },
        sendButton: testState.sendButton,
        sendDisabledBeforeSwitch: null,
      };
    },
    renderComposerAgentControl: (
      _control: unknown,
      _selection: unknown,
      _adapter: unknown,
      _switching: unknown,
      _availability: unknown,
      modelView: RendererModelControlView,
    ) => {
      testState.renderedModelViews.push({ ...modelView });
    },
    reconcileComposerNativeControls: vi.fn(),
    disposeComposerAgentControl: vi.fn(),
    sendButtonWithin: () => testState.sendButton,
  };
});

vi.mock("../src/versioned-renderer-adapter.js", async (importOriginal) => {
  const original = await importOriginal<typeof VersionedRendererAdapter>();
  return {
    ...original,
    findComposerModelTarget: () => testState.modelTarget,
    waitForRendererDraftPrewarmPolicy: async () => ({
      clear: async () => {
        testState.prewarmClears += 1;
      },
    }),
  };
});

vi.mock("../src/renderer-sidebar-agent-icons.js", () => ({
  installRendererSidebarAgentIcons: (
    options: Parameters<typeof installRendererSidebarAgentIcons>[0],
  ) => {
    testState.sidebarOptions = options;
    return { refresh: vi.fn(), dispose: vi.fn() };
  },
}));

vi.mock("../src/renderer-settings-lifecycle.js", () => ({
  installRendererSettingsLifecycle: (
    _window: unknown,
    options: {
      getConnectionDiagnostics(): RendererConnectionDiagnostics | null;
      getSessionImportClient(): RendererSessionImportClient | null;
    },
  ) => {
    testState.getConnectionDiagnostics = options.getConnectionDiagnostics;
    testState.getSessionImportClient = options.getSessionImportClient;
    return {
      locale: "en",
      refresh: vi.fn(),
      dispose: vi.fn(),
    };
  },
}));

function readyInspection(modelId = "claude-model-v1.b3B1cw") {
  const model = harnessModelRefSchema.parse({ id: modelId });
  return {
    status: "ready" as const,
    catalog: {
      models: [{ ref: model, label: modelId }],
      defaultModel: model,
      thinkingOptions: [],
    },
    capabilities: {
      configuration: {
        selectModel: true,
        selectThinkingOption: false,
        selectPermissionMode: false,
        permissionModeScope: "live" as const,
      },
      history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
    },
  };
}

function emptyInspection() {
  return {
    status: "ready" as const,
    catalog: { models: [], thinkingOptions: [] },
    capabilities: {
      configuration: {
        selectModel: false,
        selectThinkingOption: false,
        selectPermissionMode: false,
        permissionModeScope: "live" as const,
      },
      history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
    },
  };
}

function installFakeBrowser() {
  const listeners = new EventTarget();
  const composer = {
    isConnected: true,
    matches: (selector: string) => selector === "[data-codex-composer-root]",
    querySelectorAll: (selector: string) => (selector === "button" ? [testState.sendButton] : []),
    querySelector: (selector: string) => (selector.includes("textarea") ? testState.editor : null),
  } as unknown as Element;
  const editor = { closest: () => composer } as unknown as Element;
  const sendButton = {
    type: "submit",
    disabled: false,
    parentElement: null,
    getAttribute: () => null,
  } as unknown as HTMLButtonElement;
  testState.composer = composer;
  testState.editor = editor;
  testState.sendButton = sendButton;
  testState.renderedModelViews = [];
  testState.selectModel = null;
  testState.getConnectionDiagnostics = null;
  testState.getSessionImportClient = null;
  testState.documentListeners.clear();
  testState.modelTarget = ["conversation", "thread-a"];
  testState.prewarmClears = 0;
  const window_ = {
    addEventListener: listeners.addEventListener.bind(listeners),
    removeEventListener: listeners.removeEventListener.bind(listeners),
    dispatchEvent: listeners.dispatchEvent.bind(listeners),
    setTimeout,
    clearTimeout,
    open: vi.fn(),
  };
  const document_ = {
    documentElement: {},
    body: {},
    activeElement: null,
    querySelectorAll: (selector: string) => (selector.includes("textarea") ? [editor] : []),
    querySelector: () => null,
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      testState.documentListeners.set(type, listener);
    }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("window", window_);
  vi.stubGlobal("document", document_);
  // Node has to stay a callable constructor: Vitest's failure formatter does
  // `value instanceof Node`, and a plain object there turns every failed
  // assertion into "Right-hand side of 'instanceof' is not callable" with the
  // real diff swallowed. Nothing in the renderer source reads either symbol.
  vi.stubGlobal(
    "Node",
    Object.assign(function NodeStub() {}, { ELEMENT_NODE: 1 }),
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    "CustomEvent",
    class extends Event {
      constructor(
        type: string,
        readonly init?: CustomEventInit,
      ) {
        super(type);
      }
    },
  );
  // Returned so a test can observe the probe's timer schedule. Call
  // vi.useFakeTimers() first if you intend to drive them: the fake window
  // captures whatever setTimeout is bound at this moment.
  return window_;
}

afterEach(() => {
  const api = (
    globalThis.window as unknown as {
      __codexhostRendererBindingProbeV1?: { dispose(): void };
    }
  ).__codexhostRendererBindingProbeV1;
  api?.dispose();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Renderer binding Host-scoped Claude catalogs", () => {
  it.each([
    { pendingHarness: "pi", modelFirst: true },
    { pendingHarness: "claude-code", modelFirst: true },
    { pendingHarness: "claude-code", modelFirst: false },
  ] as const)(
    "loads the current remote Model while $pendingHarness is queued (Model completes first: $modelFirst)",
    async ({ pendingHarness, modelFirst }) => {
      installFakeBrowser();
      const pending = Promise.withResolvers<ReturnType<typeof readyInspection>>();
      const catalog = Promise.withResolvers<ReturnType<typeof readyInspection>>();
      if (modelFirst) catalog.resolve(readyInspection());
      const local = {
        inspectHarness: vi.fn(async () => readyInspection()),
      };
      const remote = {
        inspectHarness: vi.fn(
          async (input: { harnessId: string }, options?: RendererRequestOptions) => {
            if (!options) return catalog.promise;
            return input.harnessId === pendingHarness ? pending.promise : readyInspection();
          },
        ),
        inspectThread: vi.fn(async () => ({
          owner: "external" as const,
          harnessId: "claude-code",
          transportModelId:
            "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
          effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" }),
          history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
          locked: true,
        })),
        inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
        inspectThreadUsage: vi.fn(async () => ({ threadId: "thread-a", usage: null })),
      };
      const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
      const probe = installRendererBindingProbe({
        enabledAgents: ["codex", "pi", "claude-code"],
        defaultAgent: "codex",
      });
      try {
        probe.setAdapter(
          { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
          undefined,
          undefined,
          {
            ...remote,
            currentHostId: () => "remote-host",
            clientForHost: (hostId: string) => (hostId === "local" ? local : remote),
            subscribeThreadUsage: () => () => undefined,
          } as never,
        );
        await vi.waitFor(() => {
          expect(probe.lockedSelection()?.agent).toBe("claude-code");
          expect(remote.inspectHarness).toHaveBeenCalledWith({ harnessId: "claude-code" });
          expect(testState.renderedModelViews.at(-1)).toMatchObject({
            status: modelFirst ? "ready" : "loading",
          });
        });
        expect(remote.inspectHarness).toHaveBeenCalledWith(
          { harnessId: "pi", refresh: false },
          { priority: "background" },
        );
        expect(remote.inspectHarness).toHaveBeenCalledWith(
          { harnessId: "claude-code", refresh: false },
          { priority: "background" },
        );
        expect(local.inspectHarness).toHaveBeenCalledWith(
          { harnessId: "pi", refresh: false },
          { priority: "background" },
        );
        expect(remote.inspectThread).toHaveBeenCalledWith({ threadId: "thread-a" });
        expect(probe.status().availability[pendingHarness]).toBe("checking");
        const foregroundCalls = () =>
          remote.inspectHarness.mock.calls.filter(([, options]) => options === undefined).length;
        expect(foregroundCalls()).toBe(1);
        const renderedBeforeDiscovery = testState.renderedModelViews.length;
        pending.resolve(readyInspection());
        await vi.waitFor(() => expect(probe.status().availability[pendingHarness]).toBe("ready"));
        expect(foregroundCalls()).toBe(1);
        if (modelFirst) {
          expect(testState.renderedModelViews.slice(renderedBeforeDiscovery)).not.toContainEqual(
            expect.objectContaining({ status: "loading" }),
          );
        }
        catalog.resolve(readyInspection());
        await vi.waitFor(() =>
          expect(testState.renderedModelViews.at(-1)).toMatchObject({ status: "ready" }),
        );
      } finally {
        probe.dispose();
        pending.resolve(readyInspection());
        catalog.resolve(readyInspection());
      }
    },
  );

  it("waits for Host ownership rather than probing local when the route is unknown", async () => {
    installFakeBrowser();
    const inspectHarness = vi.fn(async () => {
      throw new Error("Renderer Model request manager is unavailable");
    });
    const modelControl = {
      currentHostId: () => null,
      clientForHost: vi.fn(() => null),
      inspectHarness,
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "pi"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );
    await Promise.resolve();
    const diagnostics = testState.getConnectionDiagnostics?.();
    expect(
      diagnostics
        ?.snapshot()
        .hosts.find(({ hostId }) => hostId === "local")
        ?.agents.find(({ agent }) => agent === "pi"),
    ).toMatchObject({ availability: "checking", error: null });
    expect(inspectHarness).not.toHaveBeenCalled();
  });
  it("reports a disconnected Host and ignores its late availability reply without affecting local", async () => {
    installFakeBrowser();
    const pending = Promise.withResolvers<ReturnType<typeof readyInspection>>();
    const local = {
      inspectHarness: vi.fn(async () => readyInspection()),
      inspectThread: vi.fn(async () => ({ owner: "codex", locked: true })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({ threadId: "thread-a", usage: null })),
      subscribeThreadUsage: () => () => undefined,
    };
    const remote = {
      ...local,
      inspectHarness: vi.fn(async (input: { harnessId: string }) =>
        input.harnessId === "pi" ? pending.promise : readyInspection(),
      ),
    };
    let connected = true;
    const modelControl = {
      ...remote,
      currentHostId: () => "remote-ssh-discovered:linux",
      clientForHost: (hostId: string) => (hostId === "local" ? local : connected ? remote : null),
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "pi"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );
    await vi.waitFor(() => expect(remote.inspectHarness).toHaveBeenCalled());
    connected = false;
    const diagnostics = testState.getConnectionDiagnostics?.();
    await diagnostics?.refresh();
    pending.resolve(readyInspection());
    await Promise.resolve();
    await Promise.resolve();
    const hosts = diagnostics?.snapshot().hosts;
    const remoteHost = hosts?.find(({ hostId }) => hostId === "remote-ssh-discovered:linux");
    // The Host row carries the fault: one unreachable bridge is a Host
    // problem, and it names itself.
    expect(remoteHost?.connection).toBe("disconnected");
    expect(remoteHost?.diagnostic).toContain("no client registered");
    // The Agent row is deliberately left alone. Reporting this Harness as
    // broken is what used to send an operator hunting for nine bugs that did
    // not exist behind a single dead process.
    expect(remoteHost?.agents.find(({ agent }) => agent === "pi")).toMatchObject({
      availability: "checking",
      error: null,
    });
    expect(
      hosts?.find(({ hostId }) => hostId === "local")?.agents.find(({ agent }) => agent === "pi"),
    ).toMatchObject({ availability: "ready", error: null });
  });

  it("does not rediscover the request route for unrelated sidebar rows", async () => {
    installFakeBrowser();
    const host = {
      inspectHarness: vi.fn(async () => readyInspection()),
      inspectThread: vi.fn(async () => ({ owner: "codex", locked: true })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-a",
        usage: null,
        accountCredits: null,
      })),
      subscribeThreadUsage: () => () => undefined,
    };
    const currentHostId = vi.fn(() => "local");
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({ enabledAgents: ["codex"], defaultAgent: "codex" });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      { ...host, currentHostId, clientForHost: () => host } as never,
    );
    const getAgent = testState.sidebarOptions?.getLocalAgent;
    assert(getAgent);
    await vi.waitFor(() =>
      expect(getAgent({ hostId: "local", threadId: "thread-a", draftId: null })).toBe("codex"),
    );
    currentHostId.mockClear();
    for (let index = 0; index < 77; index += 1) {
      expect(
        getAgent({ hostId: "local", threadId: `unrelated-${index}`, draftId: null }),
      ).toBeNull();
    }
    expect(currentHostId).not.toHaveBeenCalled();
    expect(getAgent({ hostId: "local", threadId: "thread-a", draftId: null })).toBe("codex");
    expect(currentHostId).toHaveBeenCalledTimes(1);
    currentHostId.mockReturnValue("remote-host");
    expect(getAgent({ hostId: "local", threadId: "thread-a", draftId: null })).toBeNull();
  });

  it("keeps the latest catalog selectable until a locked Thread explicitly replaces its missing Model", async () => {
    installFakeBrowser();
    const oldModel = harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" });
    const inspection = {
      ...readyInspection("claude-model-v1.c29ubmV0"),
      permissionModes: {
        modes: [{ id: "bypassPermissions", label: "Bypass permissions" }],
        defaultModeId: "bypassPermissions",
      },
    };
    inspection.capabilities.configuration.selectThinkingOption = true;
    inspection.capabilities.configuration.selectPermissionMode = true;
    const newModel = inspection.catalog.defaultModel;
    let resolveSelection!: (state: { effectiveModel: typeof newModel }) => void;
    const host = {
      inspectHarness: vi.fn(async () => inspection),
      inspectThread: vi.fn(async () => ({
        owner: "external" as const,
        harnessId: "claude-code",
        transportModelId:
          "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
        effectiveModel: oldModel,
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        locked: true,
      })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-a",
        usage: null,
        accountCredits: null,
      })),
      selectThreadModel: vi
        .fn()
        .mockRejectedValueOnce(new Error("Model selection failed"))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSelection = resolve;
            }),
        ),
      subscribeThreadUsage: () => () => undefined,
    };
    const modelControl = {
      ...host,
      currentHostId: () => "local",
      clientForHost: () => host,
    };
    const applyAgent = vi.fn(() => true);
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      applyAgent,
      modelControl as never,
    );
    const expectSubmissionBlocked = (blocked: boolean) => {
      const preventDefault = vi.fn();
      const stopImmediatePropagation = vi.fn();
      const submit = testState.documentListeners.get("submit");
      assert(submit);
      submit({
        target: testState.composer,
        preventDefault,
        stopImmediatePropagation,
      } as unknown as Event);
      expect(preventDefault).toHaveBeenCalledTimes(blocked ? 1 : 0);
      expect(stopImmediatePropagation).toHaveBeenCalledTimes(blocked ? 1 : 0);
    };
    const expectRecoverableView = (error: string) => {
      const view = testState.renderedModelViews.at(-1);
      assert(view);
      expect(view).toMatchObject({
        status: "error",
        catalog: inspection.catalog,
        selected: oldModel,
        thinkingSelectionSupported: true,
        error,
      });
      expect(isRendererModelPickerDisabled(view)).toBe(false);
      expect(probe.lockedSelection()?.model).toEqual(oldModel);
      expectSubmissionBlocked(true);
    };

    await vi.waitFor(() => {
      expectRecoverableView("Existing Thread Model is absent from the current Catalog");
    });
    expect(host.selectThreadModel).not.toHaveBeenCalled();
    expect(applyAgent).not.toHaveBeenCalled();

    const selectModel = testState.selectModel;
    assert(selectModel);
    selectModel(newModel.id);
    await vi.waitFor(() => expectRecoverableView("Model selection failed"));
    expect(host.selectThreadModel).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-a",
      model: newModel,
    });

    selectModel(newModel.id);
    expect(testState.renderedModelViews.at(-1)).toMatchObject({
      status: "selecting",
      selected: oldModel,
    });
    expect(probe.lockedSelection()?.model).toEqual(oldModel);
    expectSubmissionBlocked(true);
    resolveSelection({ effectiveModel: newModel });
    await vi.waitFor(() => {
      expect(testState.renderedModelViews.at(-1)).toMatchObject({
        status: "ready",
        catalog: inspection.catalog,
        selected: newModel,
      });
    });
    expect(host.selectThreadModel).toHaveBeenCalledTimes(2);
    expect(probe.lockedSelection()?.model).toEqual(newModel);
    expectSubmissionBlocked(false);
    expect(applyAgent).not.toHaveBeenCalled();
  });

  it("routes Session import to local while the current Composer Host is remote", async () => {
    installFakeBrowser();
    const local = {
      inspectHarness: vi.fn(async () => readyInspection()),
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
        ],
      })),
      listHarnessSessions: vi.fn(async () => ({ candidates: [] })),
      importHarnessSession: vi.fn(async () => ({ threadId: "local-thread" })),
    };
    const remote = {
      inspectHarness: vi.fn(async () => readyInspection()),
      listSessionImportSources: vi.fn(async () => ({
        harnesses: [
          { harnessId: harnessIdSchema.parse("deepseek-harness"), name: "DeepSeek Harness" },
        ],
      })),
      listHarnessSessions: vi.fn(),
      importHarnessSession: vi.fn(),
    };
    const modelControl = {
      ...remote,
      currentHostId: () => "remote-1",
      clientForHost: vi.fn((hostId: string) => (hostId === "local" ? local : remote)),
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "deepseek-harness"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    const client = testState.getSessionImportClient?.();
    if (!client) throw new Error("Local Session import client was not installed");
    await client.listSessionImportSources();
    await client.listHarnessSessions({ harnessId: harnessIdSchema.parse("pi") });
    await client.importHarnessSession({
      harnessId: harnessIdSchema.parse("pi"),
      nativeSessionId: "native-session",
    });

    expect(modelControl.clientForHost).toHaveBeenCalledWith("local");
    expect(local.listSessionImportSources).toHaveBeenCalledOnce();
    expect(local.listHarnessSessions).toHaveBeenCalledWith({ harnessId: "pi" });
    expect(local.importHarnessSession).toHaveBeenCalledWith({
      harnessId: "pi",
      nativeSessionId: "native-session",
    });
    expect(remote.listHarnessSessions).not.toHaveBeenCalled();
    expect(remote.importHarnessSession).not.toHaveBeenCalled();
  });

  it("invalidates and refreshes a stale managed Web capability after open fails", async () => {
    installFakeBrowser();
    let dshAvailable = true;
    let dshInspections = 0;
    const local = {
      inspectHarness: vi.fn(async ({ harnessId }: { harnessId: string }) => {
        if (harnessId !== "deepseek-harness") return readyInspection();
        dshInspections += 1;
        return dshAvailable
          ? { ...readyInspection("deepseek-model-v1.bW9kZWw"), webUi: { open: true as const } }
          : {
              status: "unavailable" as const,
              error: { code: "processExited", message: "managed DSH exited", retryable: true },
            };
      }),
      openHarnessWebUi: vi.fn(async () => {
        throw new Error("managed DSH exited");
      }),
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const modelControl = {
      ...local,
      currentHostId: () => "local",
      clientForHost: vi.fn(() => local),
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "deepseek-harness"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    await vi.waitFor(() => {
      const diagnostics = testState.getConnectionDiagnostics?.();
      const dsh = diagnostics
        ?.snapshot()
        .hosts.find(({ hostId }) => hostId === "local")
        ?.agents.find(({ agent }) => agent === "deepseek-harness");
      expect(dsh?.webUiAvailable).toBe(true);
    });
    const inspectionsBeforeFailure = dshInspections;
    dshAvailable = false;
    const diagnostics = testState.getConnectionDiagnostics?.();
    await expect(diagnostics?.openWebUi?.("local", "deepseek-harness")).rejects.toThrow(
      "managed DSH exited",
    );
    expect(
      diagnostics
        ?.snapshot()
        .hosts.find(({ hostId }) => hostId === "local")
        ?.agents.find(({ agent }) => agent === "deepseek-harness")?.webUiAvailable,
    ).toBeUndefined();
    await vi.waitFor(() => expect(dshInspections).toBeGreaterThan(inspectionsBeforeFailure));

    probe.dispose();
  });

  it("does not let a stale remote Host response mark a locked Claude Model unavailable", async () => {
    installFakeBrowser();
    let currentHostId = "host-a";
    let resolveCatalog!: (value: ReturnType<typeof readyInspection>) => void;
    const pendingCatalog = new Promise<ReturnType<typeof readyInspection>>((resolve) => {
      resolveCatalog = resolve;
    });
    let claudeInspections = 0;
    const hostA = {
      inspectHarness: vi.fn(({ harnessId }: { harnessId: string }) => {
        if (harnessId !== "claude-code") return Promise.resolve(readyInspection());
        claudeInspections += 1;
        return claudeInspections === 1 ? Promise.resolve(readyInspection()) : pendingCatalog;
      }),
      inspectThread: vi.fn(async () => ({
        owner: "external" as const,
        harnessId: "claude-code",
        transportModelId:
          "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
        effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" }),
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        locked: true,
      })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-a",
        usage: null,
        accountCredits: null,
      })),
    };
    const genericHostB = {
      inspectHarness: vi.fn(async () => readyInspection("opencodex-model-v1.generic")),
    };
    const modelControl = {
      currentHostId: () => currentHostId,
      clientForHost: vi.fn((hostId: string) => (hostId === "host-a" ? hostA : genericHostB)),
      inspectHarness: genericHostB.inspectHarness,
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    await vi.waitFor(() => expect(claudeInspections).toBe(2));
    currentHostId = "host-b";
    resolveCatalog(readyInspection("claude-model-v1.c29ubmV0"));
    await Promise.resolve();
    await Promise.resolve();

    expect(hostA.inspectThread).toHaveBeenCalledWith({ threadId: "thread-a" });
    expect(modelControl.clientForHost).toHaveBeenCalledWith("host-a");
    expect(genericHostB.inspectHarness).not.toHaveBeenCalledWith({ harnessId: "claude-code" });
    expect(testState.renderedModelViews.at(-1)).not.toMatchObject({ status: "error" });
    expect(testState.renderedModelViews).not.toContainEqual(
      expect.objectContaining({
        error: "Existing Thread Model is absent from the current Catalog",
      }),
    );
  });

  it("discards a stale catalog when the selected client changes for the same Host", async () => {
    installFakeBrowser();
    let resolveCatalog!: (value: ReturnType<typeof readyInspection>) => void;
    const pendingCatalog = new Promise<ReturnType<typeof readyInspection>>((resolve) => {
      resolveCatalog = resolve;
    });
    let claudeInspections = 0;
    const originalHost = {
      inspectHarness: vi.fn(({ harnessId }: { harnessId: string }) => {
        if (harnessId !== "claude-code") return Promise.resolve(readyInspection());
        claudeInspections += 1;
        return claudeInspections === 1 ? Promise.resolve(readyInspection()) : pendingCatalog;
      }),
      inspectThread: vi.fn(async () => ({
        owner: "external" as const,
        harnessId: "claude-code",
        transportModelId:
          "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
        effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" }),
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        locked: true,
      })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-a",
        usage: null,
        accountCredits: null,
      })),
    };
    const replacementHost = {
      inspectHarness: vi.fn(async () => readyInspection()),
    };
    let selectedHost: typeof originalHost | typeof replacementHost = originalHost;
    const modelControl = {
      currentHostId: () => "host-a",
      clientForHost: vi.fn(() => selectedHost),
      inspectHarness: originalHost.inspectHarness,
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    await vi.waitFor(() => expect(claudeInspections).toBe(2));
    selectedHost = replacementHost;
    resolveCatalog(readyInspection("claude-model-v1.c3RhbGU"));
    await Promise.resolve();
    await Promise.resolve();

    expect(testState.renderedModelViews.at(-1)).not.toMatchObject({ status: "error" });
    expect(testState.renderedModelViews).not.toContainEqual(
      expect.objectContaining({
        error: "Existing Thread Model is absent from the current Catalog",
      }),
    );
  });

  it("loads an external catalog for a draft mounted before the Adapter", async () => {
    installFakeBrowser();
    testState.modelTarget = ["default"];
    const hostA = {
      inspectHarness: vi.fn(async () => readyInspection()),
    };
    const modelControl = {
      currentHostId: () => "host-a",
      clientForHost: vi.fn(() => hostA),
      inspectHarness: hostA.inspectHarness,
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const applyAgent = vi.fn(() => true);
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "claude-code",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      applyAgent,
      modelControl as never,
    );

    expect(applyAgent).toHaveBeenCalledWith(
      "claude-code",
      undefined,
      undefined,
      undefined,
      testState.composer,
    );
    await vi.waitFor(() =>
      expect(testState.renderedModelViews.at(-1)).toMatchObject({ status: "ready" }),
    );
    expect(hostA.inspectHarness).toHaveBeenCalledWith({ harnessId: "claude-code" });
  });

  it("reloads a ready draft catalog when the Composer changes Hosts", async () => {
    installFakeBrowser();
    testState.modelTarget = ["default"];
    let hostId = "local";
    const local = { inspectHarness: vi.fn(async () => readyInspection()) };
    const remoteModelId = "claude-model-v1.c29ubmV0";
    const remote = { inspectHarness: vi.fn(async () => readyInspection(remoteModelId)) };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "claude-code",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      () => true,
      {
        currentHostId: () => hostId,
        clientForHost: (id: string) => (id === "local" ? local : remote),
        subscribeThreadUsage: () => () => undefined,
      } as never,
    );
    await vi.waitFor(() =>
      expect(testState.renderedModelViews.at(-1)).toMatchObject({
        status: "ready",
        selected: readyInspection().catalog.defaultModel,
      }),
    );

    hostId = "remote";
    window.dispatchEvent(new Event("codexhost:draft-prewarm-policy-changed"));
    await vi.waitFor(() =>
      expect(testState.renderedModelViews.at(-1)).toMatchObject({
        status: "ready",
        selected: { id: remoteModelId },
      }),
    );

    hostId = "local";
    window.dispatchEvent(new Event("codexhost:draft-prewarm-policy-changed"));
    await vi.waitFor(() =>
      expect(testState.renderedModelViews.at(-1)).toMatchObject({
        status: "ready",
        selected: readyInspection().catalog.defaultModel,
      }),
    );
  });

  it("reapplies the selected carrier and clears destination prewarm when a draft changes Hosts", async () => {
    installFakeBrowser();
    testState.modelTarget = ["default"];
    let hostId = "local";
    const local = { inspectHarness: vi.fn(async () => readyInspection()) };
    const remote = { inspectHarness: vi.fn(async () => readyInspection()) };
    const applyAgent = vi.fn<(agent: string) => boolean>(() => true);
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "claude-code",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      applyAgent,
      {
        currentHostId: () => hostId,
        clientForHost: (id: string) => (id === "local" ? local : remote),
        subscribeThreadUsage: () => () => undefined,
      } as never,
    );
    await vi.waitFor(() =>
      expect(testState.renderedModelViews.at(-1)).toMatchObject({ status: "ready" }),
    );
    const applicationsBeforeSwitch = applyAgent.mock.calls.length;
    const clearsBeforeSwitch = testState.prewarmClears;

    hostId = "remote";
    window.dispatchEvent(new Event("codexhost:draft-prewarm-policy-changed"));

    await vi.waitFor(() => expect(remote.inspectHarness).toHaveBeenCalled());
    expect(applyAgent.mock.calls.length).toBeGreaterThan(applicationsBeforeSwitch);
    expect(applyAgent.mock.calls.at(-1)?.[0]).toBe("claude-code");
    expect(testState.prewarmClears).toBeGreaterThan(clearsBeforeSwitch);
  });

  it("reloads a same-Host empty Claude catalog on explicit refresh", async () => {
    installFakeBrowser();
    let claudeInspections = 0;
    const hostA = {
      inspectHarness: vi.fn(({ harnessId }: { harnessId: string }) => {
        if (harnessId !== "claude-code") return Promise.resolve(readyInspection());
        claudeInspections += 1;
        return Promise.resolve(claudeInspections === 2 ? emptyInspection() : readyInspection());
      }),
      inspectThread: vi.fn(async () => ({
        owner: "external" as const,
        harnessId: "claude-code",
        transportModelId:
          "codexhost/claude-code-native@claude-model-v1.b3B1cw@bypassPermissions@auto",
        effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.b3B1cw" }),
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
        locked: true,
      })),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(async () => ({
        threadId: "thread-a",
        usage: null,
        accountCredits: null,
      })),
    };
    const local = { inspectHarness: vi.fn(async () => readyInspection()) };
    const modelControl = {
      currentHostId: () => "host-a",
      clientForHost: vi.fn((hostId: string) => (hostId === "host-a" ? hostA : local)),
      inspectHarness: local.inspectHarness,
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    await vi.waitFor(() => {
      expect(testState.renderedModelViews.at(-1)).toMatchObject({ status: "empty" });
    });
    expect(claudeInspections).toBe(2);
    const preventDefault = vi.fn();
    const stopImmediatePropagation = vi.fn();
    testState.documentListeners.get("submit")?.({
      target: testState.composer,
      preventDefault,
      stopImmediatePropagation,
    } as unknown as Event);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopImmediatePropagation).toHaveBeenCalledOnce();

    await testState.getConnectionDiagnostics?.()?.refresh();
    await vi.waitFor(() => expect(claudeInspections).toBeGreaterThan(2));
    const inspectionsAfterRefresh = claudeInspections;
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(claudeInspections).toBe(inspectionsAfterRefresh);
    expect(testState.renderedModelViews.at(-1)).toMatchObject({
      status: "ready",
      catalog: readyInspection().catalog,
    });
    expect(testState.renderedModelViews).not.toContainEqual(
      expect.objectContaining({ status: "error" }),
    );
  });
});

describe("Renderer connection diagnostics snapshot", () => {
  const localHost = () => {
    const diagnostics = testState.getConnectionDiagnostics?.();
    if (!diagnostics) throw new Error("connection diagnostics were not installed");
    const host = (
      diagnostics as unknown as {
        snapshot(): { hosts: Array<Record<string, unknown>> };
      }
    )
      .snapshot()
      .hosts.find((candidate) => candidate.hostId === "local");
    if (!host) throw new Error("local Host is missing from the snapshot");
    return host as unknown as {
      connection: string;
      diagnostic: string | null;
      agents: Array<{ availability: string; error: unknown }>;
    };
  };

  it("reports an attached bridge as connected with no diagnostic", async () => {
    installFakeBrowser();
    const modelControl = {
      currentHostId: () => "local",
      clientForHost: vi.fn(() => ({ inspectHarness: vi.fn(async () => readyInspection()) })),
      inspectHarness: vi.fn(async () => readyInspection()),
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    await vi.waitFor(() => expect(localHost().connection).toBe("connected"));
    expect(localHost().diagnostic).toBeNull();
  });

  it("reports a never-attached bridge as connecting and invents no Agent error", async () => {
    installFakeBrowser();
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      null,
    );

    const host = localHost();
    // Never connected, so this is a start-up wait rather than a failure.
    expect(host.connection).toBe("connecting");
    expect(host.diagnostic).toContain("has not attached a Renderer control bridge");
    // The regression this whole path exists for: no Agent is blamed.
    expect(host.agents.length).toBeGreaterThan(0);
    for (const agent of host.agents) {
      expect(agent.error).toBeNull();
      expect(agent.availability).not.toBe("error");
    }
  });

  it("distinguishes an attached bridge that does not know the Host", async () => {
    installFakeBrowser();
    const modelControl = {
      currentHostId: () => "someone-else",
      clientForHost: vi.fn(() => undefined),
      inspectHarness: vi.fn(async () => readyInspection()),
      inspectThread: vi.fn(),
      inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
      inspectThreadUsage: vi.fn(),
      subscribeThreadUsage: () => () => undefined,
    };
    const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
    const probe = installRendererBindingProbe({
      enabledAgents: ["codex", "claude-code"],
      defaultAgent: "codex",
    });
    probe.setAdapter(
      { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      undefined,
      undefined,
      modelControl as never,
    );

    await vi.waitFor(() => expect(localHost().diagnostic).toContain("no client registered"));
    expect(localHost().diagnostic).not.toContain("has not attached");
  });

  it("keeps inspecting a Host that starts after the start-up burst", async () => {
    vi.useFakeTimers();
    try {
      installFakeBrowser();
      const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
      const probe = installRendererBindingProbe({
        enabledAgents: ["codex", "claude-code"],
        defaultAgent: "codex",
      });

      // A bridge attached but not yet knowing this Host. setAdapter is called
      // exactly once, so nothing but the retry can drive an inspection.
      const inspectHarness = vi.fn(async () => readyInspection());
      let registered: unknown = undefined;
      const modelControl = {
        currentHostId: () => (registered ? "local" : "someone-else"),
        clientForHost: vi.fn(() => registered),
        inspectHarness,
        inspectThread: vi.fn(),
        inspectThreadCommands: vi.fn(async () => ({ commands: [] })),
        inspectThreadUsage: vi.fn(),
        subscribeThreadUsage: () => () => undefined,
      };
      probe.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
        undefined,
        undefined,
        modelControl as never,
      );
      expect(localHost().connection).toBe("connecting");

      // inspectHarness is shared with Model-catalog loading, so the absolute
      // call count is not the signal. Availability state is: nothing but an
      // availability inspection can move it off "checking".
      const settling = inspectHarness.mock.calls.length;
      expect(localHost().agents.every((agent) => agent.availability === "checking")).toBe(true);

      // Well past the 15.5s start-up burst, where the old schedule gave up.
      await vi.advanceTimersByTimeAsync(30_000 * 3);
      expect(inspectHarness.mock.calls.length).toBe(settling);
      expect(localHost().agents.every((agent) => agent.availability === "checking")).toBe(true);

      // The Host finishes coming up. Nobody presses refresh: the heartbeat has
      // to be the thing that notices.
      registered = { inspectHarness };
      await vi.advanceTimersByTimeAsync(30_000);

      expect(inspectHarness.mock.calls.length).toBeGreaterThan(settling);
      await vi.waitFor(() => expect(localHost().connection).toBe("connected"));
      expect(localHost().agents.every((agent) => agent.availability === "ready")).toBe(true);
      expect(localHost().diagnostic).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops re-checking once the probe is disposed", async () => {
    vi.useFakeTimers();
    try {
      installFakeBrowser();
      const { installRendererBindingProbe } = await import("../src/renderer-binding-probe.js");
      const probe = installRendererBindingProbe({
        enabledAgents: ["codex", "claude-code"],
        defaultAgent: "codex",
      });
      probe.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
        undefined,
        undefined,
        null,
      );

      await vi.advanceTimersByTimeAsync(500);
      expect(localHost().connection).toBe("connecting");

      probe.dispose();
      // Disposal drops the diagnostics handle, so nothing can observe a late
      // bridge arriving after the probe is gone.
      expect(testState.getConnectionDiagnostics?.()).toBeNull();
      await vi.advanceTimersByTimeAsync(30_000 * 5);
      expect(testState.getConnectionDiagnostics?.()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
