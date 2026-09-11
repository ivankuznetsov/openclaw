# Mobile browser handoff dogfood report

PR #143015. Validation date: 2026-09-11. Code candidate: `1fb3574551b02243d6fea0a08c308908e476c960`.

## Behavior under test

The phone viewer gives the remote browser more space and moves task details out of the main interaction area. One-finger swipes scroll, including swipes that begin in blank viewer space. Scrolling sends pixel wheel input to the bound browser tab, so a focused text field does not receive navigation keys. Pinch gestures zoom the viewer without producing a trailing tap.

The handoff remains bound to one browser tab and its current control authority. It does not restrict that tab to one website or prevent in-page navigation. Scoped handoff credentials are separate from normal Gateway authentication.

## Automated proof

- 102 Browser tests and 39 UI tests passed. Browser coverage includes normalized wheel coordinates and deltas, handoff target binding, authority revocation before movement and after awaited movement, and real Chromium scrolling while a text field remains focused. The alternate tab stays unchanged.
- Browser/UI production and changed-test typechecks passed. UI typed lint, styles, formatting, static guards, and the keyless i18n baseline passed.
- Browser typed lint did not reach lint execution: SDK declaration preparation exceeded its 300-second deadline twice. No rules or declaration-boundary checks were weakened. This remains an incomplete check.
- The full native package build and package tarball integrity/import-graph checks passed. No full repository suite or aggregate changed-check pass is claimed.

The backend integration uses real Chromium, browser dispatch, HTTP/coordinator handling, and SQLite plugin state. Scheduler admission remains a test double; this does not prove actual Telegram continuation or a full Gateway process restart.

## Mobile presentation and gestures

The built viewer passed a smoke test using mocked scoped HTTP responses and screencast frames. Real Chromium touch events were driven through CDP emulation.

| Emulated viewport | Viewer height     | Result                                                                                |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------- |
| 390 × 844         | 709.47 CSS pixels | Blank-area swipe, pinch zoom, no trailing tap, text-field hint, and completion passed |
| 360 × 800         | 665.47 CSS pixels | Compact mobile layout captured and inspected                                          |

Six inspected synthetic captures cover browser control at both widths, task details, text entry guidance, completion, and an expired link. All six images are ready in the operator-requested Screenote review. No credentials or live account data appear in the captures.

These captures prove presentation and gesture routing against a mocked backend. They do not prove live screencast authority or native Android keyboard behavior.

## Installation

The existing installation now runs code `1fb3574551b02243d6fea0a08c308908e476c960`, build `2026.9.3-1fb3574551b0-2026-09-10T23-59-35.299Z`. The native backup was verified before installation and the previous package was retained. The same-version candidate was installed through the existing npm owner, followed by the native doctor and service start.

All 10,410 archive entries matched the installed package, apart from the expected consumed lifecycle marker. Artifact SHA-256: `58af73b769c587bc00fc42ac2e7eeecfb08f7b1766c9cb2d36323c3fad8a4902`. The served UI build identity and entry-script bytes match the installed package. Gateway health passed and Telegram is configured and running.

Shutdown reached the normal 315-second active-work drain limit with three tasks still active, then completed server shutdown cleanly. This is not proof that those tasks finished or that handoff continuation survived restart.

A fresh browser context opened a missing-credential handoff URL directly to the invalid-link message. Navigating to the Gateway root still required its normal token. No credentials were entered.

## Remaining verification

The operator will record the actual Telegram/Android flow. Valid cross-device redemption, native keyboard activation, human completion, and continuation in the original chat remain pending that recording. Telegram Test Server E2E remains unavailable without its required leased credentials and tooling.

Security-owner review of first-redeemer bearer links remains separate from this proof. Browser typed lint, live Gateway restart recovery, and real screencast revocation also remain outstanding. This report does not declare the PR merge-ready.
