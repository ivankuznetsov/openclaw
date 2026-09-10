import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserDispatchRequest } from "../browser/routes/dispatcher.js";
import { HumanInterventionCoordinator } from "./coordinator.js";
import { createHumanInterventionHttpHandler } from "./http.js";
import { HumanInterventionService, type HumanInterventionRecord } from "./service.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});
async function setup(basePath = "") {
  const records = new Map<string, HumanInterventionRecord>();
  const store: PluginStateKeyedStore<HumanInterventionRecord> = {
    async register(key, value) {
      records.set(key, structuredClone(value));
    },
    async registerIfAbsent(key, value) {
      if (records.has(key)) {
        return false;
      }
      records.set(key, structuredClone(value));
      return true;
    },
    async lookupMany(keys) {
      return keys.map((key) => ({ ok: true as const, value: records.get(key) }));
    },
    async deleteIf(key, predicate) {
      const current = records.get(key);
      return current !== undefined && predicate(current) ? records.delete(key) : false;
    },
    async consume(key) {
      const value = records.get(key);
      records.delete(key);
      return value;
    },
    async delete(key) {
      return records.delete(key);
    },
    async clear() {
      records.clear();
    },
    lookup: async (key: string) => records.get(key),
    entries: async () => [...records].map(([key, value]) => ({ key, value, createdAt: 0 })),
    update: async (
      key: string,
      update: (value: HumanInterventionRecord | undefined) => HumanInterventionRecord | undefined,
    ) => {
      const value = update(records.get(key));
      if (!value) {
        return false;
      }
      records.set(key, value);
      return true;
    },
  };
  const service = new HumanInterventionService(store);
  const scheduleContinuation = vi.fn<
    OpenClawPluginApi["session"]["workflow"]["scheduleSessionTurn"]
  >(async (params) => ({
    id: "continuation",
    pluginId: "browser",
    sessionKey: params.sessionKey,
    kind: "session-turn",
  }));
  const coordinator = new HumanInterventionCoordinator(service, {
    publicUrl: "https://claw.example",
    scheduleContinuation,
  });
  let enabled = true;
  const dispatchBrowser = vi.fn(async (_request: BrowserDispatchRequest) => ({
    status: 200,
    body:
      _request.path === "/screencast"
        ? { wsPath: "/browser/screencast?token=synthetic" }
        : { ok: true },
  }));
  const handler = createHumanInterventionHttpHandler({
    coordinator,
    isEnabled: () => enabled,
    publicOrigin: () => "https://claw.example",
    dispatchBrowser,
    basePath,
  });
  const server: Server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => {
    handler.dispose();
    coordinator.stop();
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${basePath}`;
  async function create(profile = "openclaw") {
    const record = await service.request({
      agentId: "main",
      sessionKey: "session",
      owner: { channel: "telegram", accountId: "default", senderId: "42" },
      origin: { channel: "telegram", to: "42" },
      browser: { target: "host", profile, targetId: `${profile}-tab` },
      reason: "test",
      hostname: "example.com",
    });
    return { record, link: await service.issueViewerLink(record.id) };
  }
  async function post(id: string, body: unknown, token?: string, origin = "https://claw.example") {
    return fetch(`${base}/browser/handoff/${id}`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }
  return {
    create,
    post,
    base,
    service,
    dispatchBrowser,
    scheduleContinuation,
    records,
    disable: () => {
      enabled = false;
    },
  };
}

describe("scoped handoff HTTP", () => {
  it.each(["", "/custom"])("keeps previews inert and redeems once under %s", async (basePath) => {
    const env = await setup(basePath);
    const { record, link } = await env.create();
    const token = randomBytes(32).toString("base64url");
    const preview = await fetch(`${env.base}/browser/handoff/${record.id}`);
    expect(preview.status).toBe(405);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(
      (await env.post(record.id, { action: "redeem", token: link.token, sessionToken: token }))
        .status,
    ).toBe(200);
    expect(
      (await env.post(record.id, { action: "redeem", token: link.token, sessionToken: token }))
        .status,
    ).toBe(403);
    const other = await env.create("other");
    expect((await env.post(other.record.id, { action: "get" }, token)).status).toBe(403);
    expect(
      (await env.post(record.id, { action: "config.set", value: "forbidden" }, token)).status,
    ).toBe(403);
    expect(
      (await env.post(record.id, { action: "get" }, token, "https://evil.example")).status,
    ).toBe(403);
  });

  it.each(["", "/custom"])("fixes scope and revokes input under %s", async (basePath) => {
    const env = await setup(basePath);
    const { record, link } = await env.create();
    const token = randomBytes(32).toString("base64url");
    await env.post(record.id, { action: "redeem", token: link.token, sessionToken: token });
    const claim = await env.post(record.id, { action: "claim", controllerId: "attacker" }, token);
    const { handoff } = await claim.json();
    expect((await env.service.get(record.id)).controllerId).not.toBe("attacker");
    const browser = {
      action: "browser",
      generation: handoff.generation,
      operation: "act",
      input: { kind: "type", text: "hello", targetId: "other-tab", selector: "body" },
      profile: "other",
      targetId: "other-tab",
    };
    expect((await env.post(record.id, browser, token)).status).toBe(200);
    expect(env.dispatchBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/act",
        query: { profile: "openclaw" },
        body: expect.objectContaining({ targetId: "openclaw-tab", selector: ":focus" }),
      }),
    );
    expect(
      (await env.post(record.id, { ...browser, input: { kind: "evaluate", fn: "evil" } }, token))
        .status,
    ).toBe(403);
    expect((await env.post(record.id, { ...browser, operation: "navigate" }, token)).status).toBe(
      403,
    );
    const stream = await env.post(record.id, { ...browser, operation: "screencast" }, token);
    expect(stream.status).toBe(200);
    expect(await stream.json()).toEqual({
      wsPath: `${basePath}/browser/screencast?token=synthetic`,
    });
    const dispatched = env.dispatchBrowser.mock.calls.at(-1)![0] as {
      requester: { signal: AbortSignal };
    };
    expect(dispatched.requester.signal.aborted).toBe(false);
    expect(
      (await env.post(record.id, { action: "complete", generation: handoff.generation }, token))
        .status,
    ).toBe(200);
    expect(dispatched.requester.signal.aborted).toBe(true);
    expect((await env.post(record.id, browser, token)).status).toBe(403);
    expect((await env.post(record.id, { action: "get" }, token)).status).toBe(200);
  });

  it("rejects oversized bodies and feature-disabled requests", async () => {
    const env = await setup();
    const { record, link } = await env.create();
    expect(
      (await env.post(record.id, { action: "redeem", token: "x".repeat(70_000) })).status,
    ).toBe(403);
    env.disable();
    expect(
      (
        await env.post(record.id, {
          action: "redeem",
          token: link.token,
          sessionToken: randomBytes(32).toString("base64url"),
        })
      ).status,
    ).toBe(403);
  });

  it("rejects expired sessions and aborts streams when the feature is disabled", async () => {
    const env = await setup();
    const { record, link } = await env.create();
    const token = randomBytes(32).toString("base64url");
    await env.post(record.id, { action: "redeem", token: link.token, sessionToken: token });
    const { handoff } = await (await env.post(record.id, { action: "claim" }, token)).json();
    await env.post(
      record.id,
      { action: "browser", operation: "screencast", generation: handoff.generation },
      token,
    );
    const signal = env.dispatchBrowser.mock.calls.at(-1)![0].requester!.signal;
    env.disable();
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 2_000 });

    const other = await setup();
    const pending = await other.create();
    await other.post(pending.record.id, {
      action: "redeem",
      token: pending.link.token,
      sessionToken: token,
    });
    const current = other.records.get("host:openclaw")!;
    other.records.set("host:openclaw", { ...current, expiresAtMs: Date.now() - 1 });
    expect((await other.post(pending.record.id, { action: "get" }, token)).status).toBe(403);
    expect((await other.post(pending.record.id, { action: "claim" }, token)).status).toBe(403);
  });
});
