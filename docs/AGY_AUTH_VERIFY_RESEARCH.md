# AGY OAuth + Eligibility Verification — Research & Design Notes

Date: 2026-08-08

## Goal

Extend `dockerstack-agycli-auth` so the web flow follows AGY's official account
eligibility process after OAuth:

1. Capture URL #1 for Google OAuth.
2. Submit the authorization code into the same AGY PTY/PKCE session.
3. Wait for the OAuth credential file, but **do not treat credential creation as
   final success**.
4. Let AGY run its normal eligibility check.
5. If AGY prints its official account verification URL, expose it as URL #2.
6. After the user completes browser verification, re-check eligibility using the
   existing OAuth credential (no second OAuth code exchange).
7. Save the token only after positive evidence that AGY can pass the eligibility
   gate and execute the verification probe.

This design automates the supported AGY/Google flow. It does not bypass account,
region, subscription, age, or other eligibility controls.

## Why a real PTY is required

AGY authentication and onboarding are terminal-interactive. More importantly,
the OAuth flow uses PKCE: the authorization code is tied to the verifier created
by the process/session that generated URL #1. Starting a new `agy` process just
to submit the code can produce a verifier mismatch.

The web backend therefore keeps one real PTY alive from URL #1 through code
submission and onboarding. A 2000-column PTY is used to reduce terminal wrapping
of long Google URLs. URL parsing additionally uses an incremental buffer so a URL
split across two PTY reads is reconstructed before it is emitted.

## Upstream AGY observations

Official changelog:
https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md

Relevant changes observed in the official changelog:

- `1.0.1`: OAuth token persistence/authentication hangs fixed.
- `1.1.2`: print mode gained OAuth authorization-code paste through the
  controlling terminal (`/dev/tty` / `CONIN$`), and truly headless runs fail
  instead of blocking.
- `1.1.3`: eligibility errors that include a verification URL are shown inline
  in the input loop. This strongly supports capturing URL #2 from the normal
  interactive PTY rather than trying to construct it ourselves.
- `1.1.4`: real eligibility failure reasons were restored instead of the generic
  `unknown reason` message.
- `1.1.7`: print mode was fixed so a prompt waits until account eligibility is
  complete; the changelog explicitly notes that the previous behavior could let
  ineligible accounts pass the check that interactive mode enforced.

Design consequence: this project uses interactive PTY behavior as the source of
truth and never adds a `skip eligibility` path.

## Upstream failure modes worth classifying separately

### Verification URL can be temporary

Issue #688 reports OAuth succeeding and an eligibility verification URL later
returning HTTP 400 when opened after the fact:
https://github.com/google-antigravity/antigravity-cli/issues/688

Design consequence:

- Display URL #2 immediately.
- Do not store it as a durable credential.
- Let `Check Again` obtain the current AGY result and a new URL if AGY still
  requires verification.

### Profile-image/network failures can look like eligibility failures

Issue #621 reports fatal eligibility startup failures when
`lh3.googleusercontent.com` is blocked or TLS inspection causes x509 failures:
https://github.com/google-antigravity/antigravity-cli/issues/621

Design consequence: `403`, x509/TLS, profile-picture failures, EOF, DNS failure,
timeout, reset-by-peer, and similar backend/network symptoms must not be shown as
`verification required` unless AGY actually emits URL #2.

### Proxy handling has had regressions

Issue #181 reports eligibility requests ignoring `HTTPS_PROXY`/`HTTP_PROXY` in a
corporate network:
https://github.com/google-antigravity/antigravity-cli/issues/181

Issue #415 reports a version-specific eligibility connection-reset regression:
https://github.com/google-antigravity/antigravity-cli/issues/415

Design consequence:

- Record the installed AGY version in login diagnostics.
- Keep network/backend errors retryable and distinct from account verification.
- In production, optionally set `AGYCLI_AUTH_AGY_EXPECTED_VERSION` after testing
  a known-good AGY version. The Docker build then fails if Google's installer
  unexpectedly returns another version.
- Healthcheck executes `agy --version`, not just `command -v agy`.

## Implemented state machine

```text
starting
  -> waiting_url
  -> url_ready / waiting_code
  -> credential_wait
  -> checking_eligibility
       -> verified
            -> save Firebase token
            -> success
       -> verification_required
            -> show official URL #2
            -> checking_verification
                 -> verified -> save -> success
                 -> verification_required -> show current URL #2 again
                 -> eligibility_error / eligibility_unknown
       -> eligibility_error / eligibility_unknown
```

## Positive verification evidence

The system does **not** conclude `verified` just because no URL #2 appeared for a
fixed number of seconds.

Once AGY reaches the interactive prompt, the PTY driver submits a per-run nonce
probe such as:

```text
Reply exactly with AGY_ELIGIBILITY_OK_<pid>_<timestamp>
```

The driver only emits `verified` after a response-like line containing that nonce
is observed. If there is no conclusive response before the configured timeout,
the result becomes `eligibility_inconclusive_no_probe_response` and the token is
not saved.

## New configuration

```env
# Optional production guard; empty = accept the version installed upstream.
AGYCLI_AUTH_AGY_EXPECTED_VERSION=

# PTY auth/eligibility flow timeout (seconds).
AGYCLI_AUTH_AGY_LOGIN_FLOW_TIMEOUT_SEC=420

# Maximum wait for a positive probe response (seconds).
AGYCLI_AUTH_AGY_LOGIN_VERIFY_WAIT_SEC=45

# Credential file wait after OAuth code submit (milliseconds).
AGYCLI_AUTH_AGY_CREDENTIAL_CHECK_TIMEOUT_MS=60000

# Normal login session timeout (milliseconds).
AGYCLI_AUTH_SESSION_TIMEOUT_MS=600000

# Extended timeout while the user completes URL #2 (milliseconds).
AGYCLI_AUTH_VERIFICATION_SESSION_TIMEOUT_MS=1200000
```

## Operational recommendations

1. Test a specific AGY build in staging before changing the production version
   guard.
2. Keep the raw URL #2 ephemeral; do not persist it to Firebase or long-lived
   logs.
3. When eligibility fails without URL #2, inspect the classified reason before
   asking the user to verify. Network, location, credential, and backend errors
   need different remediation.
4. Keep SSE replay enabled so reconnecting browsers recover URL #1, URL #2, and
   final token-saved state.
5. If AGY changes its TUI wording, prefer adding a new conservative pattern and
   returning `unknown` over guessing `verified`.
