# Browser handoff dogfood report

PR #143015. Validation date: 2026-09-10. Installed code candidate: `084f204b4a5279e3a5a7e948a48bf7150865a1c2`.

## Behavior under test

An ordinary owner-authorized direct-chat task encounters a human-only browser step. The agent requests handoff, the Browser plugin sends a complete scoped link and pauses the managed profile, and the human operates the bound tab. **Done — continue agent** revokes human authority and queues continuation in the originating conversation.

The phone viewer uses canvas input: taps, one-finger drag, two-finger scroll, and keyboard insertion at the remote caret. A touch user selects a text field, then taps it again when prompted to open the keyboard. Separate scrolling/text controls and **Leave paused** have been removed. **Cancel handoff** ends the handoff without continuing the task.

## Findings and repairs

- A cross-device attempt showed Gateway sign-in because the agent supplied a bare handoff URL after its request failed with an existing active handoff. No new credential had been issued. The tool now explains this failure and prohibits constructing replacement URLs; missing-credential URLs stay in the handoff viewer with invalid-link guidance.
- Fresh browser access to the Gateway root required normal authentication. A login saved independently in another browser is separate from scoped handoff credentials; the observation did not demonstrate a scoped credential granting administrator access.
- Real SQLite lifecycle proof reproduced rejected records containing explicit `undefined` authority fields. Completion, leave, cancellation, and expiry now omit absent fields at the state producer.
- Periodic tab cleanup now holds the profile automation gate across the asynchronous close. It drains before handoff reservation and preserves an active persisted handoff after runtime-owner recreation.
- Completion failures retire stale local control and refresh authoritative status, exposing pending continuation admission or a retry action.
- Canvas typing now inserts instead of replacing a field. Input is serialized, stale authority is fenced, and editable-focus metadata follows the active iframe chain. Touch keyboard activation occurs synchronously on the second tap.

## Automated proof

- The final Browser run passed 88 tests across 13 suites, including cleanup/registration/coordinator/maintenance, editable focus, input authority, and real Chromium/SQLite control. Removing the cleanup gate reproduced both reservation/close ordering and persisted-handoff cleanup regressions.
- The real browser proof covers bound-tab input, forbidden operations, alternate-handoff rejection, caret insertion, iframe input, lease expiry/reclaim, cancellation/expiry, completion revocation, and admission recovery after reopening SQLite.
- Earlier focused Browser authorization, input normalization, navigation, delivery, and shutdown sibling tests also passed; no full repository suite was run.
- 32 viewer tests passed. Restoring asynchronous touch focus, suppressing the second remote click, and omitting page-change invalidation reproduced the intended mobile-input regressions; missing-token entry was also reproduced before repair.
- Browser/UI production and changed-test typechecks passed. Static guards and keyless i18n baseline passed. Targeted Browser/UI lint, styles, formatting, and the final line/import/assertion guards passed. The full native package build and tarball integrity/import-graph checks passed; no aggregate check pass is claimed.

The Chromium test uses a real browser, dispatcher, HTTP/coordinator boundary, and SQLite plugin-state store. Its scheduler admission callback is a test double. Closing and reopening SQLite runtime owners does not prove a full Gateway process restart or actual chat continuation. Mocked screencast UI captures demonstrate presentation and coordinates, not backend screencast authority.

## Installation and visual proof

A fresh native state archive passed verification. The previous candidate package and service configuration are retained. During maintenance, the existing Gateway shutdown hit its internal watchdog after a 315-second drain with three active tasks and a plugin-disposal timeout; it exited with code 1. This was incomplete shutdown cleanup, not a clean stop.

The native updater staged the tarball but returned `skipped / already-current` because both builds retain package version `2026.9.3`. The exact tarball was then installed through the existing npm prefix, followed by successful `openclaw doctor --fix --non-interactive` and service start. No version or update-channel change was made. Native updater candidate rehearsal was not completed; this installation used the documented manual package/Doctor path.

Package SHA256: `9f53d4820d9db6ddeb647aae682411fcef757430a298d5648200b93accadb90f`. All 10,410 archive payload entries were checked against the installation with no mismatches; only the expected consumed lifecycle marker was absent. Installed build ID: `2026.9.3-084f204b4a52-2026-09-10T22-35-03.240Z`.

The Gateway returned healthy after startup, and Telegram reported configured and running. The served UI build ID and entry script matched the installed candidate. Server-side base-path and asset-URL rewriting explains the expected HTML byte differences.

Built-viewer smoke tests passed at 390px and 1280px widths, both at the root and a custom base path. They verified explicit redemption, cleared URL fragments, no Gateway login, removed controls, tap coordinates, reachable cancellation, and completion. Before/after screenshots were inspected. These flows use mocked scoped HTTP and screencast data.

A separate fresh browser session against the installed live Gateway confirmed that a credential-free focus URL stays in the handoff viewer and shows invalid-link guidance on activation. Navigating to the Gateway root still requires its ordinary token. No Gateway credential was entered during this check.

## Remaining verification

The operator has sent real incoming Telegram tasks and will record the actual Android flow. Valid cross-device redemption, native soft-keyboard behavior, human completion, and continuation in the same chat remain pending that video. Desktop emulation and the backend integration are not physical Android proof.

Telegram Test Server E2E could not run because the required Convex CLI and broker credentials are unavailable. No credentials or sender authority were invented. Full live Gateway restart recovery and real screencast revocation remain distinct proof gaps.

An unused link is a bearer capability that can be redeemed by its first recipient. Browser/runtime and security-owner review must decide whether that satisfies the parent issue's original-owner authentication expectation. The link grants access to a bound tab, not just one website; in-page navigation remains possible. Dependency-guard approval is also outstanding.

The PR is not declared merge-ready. No full repository suite or aggregate changed-check pass is claimed.
