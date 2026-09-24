import { describe, expect, it, vi } from "vitest";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const { clickCoordsViaPlaywright, dragCoordsViaPlaywright, scrollCoordsViaPlaywright } =
  await import("./pw-tools-core.interactions.actions.js");

describe("human input authority", () => {
  it.each(["page", "move"])("fences scrolling revoked during %s", async (stage) => {
    let current = true;
    const mouse = {
      move: vi.fn(async () => {
        current = false;
      }),
      wheel: vi.fn(),
    };
    const page = { url: () => "https://example.test", mouse };
    setPwToolsCoreCurrentPage(page);
    if (stage === "page") {
      getPwToolsCoreSessionMocks().getPageForTargetId.mockImplementationOnce(async () => {
        current = false;
        return page;
      });
    }
    await expect(
      scrollCoordsViaPlaywright({
        cdpUrl: "http://localhost:18792",
        targetId: "T1",
        x: 1,
        y: 2,
        deltaX: 0,
        deltaY: 200,
        assertCurrent: () => {
          if (!current) {
            throw new Error("requester revoked");
          }
        },
      }),
    ).rejects.toThrow("requester revoked");
    expect(mouse.move).toHaveBeenCalledTimes(stage === "page" ? 0 : 1);
    expect(mouse.wheel).not.toHaveBeenCalled();
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
