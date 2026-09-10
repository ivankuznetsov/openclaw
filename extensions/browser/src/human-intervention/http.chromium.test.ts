import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it } from "vitest";
import { resolveBrowserConfig } from "../browser/config.js";
import { getPlaywrightCore } from "../browser/playwright-core.runtime.js";
import { closePlaywrightBrowserConnection } from "../browser/pw-session.js";
import { createBrowserRouteDispatcher } from "../browser/routes/dispatcher.js";
import { createBrowserRouteContext, type BrowserServerState } from "../browser/server-context.js";
import { getFreePort } from "../browser/test-port.js";
import { HumanInterventionCoordinator } from "./coordinator.js";
import { createHumanInterventionHttpHandler } from "./http.js";
import { HumanInterventionService, type HumanInterventionRecord } from "./service.js";

// Real HTTP, SQLite, browser routes, Playwright/CDP, and Chromium. Only scheduler
// admission is a test double; this does not claim Telegram or Gateway restart proof.
describe.runIf(process.env.OPENCLAW_BROWSER_HANDOFF_E2E === "1")(
  "scoped handoff authority with Chromium and persisted plugin state",
  () => {
    it(
      "fences real input, reopens active state, and retries failed admission",
      { timeout: 60_000 },
      async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-proof-"));
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
        let now = Date.now();
        let rejectAdmission = true;
        const admitted: Array<
          Parameters<OpenClawPluginApi["session"]["workflow"]["scheduleSessionTurn"]>[0]
        > = [];
        const openCoordinator = () =>
          new HumanInterventionCoordinator(
            new HumanInterventionService(
              createPluginStateKeyedStoreForTests<HumanInterventionRecord>("browser", {
                namespace: "handoff-proof",
                maxEntries: 10,
                env: { OPENCLAW_STATE_DIR: path.join(directory, "state") },
              }),
              { now: () => now, controlLeaseMs: 60_000 },
            ),
            {
              publicUrl: "https://handoff.example",
              now: () => now,
              scheduleContinuation: async (params) => {
                if (rejectAdmission) {
                  throw new Error("synthetic scheduler admission unavailable");
                }
                admitted.push(params);
                return {
                  id: "proof-continuation",
                  pluginId: "browser",
                  sessionKey: params.sessionKey,
                  kind: "session-turn",
                };
              },
            },
          );
        let coordinator = openCoordinator();
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
        let dispatched = 0;
        const openHandler = () =>
          createHumanInterventionHttpHandler({
            coordinator,
            isEnabled: () => true,
            publicOrigin: () => "https://handoff.example",
            dispatchBrowser: async (request) => {
              dispatched += 1;
              return await dispatcher.dispatch(request);
            },
          });
        let handler = openHandler();
        const server = createServer((req, res) => {
          void handler(req, res).then((handled) => {
            if (!handled) {
              res.writeHead(404).end();
            }
          });
        });
        try {
          await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
          });
          const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          const page = browser.pages()[0] ?? (await browser.newPage());
          await page.setContent(
            `<button style="position:absolute;left:0;top:0;width:100px;height:100px" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>
            <input id="text" value="[]" style="position:absolute;left:0;top:120px;width:200px;height:40px">
            <iframe style="position:absolute;left:0;top:200px;width:300px;height:100px;border:0" srcdoc="<input value='frame:' style='width:200px;height:40px'>"></iframe>`,
          );
          const otherPage = await browser.newPage();
          await otherPage.setContent(
            '<button style="position:absolute;left:0;top:0;width:100px;height:100px" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>',
          );
          const otherCdp = await browser.newCDPSession(otherPage);
          const otherTarget = await otherCdp.send("Target.getTargetInfo");
          await otherCdp.detach();
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
          const post = async (body: unknown, handoffId = id) =>
            await fetch(`${endpoint}/browser/handoff/${handoffId}`, {
              method: "POST",
              headers: {
                origin: "https://handoff.example",
                "content-type": "application/json",
                authorization: `Bearer ${sessionToken}`,
              },
              body: JSON.stringify(body),
            });
          const token = new URLSearchParams(new URL(pending.launchUrl).hash.slice(1)).get(
            "handoffToken",
          );
          expect((await post({ action: "redeem", token, sessionToken })).status).toBe(200);
          const claim = await post({ action: "claim" });
          expect(claim.status).toBe(200);
          const claimed = await coordinator.service.get(id);
          const click = {
            action: "browser",
            generation: claimed.generation,
            operation: "act",
            targetId: otherTarget.targetInfo.targetId,
            input: { kind: "clickCoords", targetId: otherTarget.targetInfo.targetId, x: 30, y: 30 },
          };
          const buttonClick = await post(click);
          expect(buttonClick.status).toBe(200);
          expect(await buttonClick.json()).toMatchObject({ focusedEditable: false });
          expect(await page.locator("button").textContent()).toBe("1");
          expect(await otherPage.locator("button").textContent()).toBe("0");

          const act = async (input: Record<string, unknown>) => await post({ ...click, input });
          const fieldClick = await act({ kind: "clickCoords", x: 30, y: 140 });
          expect(fieldClick.status).toBe(200);
          expect(await fieldClick.json()).toMatchObject({ focusedEditable: true });
          expect((await act({ kind: "press", key: "Home" })).status).toBe(200);
          expect((await act({ kind: "press", key: "ArrowRight" })).status).toBe(200);
          for (const text of ["ab", "cd"]) {
            expect((await act({ kind: "insertText", text })).status).toBe(200);
          }
          expect(await page.locator("#text").inputValue()).toBe("[abcd]");

          const frameClick = await act({ kind: "clickCoords", x: 30, y: 225 });
          expect(frameClick.status).toBe(200);
          expect(await frameClick.json()).toMatchObject({ focusedEditable: true });
          expect((await act({ kind: "press", key: "End" })).status).toBe(200);
          expect((await act({ kind: "insertText", text: "ok" })).status).toBe(200);
          expect(await page.frameLocator("iframe").locator("input").inputValue()).toBe("frame:ok");
          expect(await page.locator("#text").inputValue()).toBe("[abcd]");

          // Unauthorized requests never reach the real dispatcher, as well as
          // leaving the real target unchanged. No mock browser operation exists.
          const assertRejected = async (body: unknown, handoffId = id) => {
            const beforeDispatch = dispatched;
            const beforeText = await page.locator("button").textContent();
            expect((await post(body, handoffId)).status).toBe(403);
            expect(dispatched).toBe(beforeDispatch);
            expect(await page.locator("button").textContent()).toBe(beforeText);
          };
          const other = await coordinator.service.request({
            ...pending.record,
            browser: { target: "host", profile: "other", targetId: "other-tab" },
          });
          await assertRejected(click, other.id);
          await assertRejected({ ...click, operation: "navigate", url: "https://example.com" });
          await assertRejected({ action: "config.set", value: "forbidden" });

          // Recreate runtime owners after closing actual SQLite connections. The
          // active browser survives, as it does across a plugin/Gateway reconnect.
          const reopen = async () => {
            handler.dispose();
            coordinator.stop();
            resetPluginStateStoreForTests();
            coordinator = openCoordinator();
            handler = openHandler();
            await coordinator.start();
          };
          await reopen();
          expect(await coordinator.service.get(id)).toMatchObject({
            state: "control",
            generation: claimed.generation,
          });
          expect((await post(click)).status).toBe(200);
          expect(await page.locator("button").textContent()).toBe("2");

          now += 60_001;
          await assertRejected(click);
          expect((await post({ action: "claim" })).status).toBe(200);
          const reclaimed = await coordinator.service.get(id);
          const currentClick = { ...click, generation: reclaimed.generation };
          expect((await post(currentClick)).status).toBe(200);
          expect(await page.locator("button").textContent()).toBe("3");
          expect(
            (await post({ action: "complete", generation: reclaimed.generation })).status,
          ).toBe(403);
          expect(await coordinator.service.get(id)).toMatchObject({ state: "resume_pending" });
          await assertRejected(currentClick);
          expect(admitted).toHaveLength(0);

          rejectAdmission = false;
          await reopen();
          expect(await coordinator.service.get(id)).toMatchObject({ state: "resumed" });
          expect(admitted).toHaveLength(1);
          expect(admitted[0]).toMatchObject({ sessionKey: "agent:main:telegram:direct:42" });
          await coordinator.reconcile();
          expect(admitted).toHaveLength(1);
          await assertRejected(currentClick);

          // Sibling transitions must also persist absent authority as valid JSON.
          const otherControl = await coordinator.service.claim({
            id: other.id,
            controllerId: "synthetic-controller",
          });
          expect(
            await coordinator.service.leave({
              id: other.id,
              controllerId: "synthetic-controller",
              generation: otherControl.generation,
            }),
          ).toMatchObject({ state: "waiting" });
          expect(await coordinator.service.cancel(other.id)).toMatchObject({ state: "cancelled" });
          const expiring = await coordinator.service.request({
            ...pending.record,
            browser: other.browser,
          });
          now = expiring.expiresAtMs + 1;
          expect(await coordinator.service.get(expiring.id)).toMatchObject({ state: "expired" });
        } finally {
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
