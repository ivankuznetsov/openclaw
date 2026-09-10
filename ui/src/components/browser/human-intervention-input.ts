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

type CanvasBounds = Pick<DOMRect, "left" | "top" | "width" | "height">;
type CanvasPoint = { x: number; y: number };
export type HumanBrowserScroll = Extract<HumanInterventionInput, { kind: "scroll" }>;
export type HumanBrowserMotion =
  | HumanBrowserScroll
  | { kind: "viewport"; scale: number; center: CanvasPoint; deltaX: number; deltaY: number };

function isInsideCanvas(point: CanvasPoint, bounds: CanvasBounds): boolean {
  return (
    bounds.width > 0 &&
    bounds.height > 0 &&
    point.x >= bounds.left &&
    point.y >= bounds.top &&
    point.x <= bounds.left + bounds.width &&
    point.y <= bounds.top + bounds.height
  );
}

/** Viewer gestures never turn blank-space taps or the tail of a pinch into page input. */
export class HumanBrowserPointerGesture {
  private start?: CanvasPoint & { pointerId: number; touch: boolean };
  private points = new Map<number, CanvasPoint>();
  private scrolling = false;
  private multiTouch = false;
  private pinch?: { distance: number; center: CanvasPoint };
  private lastScroll?: CanvasPoint;

  private measurePinch() {
    const [first, second] = [...this.points.values()];
    return first && second
      ? {
          distance: Math.hypot(second.x - first.x, second.y - first.y),
          center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        }
      : undefined;
  }

  down(event: PointerEvent): boolean {
    const point = { x: event.clientX, y: event.clientY };
    if (event.pointerType === "touch") {
      this.points.set(event.pointerId, point);
      if (this.points.size > 1) {
        this.multiTouch = true;
        this.start = undefined;
        this.pinch = this.measurePinch();
      }
    }
    if (!this.multiTouch) {
      this.start = { ...point, pointerId: event.pointerId, touch: event.pointerType === "touch" };
      this.lastScroll = point;
      this.scrolling = false;
    }
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    return this.multiTouch;
  }

  move(
    event: PointerEvent,
    bounds: CanvasBounds,
    remote: { width: number; height: number },
  ): HumanBrowserMotion | undefined {
    if (!this.points.has(event.pointerId)) {
      return undefined;
    }
    const point = { x: event.clientX, y: event.clientY };
    this.points.set(event.pointerId, point);
    if (this.multiTouch) {
      const prior = this.pinch;
      this.pinch = this.measurePinch();
      return prior && this.pinch
        ? {
            kind: "viewport",
            scale: prior.distance > 0 ? this.pinch.distance / prior.distance : 1,
            center: this.pinch.center,
            deltaX: this.pinch.center.x - prior.center.x,
            deltaY: this.pinch.center.y - prior.center.y,
          }
        : undefined;
    }
    if (!this.start || !this.lastScroll || !bounds.width || !bounds.height) {
      return undefined;
    }
    if (!this.scrolling && Math.hypot(point.x - this.start.x, point.y - this.start.y) <= 8) {
      return undefined;
    }
    this.scrolling = true;
    const deltaX = ((this.lastScroll.x - point.x) * remote.width) / bounds.width;
    const deltaY = ((this.lastScroll.y - point.y) * remote.height) / bounds.height;
    this.lastScroll = point;
    if (!deltaX && !deltaY) {
      return undefined;
    }
    const anchor = humanBrowserScrollAnchor(event, bounds, remote);
    return {
      kind: "scroll",
      ...anchor,
      deltaX: Math.max(-8192, Math.min(8192, deltaX)),
      deltaY: Math.max(-8192, Math.min(8192, deltaY)),
    };
  }

  clear(): void {
    this.start = undefined;
    this.points.clear();
    this.scrolling = false;
    this.multiTouch = false;
    this.pinch = undefined;
    this.lastScroll = undefined;
  }

  up(
    event: PointerEvent,
    bounds: CanvasBounds,
    remote: { width: number; height: number },
  ): HumanInterventionInput | undefined {
    const motion = this.move(event, bounds, remote);
    this.points.delete(event.pointerId);
    if (this.multiTouch) {
      if (!this.points.size) {
        this.clear();
      }
      return undefined;
    }
    const start = this.start;
    const scrolled = this.scrolling;
    this.clear();
    if (scrolled) {
      return motion?.kind === "scroll" ? motion : undefined;
    }
    const end = { x: event.clientX, y: event.clientY };
    if (
      !start ||
      start.pointerId !== event.pointerId ||
      !remote.width ||
      !remote.height ||
      !isInsideCanvas(start, bounds)
    ) {
      return undefined;
    }
    const from = resolveHumanBrowserPoint({ clientX: start.x, clientY: start.y }, bounds, remote);
    const to = resolveHumanBrowserPoint(event, bounds, remote);
    if (!start.touch && Math.hypot(end.x - start.x, end.y - start.y) > 12) {
      return { kind: "dragCoords", ...from, endX: to.x, endY: to.y };
    }
    return isInsideCanvas(end, bounds) ? { kind: "clickCoords", ...to } : undefined;
  }
}

/** Merge only adjacent queued wheel input, retaining its most recent pointer position. */
export function mergeHumanBrowserScroll(
  previous: HumanBrowserScroll | undefined,
  action: HumanBrowserScroll,
): HumanBrowserScroll {
  return {
    ...action,
    deltaX: Math.max(-8192, Math.min(8192, action.deltaX + (previous?.deltaX ?? 0))),
    deltaY: Math.max(-8192, Math.min(8192, action.deltaY + (previous?.deltaY ?? 0))),
  };
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

export function applyHumanBrowserViewport(
  viewer: HTMLElement,
  frame: HTMLImageElement,
  motion: Extract<HumanBrowserMotion, { kind: "viewport" }>,
  previousZoom: number,
): number {
  const zoom = Math.max(1, Math.min(3, previousZoom * motion.scale));
  const scale = zoom / previousZoom;
  const bounds = viewer.getBoundingClientRect();
  const x = motion.center.x - bounds.left;
  const y = motion.center.y - bounds.top;
  frame.style.setProperty("--human-browser-zoom", String(zoom));
  viewer.scrollLeft = (viewer.scrollLeft + x - motion.deltaX) * scale - x;
  viewer.scrollTop = (viewer.scrollTop + y - motion.deltaY) * scale - y;
  return zoom;
}

function humanBrowserScrollAnchor(
  event: { clientX: number; clientY: number },
  bounds: CanvasBounds,
  remote: { width: number; height: number },
): CanvasPoint {
  const point = resolveHumanBrowserPoint(event, bounds, remote);
  return {
    x: Math.min(point.x, Math.max(0, remote.width - 1)),
    y: Math.min(point.y, Math.max(0, remote.height - 1)),
  };
}

export function humanBrowserWheel(
  event: WheelEvent,
  frame: HTMLImageElement,
  remote: { width: number; height: number },
): HumanBrowserScroll {
  const bounds = frame.getBoundingClientRect();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
  return {
    kind: "scroll",
    ...humanBrowserScrollAnchor(event, bounds, remote),
    deltaX: (event.deltaX * unit * remote.width) / Math.max(1, bounds.width),
    deltaY: (event.deltaY * unit * remote.height) / Math.max(1, bounds.height),
  };
}
