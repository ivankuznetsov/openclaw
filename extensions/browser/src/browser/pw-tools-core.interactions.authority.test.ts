import { describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
  setPwToolsCoreCurrentRefLocator,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const { clickCoordsViaPlaywright, dragCoordsViaPlaywright, typeViaPlaywright } =
  await import("./pw-tools-core.interactions.actions.js");

describe("human input authority", () => {
  it("inserts chunks, preserves default fill, and rechecks authority after page resolution", async () => {
    const fill = vi.fn();
    const insertText = vi.fn();
    const page = { url: () => "https://example.test", keyboard: { insertText } };
    setPwToolsCoreCurrentPage(page);
    setPwToolsCoreCurrentRefLocator({ fill });
    const options = { cdpUrl: "http://localhost:18792", targetId: "T1", ref: "1" };
    for (const text of ["a", "b"]) {
      await typeViaPlaywright({ ...options, text, insertText: true });
    }
    expect(insertText.mock.calls).toEqual([["a"], ["b"]]);
    expect(fill).not.toHaveBeenCalled();
    await typeViaPlaywright({ ...options, text: "replacement" });
    expect(fill).toHaveBeenCalledWith("replacement", expect.any(Object));

    let current = true;
    getPwToolsCoreSessionMocks().getPageForTargetId.mockImplementationOnce(async () => {
      current = false;
      return page;
    });
    await expect(
      typeViaPlaywright({
        ...options,
        text: "c",
        insertText: true,
        assertCurrent: () => {
          if (!current) {
            throw new Error("requester revoked");
          }
        },
      }),
    ).rejects.toThrow("requester revoked");
    expect(insertText).toHaveBeenCalledTimes(2);
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it.each(["move", "down"])(
    "stops a drag revoked during %s and releases a pressed button",
    async (stage) => {
      const controller = new AbortController();
      const mouse = {
        move: vi.fn(async () => {
          if (stage === "move") {
            controller.abort(new Error("revoked"));
          }
        }),
        down: vi.fn(async () => {
          if (stage === "down") {
            controller.abort(new Error("revoked"));
          }
        }),
        up: vi.fn(async () => {}),
      };
      setPwToolsCoreCurrentPage({ url: () => "https://example.test", mouse });
      await expect(
        dragCoordsViaPlaywright({
          cdpUrl: "http://localhost:18792",
          targetId: "T1",
          x: 1,
          y: 2,
          endX: 3,
          endY: 4,
          signal: controller.signal,
        }),
      ).rejects.toThrow("revoked");
      // Foreground rejection may precede the primitive's cleanup continuation.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(mouse.move).toHaveBeenCalledTimes(1);
      expect(mouse.down).toHaveBeenCalledTimes(stage === "down" ? 1 : 0);
      expect(mouse.up).toHaveBeenCalledTimes(stage === "down" ? 1 : 0);
    },
  );

  it("rechecks live authority after awaited page resolution before clicking", async () => {
    let current = true;
    const click = vi.fn(async () => {});
    const page = { url: () => "https://example.test", mouse: { click } };
    setPwToolsCoreCurrentPage(page);
    getPwToolsCoreSessionMocks().getPageForTargetId.mockImplementationOnce(async () => {
      current = false;
      return page;
    });
    const options = {
      cdpUrl: "http://localhost:18792",
      targetId: "T1",
      x: 1,
      y: 2,
      assertCurrent: () => {
        if (!current) {
          throw new Error("requester revoked");
        }
      },
    };
    await expect(clickCoordsViaPlaywright(options)).rejects.toThrow("requester revoked");
    expect(click).not.toHaveBeenCalled();
  });
});
