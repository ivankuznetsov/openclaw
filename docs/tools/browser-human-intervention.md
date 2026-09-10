---
summary: "Let an owner operate a blocked managed browser tab from another device"
read_when:
  - A browser task needs live human verification
  - You want to complete a remote browser step from a phone
title: "Human Browser Intervention"
---

# Human browser intervention

Human browser intervention lets an agent pause a managed browser profile and send an **Open browser** link to the current direct chat. The link opens the exact remote tab in a mobile-friendly page using a temporary credential limited to that handoff. The human performs the blocked step and selects **Done — continue agent**; OpenClaw then schedules a fresh turn in the original session and delivery route.

This is a manual-control path. OpenClaw does not solve or relay CAPTCHA answers through the model.

## Configure it

The phone must be able to reach the same HTTPS Gateway origin used by the Control UI. Configure that existing public origin, keep the Control UI enabled, and opt in to human intervention:

```json5
{
  gateway: {
    publicOrigin: "https://openclaw.example.com",
    controlUi: {
      enabled: true,
      // basePath: "/openclaw", // optional reverse-proxy path
    },
  },
  tools: {
    alsoAllow: ["browser"],
  },
  browser: {
    humanIntervention: {
      enabled: true,
    },
  },
}
```

`gateway.publicOrigin` must use HTTPS for handoff links. A loopback URL cannot reach a browser on another machine. If you use a private VPN, its HTTPS hostname is valid as long as the phone can resolve and reach it.

The agent must also have access to the `browser` tool. The `coding` tool profile does not include it; add `browser` to the existing `tools.alsoAllow` list, preserving any other entries. Explicit deny rules still apply. See [Browser tool access](/tools/browser).

The chat link includes a one-use credential that expires after 10 minutes, or when the handoff expires, whichever comes first. Opening the link in a foreground browser tab redeems it and opens the browser viewer directly. No Gateway token, administrator pairing, or server command is required. Ordinary link previews do not receive the URL-fragment credential. Hidden and prerendered viewer documents wait until they are visible before redeeming it.

Treat the link as private: anyone who receives an unused link can redeem it. The resulting browser session can view and operate only the selected handoff until it ends or expires. It cannot access Gateway settings, chats, shell commands, or other tabs. The credential is kept in this browser tab's session storage; it is not added to the normal Gateway login store. Gateway administrators retain their existing access through the authenticated Control UI.

## Use it

When the agent encounters a CAPTCHA, login/2FA, or another step only you can complete in a managed browser tab, it should request a handoff immediately. You do not need to ask for a link first. This is an agent tool decision based on the visible page, not a background CAPTCHA detector. OpenClaw:

1. Waits for active managed-browser work on that profile to finish.
2. Reserves the profile and blocks new participating agent browser operations.
3. Sends the site hostname, short reason, and HTTPS link to the originating direct chat.
4. Keeps the browser process, profile, and tab alive while the task is paused.

Open the link to enter the browser viewer. The page supports taps, drags, page scrolling, local zoom, and direct keyboard input. On a touch screen, tap a text field to select it, then tap it again when prompted to open the keyboard. Swipe with one finger anywhere in the viewer to scroll the remote page. Pinch with two fingers to zoom locally, and move both fingers to pan the zoomed view. Mouse dragging still moves page elements on desktop. Mobile zoom buttons are hidden, and task instructions are available under **Task details**. It does not expose browser navigation commands, evaluation, cookies, files, shell access, or other browser profiles. Clicking links or typing into the page can still navigate within the selected tab; access is scoped to the tab, not to one website.

- **Done — continue agent** revokes human input and schedules the original session to inspect fresh page state before continuing.
- **Cancel handoff** ends the handoff without resuming the task.

Closing or backgrounding the page leaves the task paused. A controller lease also expires after a disconnect. Return to the same browser tab to take control again. An already-redeemed link cannot be used to authorize another browser; if you close the tab and lose its session storage, the existing handoff must end before a new one can be created. An authenticated administrator can cancel it, or you can wait for it to expire (30 minutes by default).

After completion, **waiting to be queued** means continuation admission is still pending. **Queued to continue** means the Gateway has durably accepted the continuation; it does not mean the agent has already started or finished. Select **Refresh status** while admission is pending to check whether it has been queued, and watch the originating chat for the task result.

## Chat support

Supported direct-delivery channels, including Telegram and iMessage, use the same portable HTTPS text link and lifecycle. Handoff requires a current-turn delivery capability; channels using Gateway-owned delivery, including WhatsApp, do not currently expose it. The mechanism uses OpenClaw's current delivery context, so completion returns to the same channel, account, conversation, and thread when applicable. Handoff creation is limited to owner-authorized direct conversations; group and channel sessions do not receive browser links.

Native iOS and Android users can open the same link in their mobile browser. A dedicated in-app card or embedded native viewer is separate client work; the shared web page remains the baseline mobile flow.

## Test it

To test automatic handoff, give the agent a normal browser task whose page requires a human-only step, without mentioning handoff in your request. It should send the link and pause on that step.

For a basic control test, start with a harmless form page that does not require credentials. In an owner-authorized direct chat, ask the agent to open the page in a managed browser profile and request human help before submitting it. Open the handoff link from another device, enter a non-sensitive test value, and select **Done — continue agent**. The original chat should receive the resumed agent turn, and the agent should inspect the same tab before continuing.

## Limits

- The first version supports OpenClaw-managed host browser profiles. Handoff creation is unavailable for existing-session, sandbox, and node-routed browsers.
- The reservation fences browser operations that participate in the Browser plugin gate. It cannot stop an unrelated process with direct OS or CDP access.
- Native browser dialogs, audio-only challenges, and a verification flow that switches to an unbound popup may require a different supported surface.
- The Gateway must remain running and the remote browser tab must remain alive.

If no handoff link appears, verify browser-tool access, `browser.humanIntervention.enabled`, `gateway.publicOrigin`, direct-chat owner authorization, and managed-profile selection. A handoff URL without a credential stays on the handoff page and asks for a fresh link. Opening the Gateway root separately still uses normal Gateway authentication, including any administrator login already saved in that browser. If the link has expired or was already used in another browser, end the existing handoff or wait for its expiry before requesting a new one. A failed request does not issue a new link; the agent must report the failure rather than construct a URL.
