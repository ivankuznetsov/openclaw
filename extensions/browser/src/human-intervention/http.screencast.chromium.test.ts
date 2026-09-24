import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it } from "vitest";
import { resolveBrowserConfig } from "../browser/config.js";
import { getPlaywrightCore } from "../browser/playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "../browser/pw-session.js";
import { createBrowserRouteDispatcher } from "../browser/routes/dispatcher.js";
import { handleBrowserScreencastUpgrade } from "../browser/screencast/upgrade.js";
import { createBrowserRouteContext, type BrowserServerState } from "../browser/server-context.js";
import { getFreePort } from "../browser/test-port.js";
import { HumanInterventionCoordinator } from "./coordinator.js";
import { createHumanInterventionHttpHandler } from "./http.js";
import { HumanInterventionService, type HumanInterventionRecord } from "./service.js";

type ViewerSocket = {
  socket: WebSocket;
  frames: number;
  framesAfterClose: number;
  closed: Promise<{ code: number; reason: string }>;
  opened: Promise<boolean>;
};

function openViewer(url: string): ViewerSocket {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let isClosed = false;
  const viewer: ViewerSocket = {
    socket,
    frames: 0,
    framesAfterClose: 0,
    opened: new Promise((resolve) => {
      socket.addEventListener("open", () => resolve(true), { once: true });
      socket.addEventListener("close", () => resolve(false), { once: true });
    }),
    closed: new Promise((resolve) => {
      socket.addEventListener(
        "close",
        (event) => {
          isClosed = true;
          resolve({ code: event.code, reason: event.reason });
        },
        { once: true },
      );
    }),
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      return;
    }
    if (isClosed) {
      viewer.framesAfterClose += 1;
    } else {
      viewer.frames += 1;
    }
  });
  return viewer;
}

