/** Kept separate from the viewer so normal app boot does not load browser controls. */
export type HandoffAccess = {
  id: string;
  basePath?: string;
  storageKey: string;
  token?: string;
  sessionToken?: string;
  storageUnavailable?: boolean;
};

export function captureHandoffAccess(): HandoffAccess | null {
  const match = location.pathname.match(/^(.*)\/focus\/browser\/([^/]+)\/?$/u);
  if (!match?.[2]) {
    return null;
  }
  let id: string;
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const basePath = match[1];
  const storageKey = `openclaw.handoff:${location.origin}${basePath}:${id}`;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const supplied = fragment.has("handoffToken");
  const token = fragment.get("handoffToken") ?? undefined;
  let saved: Pick<HandoffAccess, "token" | "sessionToken"> = {};
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw) {
      // SAFETY: only string token fields are retained; invalid/null storage is ignored below.
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      saved = {
        token: typeof parsed.token === "string" ? parsed.token : undefined,
        sessionToken: typeof parsed.sessionToken === "string" ? parsed.sessionToken : undefined,
      };
    }
  } catch {
    // A fresh link still gets a useful storage error rather than gateway login.
  }
  // A missing credential must stay in the handoff viewer, never boot Gateway administration.
  const access: HandoffAccess = { id, basePath, storageKey, ...saved };
  if (supplied) {
    access.token = token;
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ token, sessionToken: saved.sessionToken }),
      );
    } catch {
      access.storageUnavailable = true;
    }
    // Never retain the capability in history, copied addresses, or referrers.
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  }
  return access;
}
