import type { HumanInterventionInput } from "@openclaw/gateway-protocol";

export function resolveHumanBrowserPoint(
  point: { clientX: number; clientY: number },
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  remote: { width: number; height: number },
): { x: number; y: number } {
  const displayedWidth = Math.max(1, bounds.width);
  const displayedHeight = Math.max(1, bounds.height);
  return {
    x: Math.max(
      0,
      Math.min(remote.width, ((point.clientX - bounds.left) / displayedWidth) * remote.width),
    ),
    y: Math.max(
      0,
      Math.min(remote.height, ((point.clientY - bounds.top) / displayedHeight) * remote.height),
    ),
  };
}

export function humanBrowserBeforeInput(event: InputEvent): HumanInterventionInput | undefined {
  if (event.isComposing) {
    return undefined;
  }
  const keys: Record<string, string> = {
    deleteContentBackward: "Backspace",
    deleteContentForward: "Delete",
    insertLineBreak: "Enter",
    insertParagraph: "Enter",
  };
  const key = keys[event.inputType];
  if (key) {
    event.preventDefault();
    return { kind: "press", key };
  }
  return undefined;
}

export function humanBrowserTextInput(
  event: InputEvent | CompositionEvent,
): HumanInterventionInput | undefined {
  const input = event.currentTarget;
  if (!(input instanceof HTMLTextAreaElement) || ("isComposing" in event && event.isComposing)) {
    return undefined;
  }
  const text = input.value;
  input.value = "";
  if (text) {
    return { kind: "insertText", text };
  }
  return undefined;
}

export function humanBrowserKeyInput(event: KeyboardEvent): HumanInterventionInput | undefined {
  if (event.isComposing || event.key === "Process" || event.getModifierState("AltGraph")) {
    return undefined;
  }
  // Clipboard shortcuts must reach the local input so paste becomes an input event.
  if ((event.ctrlKey || event.metaKey) && ["v", "c", "x"].includes(event.key.toLowerCase())) {
    return undefined;
  }
  const modifiedCharacter =
    event.key.length === 1 && (event.ctrlKey || event.metaKey || event.altKey);
  if (
    modifiedCharacter ||
    [
      "Backspace",
      "Delete",
      "Enter",
      "Tab",
      "Escape",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ].includes(event.key)
  ) {
    event.preventDefault();
    const modifiers = [
      event.ctrlKey && "Control",
      event.metaKey && "Meta",
      event.altKey && "Alt",
      event.shiftKey && "Shift",
    ].filter(Boolean);
    return { kind: "press", key: [...modifiers, event.key].join("+") };
  }
  return undefined;
}

/** Pointer bookkeeping is independent of the handoff's control authority. */
export class HumanBrowserPointerGesture {
  private start?: { x: number; y: number; pointerId: number };
  private points = new Map<number, { startY: number; y: number }>();
  private scrolling = false;

  down(event: PointerEvent): boolean {
    if (event.pointerType === "touch") {
      this.points.set(event.pointerId, { startY: event.clientY, y: event.clientY });
      if (this.points.size > 1) {
        this.scrolling = true;
        this.start = undefined;
      }
    }
    if (!this.scrolling) {
      this.start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    }
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    return this.scrolling;
  }

  move(event: PointerEvent): void {
    const point = this.points.get(event.pointerId);
    if (point) {
      point.y = event.clientY;
    }
  }

  clear(): void {
    this.start = undefined;
    this.points.clear();
    this.scrolling = false;
  }

  up(
    event: PointerEvent,
    remote: { width: number; height: number },
  ): HumanInterventionInput | undefined {
    this.move(event);
    if (this.scrolling) {
      const points = [...this.points.values()];
      const distance =
        points.reduce((sum, point) => sum + point.y - point.startY, 0) / points.length;
      this.points.delete(event.pointerId);
      if (!this.points.size) {
        this.scrolling = false;
      }
      if (points.length > 1 && Math.abs(distance) > 12) {
        return { kind: "press", key: distance < 0 ? "PageDown" : "PageUp" };
      }
      return undefined;
    }
    this.points.delete(event.pointerId);
    const start = this.start;
    this.start = undefined;
    if (
      !(event.currentTarget instanceof HTMLImageElement) ||
      !start ||
      start.pointerId !== event.pointerId ||
      !remote.width ||
      !remote.height
    ) {
      return undefined;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const from = resolveHumanBrowserPoint({ clientX: start.x, clientY: start.y }, bounds, remote);
    const to = resolveHumanBrowserPoint(event, bounds, remote);
    return Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12
      ? { kind: "dragCoords", ...from, endX: to.x, endY: to.y }
      : { kind: "clickCoords", ...to };
  }
}

export function isSameHumanBrowserPoint(
  first: { x: number; y: number },
  second: { x: number; y: number },
  bounds: Pick<DOMRect, "width" | "height">,
  remote: { width: number; height: number },
): boolean {
  return (
    Math.hypot(
      ((first.x - second.x) * Math.max(1, bounds.width)) / remote.width,
      ((first.y - second.y) * Math.max(1, bounds.height)) / remote.height,
    ) <= 12
  );
}