// Real HTTP upgrade, screencast session, Playwright/CDP, Chromium, and SQLite
// plugin state. Only scheduler admission is a test double.
describe.runIf(process.env.OPENCLAW_BROWSER_HANDOFF_E2E === "1")(
  "scoped handoff screencast authority with Chromium",
  () => {
    it(
      "streams only to the current handoff and cuts frames off on revocation",
      { timeout: 60_000 },
      async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-stream-"));
        const port = await getFreePort();
        const cdpUrl = `http://127.0.0.1:${port}`;
        const browser = await getPlaywrightCore().chromium.launchPersistentContext(
          path.join(directory, "chromium"),
          {
            headless: true,
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            args: [`--remote-debugging-port=${port}`],
          },
        );
        const coordinator = new HumanInterventionCoordinator(
          new HumanInterventionService(
            createPluginStateKeyedStoreForTests<HumanInterventionRecord>("browser", {
              namespace: "handoff-stream-proof",
              maxEntries: 10,
              env: { OPENCLAW_STATE_DIR: path.join(directory, "state") },
            }),
            { controlLeaseMs: 60_000 },
          ),
          {
            publicUrl: "https://handoff.example",
            scheduleContinuation: async (params) => ({
              id: "stream-proof-continuation",
              pluginId: "browser",
              sessionKey: params.sessionKey,
              kind: "session-turn",
            }),
          },
        );
        const state: BrowserServerState = {
          port: 0,
          resolved: resolveBrowserConfig({
            defaultProfile: "proof",
            profiles: { proof: { cdpUrl, color: "#123456", attachOnly: true } },
          }),
          profiles: new Map(),
        };
        const dispatcher = createBrowserRouteDispatcher(
          createBrowserRouteContext({ getState: () => state, refreshConfigFromDisk: false }),
        );
        const handler = createHumanInterventionHttpHandler({
          coordinator,
          isEnabled: () => true,
          publicOrigin: () => "https://handoff.example",
          dispatchBrowser: async (request) => await dispatcher.dispatch(request),
        });
        const server = createServer((req, res) => {
          void handler(req, res).then((handled) => {
            if (!handled) {
              res.writeHead(404).end();
            }
          });
        });
        server.on("upgrade", (req, socket, head) => {
          void handleBrowserScreencastUpgrade(req, socket, head).then((handled) => {
            if (!handled) {
              socket.destroy();
            }
          });
        });
        const viewers: ViewerSocket[] = [];
        try {
          await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
          });
          const address = server.address() as AddressInfo;
          const endpoint = `http://127.0.0.1:${address.port}`;
          const page = browser.pages()[0] ?? (await browser.newPage());
          await page.setContent('<div id="tick" style="font-size:64px">0</div>');
          const cdp = await browser.newCDPSession(page);
          const { targetInfo } = await cdp.send("Target.getTargetInfo");
          await cdp.detach();
          const pending = await coordinator.request(
            {
              agentId: "main",
              sessionKey: "agent:main:telegram:direct:42",
              senderIsOwner: true,
              requesterSenderId: "42",
              deliveryContext: { channel: "telegram", to: "42", accountId: "default" },
            },
            {
              profile: "proof",
              targetId: targetInfo.targetId,
              hostname: "example.com",
              reason: "Synthetic manual verification",
            },
          );
          const id = pending.record.id;
          const sessionToken = randomBytes(32).toString("base64url");
          const post = async (body: Record<string, unknown>, handoffId = id) =>
            await fetch(`${endpoint}/browser/handoff/${handoffId}`, {
              method: "POST",
              headers: {
                origin: "https://handoff.example",
                "content-type": "application/json",
                authorization: `Bearer ${sessionToken}`,
              },
              body: JSON.stringify({ controllerId: "phone-a", ...body }),
            });
          const linkToken = new URLSearchParams(new URL(pending.launchUrl).hash.slice(1)).get(
            "handoffToken",
          );
          expect((await post({ action: "redeem", token: linkToken, sessionToken })).status).toBe(
            200,
          );
          expect((await post({ action: "claim" })).status).toBe(200);
          const claimed = await coordinator.service.get(id);
          const screencast = {
            action: "browser",
            operation: "screencast",
            generation: claimed.generation,
            maxWidth: 640,
            maxHeight: 480,
          };
          const tick = async () =>
            await page.evaluate(() => {
              const element = document.getElementById("tick")!;
              element.textContent = String(Number(element.textContent) + 1);
            });

          // Allowed: the current handoff controller receives real screencast frames.
          const minted = await post(screencast);
          expect(minted.status).toBe(200);
          const { wsPath } = (await minted.json()) as { wsPath: string };
          expect(wsPath.startsWith("/browser/screencast?token=")).toBe(true);
          const wsUrl = `ws://127.0.0.1:${address.port}${wsPath}`;
          const allowed = openViewer(wsUrl);
          viewers.push(allowed);
          expect(await allowed.opened).toBe(true);
          await expect
            .poll(
              async () => {
                await tick();
                return allowed.frames;
              },
              { timeout: 15_000 },
            )
            .toBeGreaterThan(0);

          // A minted stream token is single-use: a second socket cannot replay it.
          const replay = openViewer(wsUrl);
          viewers.push(replay);
          expect(await replay.opened).toBe(false);
          expect(replay.frames).toBe(0);

          // Another handoff's id cannot mint a stream with this viewer session,
          // and an arbitrary token never upgrades.
          const other = await coordinator.service.request({
            ...pending.record,
            browser: { target: "host", profile: "other", targetId: "other-tab" },
          });
          expect((await post(screencast, other.id)).status).toBe(403);
          const forged = openViewer(
            `ws://127.0.0.1:${address.port}/browser/screencast?token=${randomBytes(24).toString("base64url")}`,
          );
          viewers.push(forged);
          expect(await forged.opened).toBe(false);

          // Revocation: Done revokes control, closes the live socket with
          // authority_revoked, and no frame arrives after the close.
          expect((await post({ action: "complete", generation: claimed.generation })).status).toBe(
            200,
          );
          const closed = await allowed.closed;
          expect(closed).toEqual({ code: 4006, reason: "authority_revoked" });
          const framesAtRevocation = allowed.frames;
          for (let index = 0; index < 5; index += 1) {
            await tick();
          }
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(allowed.frames).toBe(framesAtRevocation);
          expect(allowed.framesAfterClose).toBe(0);
          expect(await coordinator.service.get(id)).toMatchObject({ state: "resumed" });

          // A revoked controller cannot mint a replacement stream.
          expect((await post(screencast)).status).toBe(403);
        } finally {
          for (const viewer of viewers) {
            viewer.socket.close();
          }
          handler.dispose();
          coordinator.stop();
          server.closeAllConnections();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
          await closePlaywrightBrowserConnection({ cdpUrl });
          await browser.close();
          resetPluginStateStoreForTests();
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  },
);
