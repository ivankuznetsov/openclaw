import type { Page } from "playwright-core";
import type { GuardedInteractionOptions } from "./pw-tools-core.interactions.navigation.js";

/** A fixed boolean observation; never exposes field contents or accepts caller code. */
export async function readHumanBrowserInputFocus(
  page: Page,
  authority: Pick<GuardedInteractionOptions, "signal" | "assertCurrent">,
): Promise<boolean> {
  const assertCurrent = () => {
    authority.signal?.throwIfAborted();
    authority.assertCurrent?.();
  };
  assertCurrent();
  // Follow the active iframe chain, not OS window focus: a managed tab may be in
  // the background while its focused field still receives remote keyboard input.
  let frame = page.mainFrame();
  let remaining = 64;
  while (remaining-- > 0) {
    assertCurrent();
    const editable = await frame
      .evaluate(() => {
        let element = document.activeElement;
        while (element?.shadowRoot?.activeElement) {
          element = element.shadowRoot.activeElement;
        }
        if (
          !(element instanceof HTMLElement) ||
          element.getAttribute("inputmode") === "none" ||
          element.matches(":disabled")
        ) {
          return false;
        }
        if (element instanceof HTMLTextAreaElement) {
          return !element.readOnly;
        }
        if (element instanceof HTMLInputElement) {
          return (
            !element.readOnly &&
            ["text", "search", "email", "url", "tel", "password", "number"].includes(element.type)
          );
        }
        return element.isContentEditable;
      })
      .catch(() => false);
    assertCurrent();
    if (editable) {
      return true;
    }
    let focusedChild: typeof frame | undefined;
    for (const child of frame.childFrames()) {
      if (remaining-- <= 0) {
        return false;
      }
      assertCurrent();
      const handle = await child.frameElement().catch(() => null);
      assertCurrent();
      if (!handle) {
        continue;
      }
      let focused = false;
      try {
        focused = await handle
          .evaluate((element) => {
            let active = element.ownerDocument?.activeElement;
            while (active?.shadowRoot?.activeElement) {
              active = active.shadowRoot.activeElement;
            }
            return active === element;
          })
          .catch(() => false);
        assertCurrent();
      } finally {
        await handle.dispose();
      }
      assertCurrent();
      if (focused) {
        focusedChild = child;
        break;
      }
    }
    if (!focusedChild) {
      return false;
    }
    frame = focusedChild;
  }
  return false;
}
