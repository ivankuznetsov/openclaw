import type { HumanInterventionResponse, HumanInterventionState } from "@openclaw/gateway-protocol";
/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { resolveHumanBrowserPoint } from "./human-intervention-input.ts";
import type { OpenClawHumanInterventionPanel } from "./human-intervention-panel.ts";
import "./human-intervention-panel.ts";

class TestSocket extends EventTarget {
  binaryType = "";
  close = vi.fn();
}

function screencastFrame(url: string): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify({ url, cssWidth: 1000, cssHeight: 800 }));
  const packet = new Uint8Array(4 + header.byteLength + 1);
  new DataView(packet.buffer).setUint32(0, header.byteLength);
  packet.set(header, 4);
  return packet.buffer;
}

function handoff(
  state: HumanInterventionState = "waiting",
  generation = 1,
): HumanInterventionResponse {
  return {
    handoff: {
      id: "handoff-1",
      state,
      generation,
      reason: "Complete the verification challenge",
      hostname: "accounts.example",
      expiresAtMs: Date.now() + 60_000,
      browser: { target: "host", profile: "openclaw", targetId: "tab-1" },
    },
  };
}

function stubWebSockets() {
  const sockets: TestSocket[] = [];
  const createSocket = vi.fn(function () {
    const socket = new TestSocket();
    sockets.push(socket);
    return socket;
  });
  vi.stubGlobal("WebSocket", createSocket);
  return { sockets, createSocket };
}

function createClient() {
  const request = vi.fn(
    async (
      method: string,
      _params?: unknown,
    ): Promise<
      HumanInterventionResponse | { wsPath: string } | { ok: true; focusedEditable?: boolean }
    > => {
      if (method === "browser.handoff.get") {
        return handoff();
      }
      if (method === "browser.handoff.claim") {
        return handoff("control", 2);
      }
      if (method === "browser.handoff.browser") {
        return { wsPath: "/browser/stream" };
      }
      if (method === "browser.handoff.complete") {
        return handoff("resumed", 3);
      }
      return handoff("control", 2);
    },
  );
  return {
    request,
    client: { request, gatewayUrl: "ws://gateway.test" } as unknown as GatewayBrowserClient,
  };
}

async function mountPanel(client: GatewayBrowserClient) {
  const panel = document.createElement(
    "openclaw-human-intervention-panel",
  ) as OpenClawHumanInterventionPanel;
  panel.client = client;
  panel.available = true;
  panel.handoffId = "handoff-1";
  document.body.append(panel);
  await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("accounts.example"));
  return panel;
}

