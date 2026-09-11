import { css } from "lit";

export const humanInterventionStyles = css`
  :host {
    display: block;
    min-height: 100dvh;
    color: var(--text);
    background: var(--bg);
  }

  * {
    box-sizing: border-box;
  }

  .page {
    width: min(100%, 920px);
    min-height: 100dvh;
    margin: 0 auto;
    padding: max(12px, var(--safe-area-top, 0px)) max(12px, var(--safe-area-right, 0px))
      max(12px, var(--safe-area-bottom, 0px)) max(12px, var(--safe-area-left, 0px));
    display: grid;
    align-content: start;
    gap: 8px;
  }

  .page--control {
    height: 100dvh;
    grid-template-rows: auto minmax(0, 1fr) auto;
    align-content: stretch;
  }

  .page--message {
    place-content: center;
    justify-items: center;
  }
  .message-card {
    display: grid;
    gap: 20px;
    width: min(100%, 420px);
    padding: 28px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--bg-elevated);
    text-align: center;
  }
  .message-card h1 {
    font-size: 24px;
    line-height: 1.2;
  }
  .message-card p {
    margin: 0;
    line-height: 1.5;
    color: var(--muted);
  }
  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .context {
    font-size: 13px;
    color: var(--muted);
    max-height: 24dvh;
    overflow: auto;
  }
  .context summary {
    padding-block: 6px;
  }
  .context p {
    margin-block: 6px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  header {
    display: grid;
    gap: 6px;
  }
  h1 {
    margin: 0;
    font-size: clamp(16px, 3vw, 20px);
    overflow-wrap: anywhere;
    line-height: 1.15;
  }
  .reason,
  .status,
  .error {
    margin: 0;
    line-height: 1.45;
  }
  .status {
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }

  .viewer {
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--bg-accent);
    min-height: 0;
    min-width: 0;
    position: relative;
    touch-action: none;
  }

  .frame {
    display: block;
    width: calc(100% * var(--human-browser-zoom));
    height: auto;
    object-fit: contain;
    object-position: top left;
    user-select: none;
    -webkit-user-drag: none;
    touch-action: none;
  }

  .viewer-empty {
    height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
    color: var(--text-strong);
    text-align: center;
  }

  .hint {
    position: sticky;
    bottom: 8px;
    width: fit-content;
    margin: 8px auto;
    padding: 6px 12px;
    border-radius: 8px;
    background: var(--bg-elevated);
    color: var(--text);
    font-size: 13px;
    pointer-events: none;
  }
  .toolbar,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .toolbar {
    justify-content: flex-end;
  }
  .actions {
    padding-top: 4px;
  }
  .canvas-keyboard {
    position: fixed;
    left: 0;
    bottom: 0;
    width: 1px;
    height: 1px;
    padding: 0;
    opacity: 0;
    font-size: 16px;
  }

  button {
    min-height: 44px;
    border-radius: 10px;
    border: 1px solid var(--border);
    font: inherit;
    padding: 0 14px;
    background: var(--bg-elevated);
    color: inherit;
    font-weight: 600;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-foreground);
  }
  button.danger {
    color: var(--danger);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  @media (pointer: coarse) {
    .toolbar {
      display: none;
    }
  }
  @media (max-width: 640px) {
    .page {
      padding-inline: max(6px, var(--safe-area-left, 0px));
      gap: 6px;
    }
    header {
      padding-inline: 6px;
      gap: 0;
    }
    .toolbar {
      display: none;
    }
    .viewer {
      border-radius: 8px;
    }
    .actions button {
      flex: 1 1 auto;
    }
  }
`;
