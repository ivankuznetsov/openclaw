import type {
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "./plugin-registration.js";

const mocks = vi.hoisted(() => ({
  createBrowserTool: vi.fn(),
  cancel: vi.fn(async () => undefined),
}));
vi.mock("./register.runtime.js", () => ({ createBrowserTool: mocks.createBrowserTool }));
vi.mock("./src/browser/session-tab-store.js", () => ({
  initializeBrowserSessionTabStore: vi.fn(),
}));
vi.mock("./src/browser/system-profile-import-state.js", () => ({
  configureSystemProfileImportStateStore: vi.fn(),
}));
vi.mock("./src/human-intervention/coordinator.js", () => ({
  resolveHumanInterventionBasePath: () => "",
  HumanInterventionCoordinator: class {
    cancel = mocks.cancel;
  },
}));

function context(): OpenClawPluginToolContext {
  return {
    agentId: "main",
    sessionKey: "agent:main:telegram:direct:42",
    requesterSenderId: "42",
    senderIsOwner: true,
    chatType: "direct",
    deliveryContext: { channel: "telegram", to: "42" },
    delivery: { send: vi.fn(async () => undefined) },
    yieldTurn: vi.fn(async () => undefined),
    config: {
      browser: { humanIntervention: { enabled: true } },
      gateway: { publicOrigin: "https://gateway.example" },
    },
  };
}

function registeredTool(ctx: OpenClawPluginToolContext) {
  let factory: OpenClawPluginToolFactory | undefined;
  registerBrowserPlugin(
    createTestPluginApi({
      runtime: {
        config: {},
        state: { openKeyedStore: vi.fn(() => ({ update: vi.fn() })) },
      } as never,
      registerTool(tool) {
        if (typeof tool === "function") {
          factory = tool;
        }
      },
    }),
  );
  const tool = factory?.(ctx);
  if (!tool || Array.isArray(tool)) {
    throw new Error("expected browser tool");
  }
  return tool;
}

describe("browser handoff delivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delivers the scoped link before yielding even after a progress message", async () => {
    const ctx = context();
    await ctx.delivery!.send({ text: "Checking the page…" });
    let delivered!: () => void;
    vi.mocked(ctx.delivery!.send).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          delivered = resolve;
        }),
    );
    const tool = registeredTool(ctx);
    mocks.createBrowserTool.mockImplementation((options) => ({
      execute: () =>
        options.humanIntervention.waitForHuman({
          id: "handoff-1",
          hostname: "example.com",
          reason: "Complete the CAPTCHA",
          launchUrl: "https://gateway.example/focus/browser/handoff-1#handoffToken=private-link",
          handoffOwner: "browser_human_intervention:test",
        }),
    }));
    const pending = tool.execute("test", { action: "handoff" });
    await vi.waitFor(() => expect(delivered).toBeTypeOf("function"));
    expect(ctx.yieldTurn).not.toHaveBeenCalled();
    delivered();
    await pending;
    expect(ctx.delivery!.send).toHaveBeenCalledTimes(2);
    expect(ctx.delivery!.send).toHaveBeenLastCalledWith({
      text: expect.stringContaining("#handoffToken=private-link"),
    });
    expect(ctx.yieldTurn).toHaveBeenCalledWith({
      handoffOwner: "browser_human_intervention:test",
      message: "Waiting for human browser intervention handoff-1.",
    });
  });

  it("cancels the reservation when notification delivery fails", async () => {
    const ctx = context();
    vi.mocked(ctx.delivery!.send).mockRejectedValueOnce(new Error("delivery failed"));
    mocks.createBrowserTool.mockImplementation((options) => ({
      execute: () =>
        options.humanIntervention.waitForHuman({
          id: "handoff-1",
          hostname: "example.com",
          reason: "CAPTCHA",
          launchUrl: "https://gateway.example/link",
          handoffOwner: "test",
        }),
    }));
    await expect(registeredTool(ctx).execute("test", { action: "handoff" })).rejects.toThrow(
      "delivery failed",
    );
    expect(mocks.cancel).toHaveBeenCalledWith("handoff-1");
    expect(ctx.yieldTurn).not.toHaveBeenCalled();
  });

  it("does not advertise handoff without current-route delivery", () => {
    const ctx = context();
    ctx.delivery = undefined;
    expect(registeredTool(ctx).description).not.toContain("action=handoff");
  });
});
