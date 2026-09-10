/* @vitest-environment jsdom */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readHumanBrowserInputFocus } from "./pw-tools-core.input-focus.js";

function fixture() {
  const frame = {
    evaluate: vi.fn(async (read: () => boolean) => read()),
    childFrames: vi.fn((): unknown[] => []),
  };
  // SAFETY: this fixed DOM observation uses only these Page/Frame methods.
  const page = { mainFrame: () => frame } as unknown as Page;
  return { page, frame };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("human browser keyboard focus metadata", () => {
  it.each([
    ['<input type="text">', true],
    ['<input type="password">', true],
    ["<textarea></textarea>", true],
    ['<input type="checkbox">', false],
    ["<button>Verify</button>", false],
    ["<input readonly>", false],
    ["<input disabled>", false],
    ['<input inputmode="none">', false],
  ])(
    "reports keyboard eligibility for %s without needing foreground window focus",
    async (markup, expected) => {
      document.body.innerHTML = markup;
      document.body.firstElementChild?.setAttribute("tabindex", "0");
      (document.body.firstElementChild as HTMLElement).focus();
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      expect(await readHumanBrowserInputFocus(fixture().page, {})).toBe(expected);
    },
  );

  it("follows focused shadow-root fields", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<input type="password">';
    shadow.querySelector("input")!.focus();
    expect(await readHumanBrowserInputFocus(fixture().page, {})).toBe(true);
  });

  it("reads the focused child frame, ignoring stale focus in its sibling", async () => {
    const { page, frame } = fixture();
    const nodes = [document.createElement("iframe"), document.createElement("iframe")];
    document.body.append(...nodes);
    const children = nodes.map((node) => ({
      evaluate: vi.fn(async () => true),
      childFrames: () => [],
      frameElement: async () => ({
        evaluate: async (read: (element: Element) => boolean) => read(node),
        dispose: vi.fn(),
      }),
    }));
    frame.childFrames.mockReturnValue(children);
    nodes[1]!.focus();
    expect(await readHumanBrowserInputFocus(page, {})).toBe(true);
    expect(children[0]!.evaluate).not.toHaveBeenCalled();
    expect(children[1]!.evaluate).toHaveBeenCalledOnce();
  });

  it("does not read DOM with revoked authority or publish a read after revocation", async () => {
    const { page, frame } = fixture();
    const controller = new AbortController();
    controller.abort(new Error("revoked"));
    await expect(readHumanBrowserInputFocus(page, { signal: controller.signal })).rejects.toThrow(
      "revoked",
    );
    expect(frame.evaluate).not.toHaveBeenCalled();
    const next = new AbortController();
    frame.evaluate.mockImplementationOnce(async () => {
      next.abort(new Error("revoked"));
      return true;
    });
    await expect(readHumanBrowserInputFocus(page, { signal: next.signal })).rejects.toThrow(
      "revoked",
    );
  });
});
