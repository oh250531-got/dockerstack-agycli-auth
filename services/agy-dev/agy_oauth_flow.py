#!/usr/bin/env python3
"""PTY driver for Antigravity CLI authentication + official eligibility verification.

This intentionally does NOT bypass AGY account eligibility. It drives the normal CLI
flow, captures the OAuth URL and, when AGY requires it, the official Google account
verification URL printed by AGY.

Structured stdout markers consumed by the web app:
  __AGY_OAUTH_URL__=<url>
  __AGY_VERIFY_URL__=<url>
  __AGY_FLOW_STATUS__=<status>
  __AGY_FLOW_ERROR__=<reason>
"""

import argparse
import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time

URL_RE = re.compile(rb"(?i)\bhttps?://[^\s\x1b\x07<>\"'{}|\\^`\x00-\x1f]+")

VERIFY_HOST_PATH = b"accounts.google.com/signin/continue"
OAUTH_HOST_PATH = b"accounts.google.com/o/oauth2/auth"

NETWORK_ERROR_PATTERNS = (
    "connection reset by peer",
    "timed out",
    "timeout",
    "context deadline exceeded",
    "no such host",
    "temporary failure in name resolution",
    "tls: failed to verify certificate",
    "x509:",
    " eof",
    "request failed (code 403)",
    "403 forbidden",
)

INELIGIBLE_PATTERNS = (
    "your current account is not eligible for antigravity",
    "account ineligible",
    "verify your account to continue",
)

LOCATION_PATTERNS = (
    "not currently available in your location",
    "user location is not supported for the api use",
)


def emit_marker(name: str, value: str) -> None:
    value = str(value).replace("\r", " ").replace("\n", " ")
    print(f"__AGY_{name}__={value}", flush=True)


def strip_ansi(data: bytes) -> str:
    text = data.decode("utf-8", "replace")
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b[()][A-Z0-9]", "", text)
    text = re.sub(r"\x1b[@-Z\\-_]", "", text)
    text = re.sub(r"\x1b[=>]", "", text)
    return text


def clean_url(u: bytes) -> bytes:
    open_p = u.count(b"(")
    close_p = u.count(b")")
    while u:
        last = u[-1:]
        if last in b")];.,:>\"'}":
            if last == b")" and open_p >= close_p:
                break
            u = u[:-1]
        else:
            break
    return u


def collect_urls(blob: bytes):
    out = []
    for m in URL_RE.finditer(blob):
        u = clean_url(m.group(0))
        if u not in out:
            out.append(u)
    return out


