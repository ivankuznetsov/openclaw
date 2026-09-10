/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { captureHandoffAccess } from "./handoff-access.ts";
import { HandoffHttpClient } from "./handoff-http-client.ts";
import { mountHandoffLinkPage } from "./handoff-link-page.ts";

const token = "a".repeat(43);
const handoff = {
  handoff: {
    id: "test",
    state: "waiting",
    generation: 1,
    hostname: "example.test",
    expiresAtMs: Date.now() + 60000,
    browser: { target: "host", profile: "openclaw", targetId: "tab" },
  },
};

afterEach(() => {
  document.body.replaceChildren();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

function openLink() {
  history.replaceState(null, "", `/custom/focus/browser/test#handoffToken=${token}`);
  return captureHandoffAccess()!;
}

function mockEndpoint() {
  return vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    if (body.action === "redeem") {
      return new Response(
        JSON.stringify({ controllerId: "server", expiresAtMs: Date.now() + 60000 }),
      );
    }
    if (body.action === "browser") {
      return new Response(JSON.stringify({ wsPath: "/browser/stream" }));
    }
    return new Response(JSON.stringify(handoff));
  });
}

describe("scoped handoff links", () => {
  it("removes the capability from history, survives reload, and redeems only after Take control", async () => {
    const fetchMock = mockEndpoint();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "WebSocket",
      class extends EventTarget {
        close() {}
      },
    );
    const access = openLink();
    expect(location.hash).toBe("");
    expect(captureHandoffAccess()?.token).toBe(token);
    mountHandoffLinkPage(document.body, access);
    const page = document.body.firstElementChild!;
    await waitForFast(() => expect(page.shadowRoot?.querySelector("button")).not.toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(page.shadowRoot?.textContent).not.toContain("Gateway secret");
    page.shadowRoot!.querySelector("button")!.click();
    await waitForFast(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => JSON.parse(init.body as string).action === "claim"),
      ).toBe(true),
    );
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) {
      throw new Error("expected handoff redemption request");
    }
    const [url, init] = firstCall;
    expect(url).toBe(`${location.origin}/custom/browser/handoff/test`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ action: "redeem", token });
    expect(body.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.parse(sessionStorage.getItem(access.storageKey)!)).toEqual({
      sessionToken: body.sessionToken,
    });
    expect(captureHandoffAccess()?.sessionToken).toBe(body.sessionToken);
    expect(init.credentials).toBe("omit");
  });

  it("retains the generated session before redemption and recovers a lost response without consuming the link again", async () => {
    const access = openLink();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.action === "redeem") {
        expect(JSON.parse(sessionStorage.getItem(access.storageKey)!)).toMatchObject({
          sessionToken: body.sessionToken,
        });
        throw new Error("Network lost");
      }
      return new Response(JSON.stringify(handoff));
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(new HandoffHttpClient(access).activate()).rejects.toThrow("Check your connection");
    await new HandoffHttpClient(captureHandoffAccess()!).activate();
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string).action)).toEqual([
      "redeem",
      "get",
    ]);
  });

  it("limits authenticated requests to the handoff endpoint and supports leave then reclaim", async () => {
    const fetchMock = mockEndpoint();
    vi.stubGlobal("fetch", fetchMock);
    const access = openLink();
    const client = new HandoffHttpClient(access);
    await client.activate();
    for (const action of ["claim", "leave", "claim", "browser", "complete", "cancel", "renew"]) {
      await client.request(`browser.handoff.${action}`, {
        id: "another",
        controllerId: "other",
        generation: 2,
      });
    }
    for (const [url, init] of fetchMock.mock.calls.slice(1)) {
      expect(url).toBe(`${location.origin}/custom/browser/handoff/test`);
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${access.sessionToken}` });
      expect(JSON.parse(init.body as string)).not.toHaveProperty("id");
      expect(JSON.parse(init.body as string)).not.toHaveProperty("controllerId");
    }
    await client.request("browser.handoff.browser", {
      operation: "act",
      action: { kind: "press", key: "Enter" },
      generation: 2,
    });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string)).toEqual({
      action: "browser",
      operation: "act",
      input: { kind: "press", key: "Enter" },
      generation: 2,
    });
    const count = fetchMock.mock.calls.length;
    await expect(client.request("config.get")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it.each([401, 403, 410])("shows a safe expired/used link error for HTTP %s", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: token }), { status })),
    );
    mountHandoffLinkPage(document.body, openLink());
    const page = document.body.firstElementChild!;
    await waitForFast(() => expect(page.shadowRoot?.querySelector("button")).not.toBeNull());
    page.shadowRoot!.querySelector("button")!.click();
    await waitForFast(() =>
      expect(page.shadowRoot?.textContent).toContain("Ask your agent for a new handoff link"),
    );
    expect(page.shadowRoot?.textContent).not.toContain(token);
    expect(page.shadowRoot?.textContent).not.toContain("Gateway secret");
  });
});