async function mountReadyPanel() {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:frame");
      static override revokeObjectURL = vi.fn();
    },
  );
  const { sockets } = stubWebSockets();
  const { client, request } = createClient();
  const panel = await mountPanel(client);
  panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
  await waitForFast(() => expect(sockets).toHaveLength(1));
  sockets[0]?.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "ready",
        targetId: "tab-1",
        url: "https://accounts.example/challenge",
        title: "Challenge",
      }),
    }),
  );
  sockets[0]?.dispatchEvent(
    new MessageEvent("message", {
      data: screencastFrame("https://accounts.example/challenge"),
    }),
  );
  await waitForFast(() =>
    expect(panel.shadowRoot?.querySelector<HTMLTextAreaElement>(".canvas-keyboard")?.disabled).toBe(
      false,
    ),
  );

  const frame = panel.shadowRoot!.querySelector<HTMLImageElement>(".frame")!;
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
  return { panel, request, sockets };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("human browser intervention panel", () => {
  it.each([
    ["resume_pending", "waiting to be queued"],
    ["resumed", "queued to continue"],
  ] as const)("reports %s without claiming that execution has started", async (state, message) => {
    const { client, request } = createClient();
    request.mockResolvedValueOnce(handoff(state, 3));
    const panel = await mountPanel(client);
    expect(panel.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain(message);
  });

  it("refreshes a pending continuation without reclaiming browser control", async () => {
    const { client, request } = createClient();
    request.mockResolvedValueOnce(handoff("resume_pending", 3));
    const panel = await mountPanel(client);
    request.mockResolvedValueOnce(handoff("resumed", 3));
    const refresh = panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-refresh-status]");
    expect(refresh).not.toBeNull();
    refresh!.click();
    await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("queued to continue"));
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "browser.handoff.get",
      "browser.handoff.get",
    ]);
    expect(panel.shadowRoot?.querySelector("[data-refresh-status]")).toBeNull();
  });

  it("does not acquire local control when another device rejects the claim", async () => {
    const { client, request } = createClient();
    request.mockResolvedValueOnce(handoff("control", 2));
    const panel = await mountPanel(client);
    request.mockRejectedValueOnce(new Error("controlled elsewhere"));
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() =>
      expect(panel.shadowRoot?.textContent).toContain("controlled elsewhere"),
    );
    expect(panel.shadowRoot?.querySelector("[data-complete]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "browser.handoff.leave")).toBe(false);
  });

  it("discards a stream ticket that arrives after the panel disconnects", async () => {
    const { createSocket: socketConstructor } = stubWebSockets();
    const { client, request } = createClient();
    const panel = await mountPanel(client);
    request.mockResolvedValueOnce(handoff("control", 2));
    let resolveTicket!: (value: { wsPath: string }) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTicket = resolve;
        }),
    );
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() => expect(resolveTicket).toBeTypeOf("function"));
    panel.remove();
    resolveTicket({ wsPath: "/browser/stream" });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(socketConstructor).not.toHaveBeenCalled();
  });

  it("reloads status when the authenticated client changes at the same URL", async () => {
    const first = createClient();
    const panel = await mountPanel(first.client);
    const second = createClient();
    panel.client = second.client;
    await waitForFast(() =>
      expect(second.request).toHaveBeenCalledWith("browser.handoff.get", { id: "handoff-1" }),
    );
  });

  it("ignores a renewal response after completion retires control", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    stubWebSockets();
    const { client, request } = createClient();
    const panel = await mountPanel(client);
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector("[data-complete]")).not.toBeNull(),
    );
    let resolveRenewal!: (value: HumanInterventionResponse) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRenewal = resolve;
        }),
    );
    const renew = intervals.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
    expect(renew).toBeTypeOf("function");
    if (typeof renew === "function") {
      renew();
    }
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-complete]")?.click();
    await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("return to your chat"));
    resolveRenewal(handoff("control", 2));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(panel.shadowRoot?.textContent).toContain("return to your chat");
    expect(panel.shadowRoot?.querySelector("[data-complete]")).toBeNull();
  });

  it("uses a new controller identity after the authenticated connection changes", async () => {
    stubWebSockets();
    const first = createClient();
    const panel = await mountPanel(first.client);
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector("[data-complete]")).not.toBeNull(),
    );
    const second = createClient();
    panel.client = second.client;
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector("[data-take-control]")).not.toBeNull(),
    );
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector("[data-complete]")).not.toBeNull(),
    );
    const firstClaim = first.request.mock.calls.find(
      ([method]) => method === "browser.handoff.claim",
    );
    const secondClaim = second.request.mock.calls.find(
      ([method]) => method === "browser.handoff.claim",
    );
    expect(firstClaim).toBeDefined();
    expect(secondClaim).toBeDefined();
    expect(secondClaim).not.toEqual(firstClaim);
  });

  it("maps displayed image coordinates to the unchanged remote viewport", () => {
    expect(
      resolveHumanBrowserPoint(
        { clientX: 260, clientY: 220 },
        { left: 10, top: 20, width: 500, height: 400 },
        { width: 1000, height: 800 },
      ),
    ).toEqual({ x: 500, y: 400 });
  });

  it("claims the exact handoff, opens its scoped stream, and completes with the lease fence", async () => {
    const { sockets } = stubWebSockets();
    const { client, request } = createClient();
    const panel = await mountPanel(client);

    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("browser.handoff.browser", {
        id: "handoff-1",
        controllerId: expect.any(String),
        generation: 2,
        operation: "screencast",
        maxWidth: 2000,
        maxHeight: 2000,
      }),
    );
    expect(sockets).toHaveLength(1);
    expect(panel.shadowRoot?.querySelector<HTMLTextAreaElement>(".canvas-keyboard")?.disabled).toBe(
      true,
    );

    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-complete]")?.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("browser.handoff.complete", {
        id: "handoff-1",
        controllerId: expect.any(String),
        generation: 2,
      }),
    );
    await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("return to your chat"));
  });

  it("releases control when the viewer closes without resuming the paused agent", async () => {
    stubWebSockets();
    const { client, request } = createClient();
    const panel = await mountPanel(client);
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("You have control"));

    panel.remove();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("browser.handoff.leave", {
        id: "handoff-1",
        controllerId: expect.any(String),
        generation: 2,
      }),
    );
    expect(request.mock.calls.some(([method]) => method === "browser.handoff.complete")).toBe(
      false,
    );
  });

  it("renews control while the browser stream remains open", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    stubWebSockets();
    const { client, request } = createClient();
    const panel = await mountPanel(client);
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-take-control]")?.click();
    await waitForFast(() =>
      expect(request.mock.calls.some(([method]) => method === "browser.handoff.browser")).toBe(
        true,
      ),
    );
    const renewalCall = setIntervalSpy.mock.calls.find(([, delay]) => delay === 30_000);
    const renewalTimer = setIntervalSpy.mock.results.at(-1)?.value;

    expect(clearIntervalSpy).not.toHaveBeenCalledWith(renewalTimer);
    expect(renewalCall).toBeDefined();
    const renew = renewalCall?.[0];
    if (typeof renew === "function") {
      renew();
    }

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("browser.handoff.renew", {
        id: "handoff-1",
        controllerId: expect.any(String),
        generation: 2,
      }),
    );
  });

  it("forwards incremental text, composed text, deletion and modified keys in order", async () => {
    const { panel, request } = await mountReadyPanel();
    request.mockClear();
    const input = panel.shadowRoot!.querySelector<HTMLTextAreaElement>(".canvas-keyboard")!;
    for (const text of ["a", "b"]) {
      input.value = text;
      input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text }));
    }
    input.value = "文";
    input.dispatchEvent(new InputEvent("input", { isComposing: true }));
    input.dispatchEvent(new CompositionEvent("compositionend", { data: "文" }));
    input.dispatchEvent(new InputEvent("input", { inputType: "insertCompositionText" }));
    input.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "deleteContentBackward", cancelable: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true, cancelable: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(6));
    expect(request.mock.calls.map((call) => call[1])).toEqual(
      [
        { kind: "insertText", text: "a" },
        { kind: "insertText", text: "b" },
        { kind: "insertText", text: "文" },
        { kind: "press", key: "Backspace" },
        { kind: "press", key: "Control+a" },
        { kind: "press", key: "Control+Shift+ArrowLeft" },
      ].map((action) => expect.objectContaining({ action, operation: "act" })),
    );
  });

  it("discards queued keyboard input after the first failed chunk", async () => {
    const { panel, request } = await mountReadyPanel();
    request.mockClear();
    request.mockRejectedValueOnce(new Error("input failed"));
    const input = panel.shadowRoot!.querySelector<HTMLTextAreaElement>(".canvas-keyboard")!;
    for (const text of ["a", "b", "c"]) {
      input.value = text;
      input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text }));
    }
    await waitForFast(() =>
      expect(panel.shadowRoot!.querySelector("[data-take-control]")).not.toBeNull(),
    );
    expect(
      request.mock.calls.filter(([method]) => method === "browser.handoff.browser"),
    ).toHaveLength(1);
    expect(panel.shadowRoot!.textContent).toContain("input failed");
  });

  it("retires control and shows pending continuation after ambiguous completion failure", async () => {
    const { panel, request } = await mountReadyPanel();
    request.mockRejectedValueOnce(new Error("scheduler admission failed"));
    request.mockResolvedValueOnce(handoff("resume_pending", 3));
    panel.shadowRoot!.querySelector<HTMLButtonElement>("[data-complete]")!.click();
    await waitForFast(() =>
      expect(panel.shadowRoot!.querySelector("[data-refresh-status]")).not.toBeNull(),
    );
    expect(panel.shadowRoot!.querySelector(".frame")).toBeNull();
    expect(panel.shadowRoot!.querySelector("[data-complete]")).toBeNull();
    expect(panel.shadowRoot!.textContent).toContain("scheduler admission failed");
  });

  it("opens the canvas keyboard only after the remote tab reports editable focus", async () => {
    const { panel, request } = await mountReadyPanel();
    const keyboard = panel.shadowRoot!.querySelector<HTMLTextAreaElement>(".canvas-keyboard")!;
    const frame = panel.shadowRoot!.querySelector<HTMLImageElement>(".frame")!;
    const tap = () => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, clientX: 20, clientY: 20 });
        Object.defineProperty(event, "pointerId", { value: 1 });
        frame.dispatchEvent(event);
      }
    };
    request.mockResolvedValueOnce({ ok: true, focusedEditable: true });
    tap();
    expect(panel.shadowRoot!.activeElement).not.toBe(keyboard);
    await waitForFast(() => expect(panel.shadowRoot!.activeElement).toBe(keyboard));
    await panel.updateComplete;
    request.mockResolvedValueOnce({ ok: true, focusedEditable: false });
    tap();
    await waitForFast(() => expect(panel.shadowRoot!.activeElement).not.toBe(keyboard));
  });

  it("requires a second touch on the selected field to synchronously open the keyboard", async () => {
    const { panel, request } = await mountReadyPanel();
    request.mockClear();
    const keyboard = panel.shadowRoot!.querySelector<HTMLTextAreaElement>(".canvas-keyboard")!;
    const frame = panel.shadowRoot!.querySelector<HTMLImageElement>(".frame")!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
    const tap = (x: number) => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 20 });
        Object.defineProperties(event, {
          pointerId: { value: 1 },
          pointerType: { value: "touch" },
        });
        frame.dispatchEvent(event);
      }
    };
    request.mockResolvedValueOnce({ ok: true, focusedEditable: true });
    tap(20);
    await waitForFast(() => {
      expect(panel.shadowRoot!.textContent).toContain("Tap the field again to type");
      expect(panel.shadowRoot!.querySelector<HTMLButtonElement>("[data-complete]")!.disabled).toBe(
        false,
      );
    });
    expect(panel.shadowRoot!.activeElement).not.toBe(keyboard);
    request.mockResolvedValueOnce({ ok: true, focusedEditable: true });
    tap(20);
    // Deliberately synchronous: awaiting here would miss the mobile activation regression.
    expect(panel.shadowRoot!.activeElement).toBe(keyboard);
    expect(request).toHaveBeenCalledTimes(2);
    await waitForFast(() =>
      expect(panel.shadowRoot!.querySelector<HTMLButtonElement>("[data-complete]")!.disabled).toBe(
        false,
      ),
    );
    await panel.updateComplete;
    expect(panel.shadowRoot!.textContent).not.toContain("Tap the field again to type");
    keyboard.blur();
    request.mockResolvedValueOnce({ ok: true, focusedEditable: true });
    tap(20);
    await waitForFast(() => {
      expect(panel.shadowRoot!.textContent).toContain("Tap the field again to type");
      expect(panel.shadowRoot!.querySelector<HTMLButtonElement>("[data-complete]")!.disabled).toBe(
        false,
      );
    });
    request.mockResolvedValueOnce({ ok: true, focusedEditable: false });
    tap(200);
    expect(panel.shadowRoot!.activeElement).not.toBe(keyboard);
    await waitForFast(() =>
      expect(panel.shadowRoot!.textContent).not.toContain("Tap the field again to type"),
    );
    expect(request).toHaveBeenCalledTimes(4);
  });

  it.each(["editable", "noneditable", "failed"] as const)(
    "fences keyboard input behind the second tap when retargeting is %s",
    async (outcome) => {
      const { panel, request } = await mountReadyPanel();
      request.mockClear();
      const keyboard = panel.shadowRoot!.querySelector<HTMLTextAreaElement>(".canvas-keyboard")!;
      const frame = panel.shadowRoot!.querySelector<HTMLImageElement>(".frame")!;
      const tap = () => {
        for (const type of ["pointerdown", "pointerup"]) {
          const event = new MouseEvent(type, { bubbles: true, clientX: 20, clientY: 20 });
          Object.defineProperties(event, {
            pointerId: { value: 1 },
            pointerType: { value: "touch" },
          });
          frame.dispatchEvent(event);
        }
      };
      request.mockResolvedValueOnce({ ok: true, focusedEditable: true });
      tap();
      await waitForFast(() => {
        expect(panel.shadowRoot!.textContent).toContain("Tap the field again to type");
        expect(
          panel.shadowRoot!.querySelector<HTMLButtonElement>("[data-complete]")!.disabled,
        ).toBe(false);
      });
      let finishClick!: () => void;
      request.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finishClick = () =>
              outcome === "failed"
                ? reject(new Error("retarget failed"))
                : resolve({ ok: true, focusedEditable: outcome === "editable" });
          }),
      );
      tap();
      expect(panel.shadowRoot!.activeElement).toBe(keyboard);
      expect(request).toHaveBeenCalledTimes(2);
      keyboard.value = "secret";
      keyboard.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "secret" }));
      await panel.updateComplete;
      expect(request).toHaveBeenCalledTimes(2);
      finishClick();
      await waitForFast(() =>
        expect(
          panel.shadowRoot!.querySelector<HTMLButtonElement>("[data-complete]")!.disabled,
        ).toBe(false),
      );
      const inserts = request.mock.calls.filter(
        (call) => (call[1] as { action?: { kind?: string } })?.action?.kind === "insertText",
      );
      expect(inserts).toHaveLength(outcome === "editable" ? 1 : 0);
      if (outcome !== "editable") {
        expect(panel.shadowRoot!.activeElement).not.toBe(keyboard);
      }
    },
  );

  it("clears the armed touch when a screencast frame changes URL without a metadata event", async () => {
    const { panel, request, sockets } = await mountReadyPanel();
    const frame = panel.shadowRoot!.querySelector<HTMLImageElement>(".frame")!;
    request.mockResolvedValueOnce({ ok: true, focusedEditable: true });
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, clientX: 20, clientY: 20 });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "touch" } });
      frame.dispatchEvent(event);
    }
    await waitForFast(() =>
      expect(panel.shadowRoot!.textContent).toContain("Tap the field again to type"),
    );
    sockets[0]!.dispatchEvent(
      new MessageEvent("message", { data: screencastFrame("https://accounts.example/next") }),
    );
    await waitForFast(() =>
      expect(panel.shadowRoot!.textContent).not.toContain("Tap the field again to type"),
    );
  });

  it("does not arm a delayed touch response after another touch invalidates its target", async () => {
    const { panel, request } = await mountReadyPanel();
    const keyboard = panel.shadowRoot!.querySelector<HTMLTextAreaElement>(".canvas-keyboard")!;
    const frame = panel.shadowRoot!.querySelector<HTMLImageElement>(".frame")!;
    let resolveInput!: (value: { ok: true; focusedEditable: boolean }) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInput = resolve;
        }),
    );
    const tap = (x: number) => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 20 });
        Object.defineProperties(event, {
          pointerId: { value: 1 },
          pointerType: { value: "touch" },
        });
        frame.dispatchEvent(event);
      }
    };
    tap(20);
    tap(200);
    resolveInput({ ok: true, focusedEditable: true });
    await waitForFast(() =>
      expect(panel.shadowRoot!.querySelector<HTMLButtonElement>("[data-complete]")!.disabled).toBe(
        false,
      ),
    );
    expect(panel.shadowRoot!.activeElement).not.toBe(keyboard);
    expect(panel.shadowRoot!.textContent).not.toContain("Tap the field again to type");
  });

  it("pinches and pans locally without remote input or a trailing one-finger action", async () => {
    const { panel, request } = await mountReadyPanel();
    request.mockClear();
    const viewer = panel.shadowRoot!.querySelector<HTMLElement>(".viewer")!;
    const frame = panel.shadowRoot!.querySelector<HTMLImageElement>(".frame")!;
    const pointer = (type: string, pointerId: number, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { clientX, clientY });
      Object.defineProperties(event, {
        pointerId: { value: pointerId },
        pointerType: { value: "touch" },
      });
      viewer.dispatchEvent(event);
    };
    pointer("pointerdown", 1, 100, 100);
    pointer("pointerdown", 2, 200, 100);
    pointer("pointermove", 1, 80, 80);
    pointer("pointermove", 2, 240, 120);
    expect(Number(frame.style.getPropertyValue("--human-browser-zoom"))).toBeGreaterThan(1.5);
    pointer("pointerup", 1, 80, 80);
    pointer("pointermove", 2, 240, 300);
    pointer("pointerup", 2, 240, 300);
    await panel.updateComplete;
    expect(request).not.toHaveBeenCalled();
    expect(panel.shadowRoot!.activeElement).not.toBe(
      panel.shadowRoot!.querySelector(".canvas-keyboard"),
    );
  });

  it("scrolls while one finger moves over blank viewer space and coalesces pending wheel input", async () => {
    const { panel, request } = await mountReadyPanel();
    request.mockClear();
    const viewer = panel.shadowRoot!.querySelector<HTMLElement>(".viewer")!;
    const frame = panel.shadowRoot!.querySelector<HTMLImageElement>(".frame")!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 400));
    let finishWheel!: () => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWheel = () => resolve({ ok: true });
        }),
    );
    const pointer = (type: string, clientY: number) => {
      const event = new MouseEvent(type, { clientX: 500, clientY });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "touch" } });
      viewer.dispatchEvent(event);
    };
    pointer("pointerdown", 700);
    pointer("pointermove", 620);
    // No pointerup yet: scrolling must be responsive during the gesture.
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith(
      "browser.handoff.browser",
      expect.objectContaining({
        action: { kind: "scroll", x: 500, y: 799, deltaX: 0, deltaY: 160 },
      }),
    );
    pointer("pointermove", 580);
    pointer("pointermove", 550);
    pointer("pointerup", 550);
    expect(request).toHaveBeenCalledTimes(1);
    finishWheel();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith(
      "browser.handoff.browser",
      expect.objectContaining({
        action: { kind: "scroll", x: 500, y: 799, deltaX: 0, deltaY: 140 },
      }),
    );
  });

  it.each(["key-first", "scroll-first", "touch-up"] as const)(
    "preserves shared input order for %s behind an in-flight wheel",
    async (order) => {
      const { panel, request } = await mountReadyPanel();
      request.mockClear();
      const viewer = panel.shadowRoot!.querySelector<HTMLElement>(".viewer")!;
      const keyboard = panel.shadowRoot!.querySelector<HTMLTextAreaElement>(".canvas-keyboard")!;
      let finishFirst!: () => void;
      request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = () => resolve({ ok: true });
          }),
      );
      const touch = (type: string, clientY: number) => {
        const event = new MouseEvent(type, { clientX: 20, clientY });
        Object.defineProperties(event, {
          pointerId: { value: 1 },
          pointerType: { value: "touch" },
        });
        viewer.dispatchEvent(event);
      };
      if (order === "touch-up") {
        touch("pointerdown", 100);
        touch("pointermove", 90);
      } else {
        viewer.dispatchEvent(new WheelEvent("wheel", { deltaY: 10 }));
      }
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
      const key = () =>
        keyboard.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true }),
        );
      if (order !== "scroll-first") {
        key();
      }
      if (order === "touch-up") {
        touch("pointerup", 70);
      } else {
        viewer.dispatchEvent(new WheelEvent("wheel", { deltaY: 20 }));
      }
      if (order === "scroll-first") {
        key();
      }
      await panel.updateComplete;
      expect(request).toHaveBeenCalledTimes(1);
      finishFirst();
      await waitForFast(() =>
        expect(
          panel.shadowRoot!.querySelector<HTMLButtonElement>("[data-complete]")!.disabled,
        ).toBe(false),
      );
      const actions = request.mock.calls.map((call) => (call[1] as { action: unknown }).action);
      const first = expect.objectContaining({ kind: "scroll", deltaY: 10 });
      const second = expect.objectContaining({ kind: "scroll", deltaY: 20 });
      const typed = { kind: "press", key: "ArrowLeft" };
      expect(actions).toEqual(
        order === "scroll-first" ? [first, second, typed] : [first, typed, second],
      );
    },
  );

  it("delivers a new controller's pending wheel after the old controller's input settles", async () => {
    const { panel, request, sockets } = await mountReadyPanel();
    let finishOldWheel!: () => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldWheel = () => resolve({ ok: true });
        }),
    );
    panel
      .shadowRoot!.querySelector(".viewer")!
      .dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
    await waitForFast(() => expect(finishOldWheel).toBeTypeOf("function"));
    const replacement = createClient();
    panel.autoClaim = true;
    panel.client = replacement.client;
    await waitForFast(() => expect(sockets).toHaveLength(2));
    sockets[1]!.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "ready",
          targetId: "tab-1",
          url: "https://accounts.example/challenge",
          title: "Challenge",
        }),
      }),
    );
    sockets[1]!.dispatchEvent(
      new MessageEvent("message", { data: screencastFrame("https://accounts.example/challenge") }),
    );
    await waitForFast(() =>
      expect(
        panel.shadowRoot!.querySelector<HTMLTextAreaElement>(".canvas-keyboard")?.disabled,
      ).toBe(false),
    );
    vi.spyOn(
      panel.shadowRoot!.querySelector<HTMLImageElement>(".frame")!,
      "getBoundingClientRect",
    ).mockReturnValue(new DOMRect(0, 0, 1000, 800));
    replacement.request.mockClear();
    panel
      .shadowRoot!.querySelector(".viewer")!
      .dispatchEvent(new WheelEvent("wheel", { deltaY: 60 }));
    expect(replacement.request).not.toHaveBeenCalled();
    finishOldWheel();
    await waitForFast(() => expect(replacement.request).toHaveBeenCalledTimes(1));
    expect(replacement.request).toHaveBeenCalledWith(
      "browser.handoff.browser",
      expect.objectContaining({ action: expect.objectContaining({ kind: "scroll", deltaY: 60 }) }),
    );
  });

  it("rejects blank viewer taps while preserving image taps and mouse dragging", async () => {
    const { panel, request } = await mountReadyPanel();
    request.mockClear();
    const viewer = panel.shadowRoot!.querySelector<HTMLElement>(".viewer")!;
    const frame = panel.shadowRoot!.querySelector<HTMLImageElement>(".frame")!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 400));
    const pointer = (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { clientX, clientY });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
      viewer.dispatchEvent(event);
    };
    pointer("pointerdown", 500, 700);
    pointer("pointerup", 500, 700);
    await panel.updateComplete;
    expect(request).not.toHaveBeenCalled();
    pointer("pointerdown", 100, 100);
    pointer("pointerup", 200, 200);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith(
      "browser.handoff.browser",
      expect.objectContaining({
        action: { kind: "dragCoords", x: 100, y: 200, endX: 200, endY: 400 },
      }),
    );
  });

  it("keeps completion disabled until remote input finishes", async () => {
    const { panel, request } = await mountReadyPanel();

    let releaseInput: (() => void) | undefined;
    request.mockImplementation(async (method: string) => {
      if (method === "browser.handoff.browser") {
        await new Promise<void>((resolve) => {
          releaseInput = resolve;
        });
        return { ok: true };
      }
      if (method === "browser.handoff.complete") {
        return handoff("resumed", 3);
      }
      return handoff("control", 2);
    });

    panel.shadowRoot
      ?.querySelector(".viewer")
      ?.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-complete]")?.disabled).toBe(
        true,
      ),
    );
    expect(request.mock.calls.some(([method]) => method === "browser.handoff.complete")).toBe(
      false,
    );

    releaseInput?.();
    await waitForFast(() =>
      expect(panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-complete]")?.disabled).toBe(
        false,
      ),
    );
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-complete]")?.click();
    await waitForFast(() =>
      expect(request.mock.calls.some(([method]) => method === "browser.handoff.complete")).toBe(
        true,
      ),
    );
  });

  it("retries a transient handoff lookup failure", async () => {
    const { client, request } = createClient();
    request.mockRejectedValueOnce(new Error("Gateway is offline"));
    const panel = document.createElement(
      "openclaw-human-intervention-panel",
    ) as OpenClawHumanInterventionPanel;
    panel.client = client;
    panel.available = true;
    panel.handoffId = "handoff-1";
    document.body.append(panel);

    await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("Gateway is offline"));
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[data-retry]")?.click();

    await waitForFast(() => expect(panel.shadowRoot?.textContent).toContain("accounts.example"));
    expect(request).toHaveBeenCalledTimes(2);
  });
});
