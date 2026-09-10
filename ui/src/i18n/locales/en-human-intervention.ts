import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  humanBrowser: {
    linkExplanation:
      "Control only the browser tab shared by your agent. This link does not give access to Gateway settings or other tabs.",
    linkExpired:
      "This link has expired, was already used, or is no longer authorized. Ask your agent for a new handoff link.",
    linkConnectionError:
      "Could not reach the browser handoff. Check your connection and try again.",
    linkRequestError:
      "The browser handoff request failed. Try again or ask your agent for a new link.",
    linkStorageError: "Allow site storage in this browser, then reopen the handoff link.",
    title: "Browser action needed",
    taskDetails: "Task details",
    loading: "Loading browser handoff…",
    retry: "Try again",
    refreshStatus: "Refresh status",
    unavailable: "Human browser handoff is unavailable on this Gateway.",
    expired: "This browser handoff has expired.",
    cancelled: "This browser handoff was cancelled.",
    resumePending: "Your task is waiting to be queued. The agent has not resumed yet.",
    continuationQueued: "Your task is queued to continue. You can return to your chat.",
    waiting: "The agent is paused while it waits for you.",
    control: "You have control of this browser tab.",
    controlElsewhere: "This handoff is open on another device.",
    takeControl: "Take control",
    done: "Done — continue agent",
    leave: "Leave paused",
    cancel: "Cancel handoff",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    scrollUp: "Scroll up",
    scrollDown: "Scroll down",
    typePlaceholder: "Type into the focused field",
    sendText: "Send text",
    pressEnter: "Press Enter",
    tapAgainToType: "Tap the field again to type.",
    gestureHint: "Swipe to scroll. Pinch to zoom.",
    browserLoading: "Connecting to the browser tab…",
  },
} satisfies TranslationMap;

export const registerHumanInterventionEnglish = Object.assign(() => Object.assign(en, catalog), {
  catalog,
});
