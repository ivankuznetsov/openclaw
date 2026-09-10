import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { getBrowserStateRuntime, setBrowserStateRuntime } from "../browser-runtime-state.js";
import { HumanInterventionCoordinator } from "../human-intervention/coordinator.js";
import {
  HumanInterventionService,
  type HumanInterventionRecord,
} from "../human-intervention/service.js";
import { useSessionTabSqliteFixture } from "./session-tab-registry.sqlite-fixture.test-helpers.js";
import { durableOwnership as ownership } from "./session-tab-registry.sqlite.test-helpers.js";

describe("handoff protection during session tab cleanup", () => {
  const { openStore, freshRegistry } = useSessionTabSqliteFixture();

  function createCleanupCoordinator() {
    const service = new HumanInterventionService(
      createPluginStateKeyedStoreForTests<HumanInterventionRecord>("browser", {
        namespace: "browser.human-intervention",
        maxEntries: 1_000,
        overflowPolicy: "reject-new",
      }),
      { now: () => 10_000 },
    );
    const coordinator = new HumanInterventionCoordinator(service, {
      publicUrl: "https://gateway.example",
      scheduleContinuation: vi.fn(),
      now: () => 10_000,
    });
    setBrowserStateRuntime({
      ...getBrowserStateRuntime(),
      tabCleanupGate: { acquire: (browser) => coordinator.beginTabCleanup(browser) },
    });
    return { coordinator, service };
  }

  it("drains an in-flight cleanup before creating a handoff reservation", async () => {
    const registry = await freshRegistry("handoff-cleanup-race");
    const { coordinator } = createCleanupCoordinator();
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NATIVE-HANDOFF",
      profile: "remote",
      ownership: ownership("NATIVE-HANDOFF"),
      now: 1_000,
    });
    let started!: () => void;
    let finish!: () => void;
    const closing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const drain = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const sweep = registry.sweepTrackedBrowserTabs({
      now: 10_000,
      idleMs: 1,
      closeDurableTab: async () => {
        started();
        await drain;
        return { status: "cancelled" };
      },
    });
    await closing;
    const resolveTab = vi.fn(async () => ({ targetId: "NATIVE-HANDOFF", hostname: "example.com" }));
    const request = coordinator.request(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        senderIsOwner: true,
        requesterSenderId: "42",
        deliveryContext: { channel: "telegram", to: "42" },
      },
      { profile: "remote", targetId: "NATIVE-HANDOFF", reason: "Sign in", resolveTab },
    );
    // Let the request reach the reservation boundary while CDP preparation waits.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      expect(resolveTab).not.toHaveBeenCalled();
    } finally {
      finish();
      await sweep;
    }
    const { record } = await request;
    expect(resolveTab).toHaveBeenCalledOnce();
    expect(record.state).toBe("waiting");
  });

  it("protects a persisted handoff from idle and cap cleanup until cancellation", async () => {
    const registry = await freshRegistry("handoff-cleanup-persisted");
    const { service } = createCleanupCoordinator();
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NATIVE-HANDOFF",
      profile: "remote",
      ownership: ownership("NATIVE-HANDOFF"),
      now: 1_000,
    });
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NATIVE-OTHER",
      profile: "remote",
      ownership: ownership("NATIVE-OTHER"),
      now: 9_000,
    });
    const record = await service.request({
      agentId: "main",
      sessionKey: "agent:main:main",
      owner: { channel: "telegram", accountId: "default", senderId: "42" },
      origin: { channel: "telegram", to: "42" },
      browser: { target: "host", profile: "remote", targetId: "NATIVE-HANDOFF" },
      reason: "Sign in",
      hostname: "example.com",
    });
    // Recreate the lifecycle owner against the same SQLite store, as on restart.
    const restarted = createCleanupCoordinator();
    const closeDurableTab = vi.fn(async () => ({ status: "closed" as const }));
    for (const selection of [{ idleMs: 1 }, { maxTabsPerSession: 1 }]) {
      expect(
        await registry.sweepTrackedBrowserTabs({
          now: 10_000,
          ...selection,
          closeDurableTab,
        }),
      ).toBe(0);
    }
    expect(closeDurableTab).not.toHaveBeenCalled();
    expect(openStore().entries()).toHaveLength(2);
    await restarted.service.cancel(record.id);
    expect(
      await registry.sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1, closeDurableTab }),
    ).toBe(2);
    expect(closeDurableTab).toHaveBeenCalledTimes(2);
    expect(openStore().entries()).toHaveLength(0);
  });
});