def read_code_file(path: str):
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            value = f.read().strip()
        if not value:
            return None
        try:
            os.remove(path)
        except OSError:
            pass
        return value.encode("utf-8")
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("login", "eligibility"), default="login")
    ap.add_argument("--code-file", default=None)
    ap.add_argument("--timeout", type=int, default=420)
    ap.add_argument("--verify-wait", type=int, default=45,
                    help="Seconds to wait after prompt submission before treating the account as verified.")
    ap.add_argument("--agy-binary", default=None)
    ap.add_argument("--prompt", default="Reply with OK")
    args = ap.parse_args()

    # A successful interactive model response is our positive evidence that the
    # normal AGY eligibility gate has completed. Use a per-process nonce so TUI
    # echoes of the prompt cannot be confused with the assistant response.
    probe_token = f"AGY_ELIGIBILITY_OK_{os.getpid()}_{int(time.time() * 1000)}"
    probe_prompt = f"Reply exactly with {probe_token}"

    agy = args.agy_binary or os.path.expanduser("~/.local/bin/agy")
    if not os.path.exists(agy):
        emit_marker("FLOW_ERROR", "agy_binary_missing")
        return 127

    cols, rows = 2000, 60
    deadline = time.time() + max(30, args.timeout)

    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env["COLUMNS"] = str(cols)
        env["LINES"] = str(rows)
        env["PATH"] = os.path.dirname(agy) + ":" + env.get("PATH", "")
        os.execvpe(agy, [agy, "-i", probe_prompt], env)
        os._exit(127)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    raw = bytearray()
    url_stream = bytearray()
    seen_urls = []
    oauth_url = None
    verify_url = None
    menu_done = False
    login_needed = False
    code_prompt_seen = None
    code_sent = False
    theme_done = False
    tos_done = False
    trust_done = False
    chat_ready_at = None
    prompt_sent = False
    prompt_sent_at = None
    prompt_raw_offset = None
    failure_seen_at = None
    final_status = None
    final_error = None

    def send(data: bytes):
        try:
            os.write(fd, data)
        except OSError:
            pass

    emit_marker("FLOW_STATUS", "starting")

    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                data = os.read(fd, 16384)
            except OSError:
                break
            if not data:
                break
            raw += data
            url_stream += data

            # Echo the raw PTY stream so the web app can retain diagnostics.
            try:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            except BrokenPipeError:
                return 1

            # Minimal terminal capability replies.
            reply = b""
            if b"\x1b[c" in data:
                reply += b"\x1b[?62;1;6c"
            if b"\x1b[>c" in data:
                reply += b"\x1b[>0;0;0c"
            if b"\x1b[6n" in data:
                reply += b"\x1b[1;1R"
            if b"\x1b[>q" in data:
                reply += b"\x1b[>0;1.1.11;0c"
            for mode in re.findall(rb"\x1b\[\?([0-9;]+)\$p", data):
                reply += b"\x1b[?" + mode + b";2$y"
            if b"\x1b[?u" in data:
                reply += b"\x1b[?u;1$y"
            if b"\x1b[=u" in data:
                reply += b"\x1b[=u;1;0$y"
            if reply:
                send(reply)

            # Capture official URLs exactly as printed by AGY. Scan an
            # incremental buffer rather than only the current read() chunk: PTY
            # output can split a long URL across arbitrary reads. A regex match
            # ending at the buffer boundary is held until a delimiter arrives,
            # preventing a truncated URL from being emitted prematurely.
            scan_blob = bytes(url_stream)
            for m in URL_RE.finditer(scan_blob):
                if m.end() == len(scan_blob):
                    continue
                u = clean_url(m.group(0))
                if u not in seen_urls:
                    seen_urls.append(u)
                if oauth_url is None and OAUTH_HOST_PATH in u:
                    oauth_url = u
                    emit_marker("OAUTH_URL", u.decode("utf-8", "replace"))
                    emit_marker("FLOW_STATUS", "oauth_url_ready")
                if verify_url is None and VERIFY_HOST_PATH in u:
                    verify_url = u
                    emit_marker("VERIFY_URL", u.decode("utf-8", "replace"))
                    emit_marker("FLOW_STATUS", "verification_required")
                    final_status = "verification_required"

            if len(url_stream) > 65536:
                last_http = max(url_stream.rfind(b"http://"), url_stream.rfind(b"https://"))
                if last_http >= 0:
                    url_stream = bytearray(url_stream[last_http:])
                else:
                    url_stream = bytearray(url_stream[-2048:])

        text = strip_ansi(bytes(raw))
        low = text.lower()

        # In eligibility-only mode, a fresh login menu means persisted credentials
        # are absent/expired. Never silently start a new OAuth flow here.
        if args.mode == "eligibility" and (
            "select login method" in low or "select a login method" in low
        ):
            final_error = "credential_missing_or_expired"
            emit_marker("FLOW_ERROR", final_error)
            break

        # Login mode: select Google OAuth only when AGY explicitly shows the menu.
        if args.mode == "login" and not menu_done and (
            "select login method" in low or "select a login method" in low
        ) and "google oauth" in low:
            login_needed = True
            time.sleep(0.4)
            send(b"\r")
            menu_done = True
            emit_marker("FLOW_STATUS", "oauth_selected")

        # Feed auth code through the code file. With --code-file we NEVER fall
        # back to blocking stdin; the web backend can create the file later.
        if args.mode == "login" and oauth_url and not code_sent and "authorization code" in low:
            if code_prompt_seen is None:
                code_prompt_seen = time.time()
                emit_marker("FLOW_STATUS", "waiting_code")
            if time.time() - code_prompt_seen > 0.5:
                code = read_code_file(args.code_file) if args.code_file else None
                if code:
                    send(code + b"\r")
                    code_sent = True
                    emit_marker("FLOW_STATUS", "code_submitted")

        active_after_auth = args.mode == "eligibility" or code_sent or not login_needed

        # Onboarding screens. The exact TUI can change between AGY releases; keep
        # pattern matching conservative and send only the minimum expected keys.
        if active_after_auth and not theme_done and (
            "choose your color scheme" in low or "color scheme" in low
        ):
            time.sleep(0.35)
            send(b"\r")
            theme_done = True
            emit_marker("FLOW_STATUS", "onboarding_theme_done")

        if active_after_auth and not tos_done and "terms of service" in low:
            time.sleep(0.35)
            send(b" ")
            time.sleep(0.15)
            send(b"\x1b[B")
            time.sleep(0.10)
            send(b"\x1b[C")
            time.sleep(0.10)
            send(b"\r")
            tos_done = True
            emit_marker("FLOW_STATUS", "onboarding_tos_done")

        if active_after_auth and not trust_done and "do you trust the contents" in low:
            time.sleep(0.30)
            send(b"\r")
            trust_done = True
            emit_marker("FLOW_STATUS", "onboarding_trust_done")

        if not prompt_sent and "? for shortcuts" in low:
            if chat_ready_at is None:
                chat_ready_at = time.time()
            if time.time() - chat_ready_at > 0.8:
                send(b"\r")
                prompt_sent = True
                prompt_sent_at = time.time()
                prompt_raw_offset = len(raw)
                emit_marker("FLOW_STATUS", "eligibility_checking")

        # Hard OAuth/PKCE failures.
        if "invalid code verifier" in low or "token exchange failed" in low or "invalid_grant" in low:
            final_error = "oauth_token_exchange_failed"
            emit_marker("FLOW_ERROR", final_error)
            break

        # Location/region ineligibility is not solved by a verification URL.
        if any(p in low for p in LOCATION_PATTERNS):
            final_error = "eligibility_location_unsupported"
            emit_marker("FLOW_ERROR", final_error)
            break

        # Network/backend failures should not be misreported as "needs verify".
        if "eligibility check failed" in low and any(p in low for p in NETWORK_ERROR_PATTERNS):
            final_error = "eligibility_network_error"
            emit_marker("FLOW_ERROR", final_error)
            break

        if "eligibility check failed" in low or any(p in low for p in INELIGIBLE_PATTERNS):
            if failure_seen_at is None:
                failure_seen_at = time.time()
            # Give AGY time to print its official URL after the reason text.
            if verify_url is None and time.time() - failure_seen_at > 8:
                final_error = "eligibility_failed_without_verify_url"
                emit_marker("FLOW_ERROR", final_error)
                break

        if verify_url is not None:
            # Keep the PTY alive briefly so wrapped URL bytes / final diagnostics
            # finish streaming, then return an explicit verification-required state.
            time.sleep(1.0)
            break

        # Positive result: require an actual assistant response containing our
        # nonce on a response-like line. The submitted user prompt itself contains
        # the nonce too, so exclude lines that contain "Reply exactly". This is
        # stronger evidence than merely waiting N seconds with no verify URL.
        if prompt_sent and failure_seen_at is None and prompt_raw_offset is not None:
            post_prompt = strip_ansi(bytes(raw[prompt_raw_offset:]))
            response_seen = any(
                probe_token in line and "reply exactly" not in line.lower()
                for line in post_prompt.splitlines()
            )
            if response_seen:
                final_status = "verified"
                emit_marker("FLOW_STATUS", final_status)
                break

            if prompt_sent_at is not None and time.time() - prompt_sent_at >= max(10, args.verify_wait):
                final_error = "eligibility_inconclusive_no_probe_response"
                emit_marker("FLOW_ERROR", final_error)
                break

    if time.time() >= deadline and final_status is None and final_error is None:
        final_error = "flow_timeout"
        emit_marker("FLOW_ERROR", final_error)

    try:
        os.kill(pid, 15)
    except OSError:
        pass

    if final_status == "verification_required":
        return 10
    if final_status == "verified":
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
