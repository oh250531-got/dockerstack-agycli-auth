"use strict";

/* ═══════════════════════════════════════════════════════════════
   app.js — AGY Auth WebApp Frontend
   3-screen SSE-driven flow + token list page.
   ═══════════════════════════════════════════════════════════════ */

// ─── State ──────────────────────────────────────────────────────────────────

const state = {
  sessionId: null,
  email: null,
  authUrl: null,
  verifyUrl: null,
  eligibilityStatus: "unknown",
  stage: "idle",
  sse: null,
  screen: 1, // 1 = start, 2 = authorize, 3 = success, 0 = error
  reconnects: 0,
  maxReconnects: 3,
  tokenDetails: new Map(),
  previewText: "",
  loginLogs: [],
  loginSnapshot: null,
  tokenRows: [],
  tokenSort: { field: "updatedAt", direction: "desc" },
};

// ─── DOM refs ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const dom = {
  screen1: $("screen-1"),
  screen2: $("screen-2"),
  screen3: $("screen-3"),
  screenError: $("screen-error"),

  inputEmail: $("input-email"),
  inputCode: $("input-code"),
  errorEmail: $("error-email"),
  errorCode: $("error-code"),
  authUrlLink: $("auth-url-link"),
  authUrlBox: $("auth-url-box"),
  authBadge: $("auth-badge"),
  sessionBadge: $("session-badge"),
  spinnerCode: $("spinner-code"),
  spinnerCodeText: $("spinner-code-text"),
  oauthFlowPanel: $("oauth-flow-panel"),
  verifyPanel: $("verify-panel"),
  verifyUrlContainer: $("verify-url-container"),
  verifyUrlLink: $("verify-url-link"),
  spinnerVerify: $("spinner-verify"),
  eligibilityMessage: $("eligibility-message"),
  eligibilityTitle: $("eligibility-title"),
  eligibilityDescription: $("eligibility-description"),

  btnStart: $("btn-start"),
  btnOpenUrl: $("btn-open-url"),
  btnOpenVerifyUrl: $("btn-open-verify-url"),
  btnCheckVerification: $("btn-check-verification"),
  checkVerificationLabel: $("check-verification-label"),
  btnSubmitCode: $("btn-submit-code"),
  btnPasteConfirm: $("btn-paste-confirm"),
  btnLoginAnother: $("btn-login-another"),
  btnTryAgain: $("btn-try-again"),
  btnResetSession: $("btn-reset-session"),
  btnRefreshTokens: $("btn-refresh-tokens"),
  btnExportExcel: $("btn-export-excel"),
  btnBackupTokens: $("btn-backup-tokens"),
  btnRestoreTokens: $("btn-restore-tokens"),
  inputRestoreFile: $("input-restore-file"),
  btnRefresh: $("btn-refresh"),

  successEmail: $("success-email"),
  successKey: $("success-key"),
  successTime: $("success-time"),
  errorMessage: $("error-message"),
  loginLogPanel: $("login-log-panel"),
  loginLogBadge: $("login-log-badge"),
  loginLogStream: $("login-log-stream"),
  loginSnapshotPanel: $("login-snapshot-panel"),
  loginSnapshotContent: $("login-snapshot-content"),

  sidebarStatusText: $("sidebar-status-text"),
  topbarTitle: $("topbar-title"),

  pageLogin: $("page-login"),
  pageTokens: $("page-tokens"),

  steps: $("steps"),
  line1to2: $("line-1-2"),
  line2to3: $("line-2-3"),

  tokensBody: $("tokens-body"),
  tokenDetailPanel: $("token-detail-panel"),
  tokenDetailMode: $("token-detail-mode"),
  tokenDetailTitle: $("token-detail-title"),
  tokenDetailContent: $("token-detail-content"),
  btnCopyPreview: $("btn-copy-preview"),
  filterEmail: $("filter-email"),
  filterKey: $("filter-key"),
  filterCreated: $("filter-created"),
  filterUpdated: $("filter-updated"),
  btnClearAllFilters: $("btn-clear-all-filters"),
  toastContainer: $("toast-container"),
  deployOrg: $("deploy-org"),
  deployRepo: $("deploy-repo"),
  deployCommitLink: $("deploy-commit-link"),
  deployDate: $("deploy-date"),
  deployHost: $("deploy-host"),
  btnDeployDetails: $("btn-deploy-details"),
  btnCloseDeployModal: $("btn-close-deploy-modal"),
  deployModal: $("deploy-modal"),
  tunnelEndpointsList: $("tunnel-endpoints-list"),
  envVarsList: $("env-vars-list"),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showScreen(n) {
  state.screen = n;
  dom.screen1.classList.toggle("hidden", n !== 1);
  dom.screen2.classList.toggle("hidden", n !== 2);
  dom.screen3.classList.toggle("hidden", n !== 3);
  dom.screenError.classList.toggle("hidden", n !== 0);

  // Update step indicator
  const steps = dom.steps.querySelectorAll(".step");
  steps.forEach((s) => {
    const sn = parseInt(s.dataset.step, 10);
    s.classList.remove("active", "done");
    if (sn < n) s.classList.add("done");
    else if (sn === n) s.classList.add("active");
  });
  dom.line1to2.classList.toggle("done", n >= 2);
  dom.line2to3.classList.toggle("done", n >= 3);
}

function setBadge(badge, text, variant) {
  badge.textContent = text;
  badge.className = "badge badge-" + variant;
}

function toast(msg, variant = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${variant}`;
  el.innerHTML = `<div><div class="toast-title">${msg}</div></div>`;
  dom.toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.2s";
    setTimeout(() => el.remove(), 200);
  }, 4000);
}

function formatTimestamp(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString();
}

function formatTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeBase64Utf8(base64) {
  const binary = atob(base64 || "");
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function copyText(text, label) {
  const value = String(text ?? "");
  try {
    await navigator.clipboard.writeText(value);
  } catch (_) {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  toast(`${label} copied`, "success");
}

function setSidebarStatus(text) {
  dom.sidebarStatusText.textContent = text;
}

function setLoginLogBadge(text, variant = "info") {
  dom.loginLogBadge.textContent = text;
  dom.loginLogBadge.className = "badge badge-" + variant;
}

function resetLoginLogState() {
  state.loginLogs = [];
  state.loginSnapshot = null;
  dom.loginLogStream.innerHTML = '<div class="text-muted">No container log yet.</div>';
  dom.loginSnapshotContent.innerHTML = "";
  dom.loginSnapshotPanel.classList.add("hidden");
  dom.loginLogPanel.classList.add("hidden");
  setLoginLogBadge("Idle", "info");
}

function renderLoginLogs() {
  const hasContent = state.loginLogs.length > 0 || state.loginSnapshot;
  dom.loginLogPanel.classList.toggle("hidden", !hasContent);
  if (!state.loginLogs.length) {
    dom.loginLogStream.innerHTML = '<div class="text-muted">No container log yet.</div>';
    return;
  }

  dom.loginLogStream.innerHTML = state.loginLogs
    .map((entry) => {
      const level = entry.level || "info";
      return `
        <div class="log-line log-line-${escapeHtml(level)}">
          <span class="log-time">${escapeHtml(formatTime(entry.at))}</span>
          <span class="log-level">${escapeHtml(level)}</span>
          <span class="log-message">${escapeHtml(entry.message || "")}</span>
        </div>
      `;
    })
    .join("");
  dom.loginLogStream.scrollTop = dom.loginLogStream.scrollHeight;
}

function appendLoginLog(entry) {
  if (!entry || !entry.message) return;
  if (entry.id && state.loginLogs.some((item) => item.id === entry.id)) return;
  state.loginLogs.push(entry);
  if (state.loginLogs.length > 200) state.loginLogs.shift();
  setLoginLogBadge("Live", "info");
  renderLoginLogs();
}

function renderSnapshotFiles(title, files, variant) {
  const list = Array.isArray(files) ? files : [];
  const visible = list.slice(0, 50);
  const more = list.length - visible.length;
  return `
    <section class="snapshot-section">
      <div class="snapshot-section-title">
        <span class="badge badge-${variant}">${escapeHtml(title)} (${list.length})</span>
      </div>
      ${
        visible.length
          ? `<div class="snapshot-file-list">${visible
              .map((file) => `
                <div class="snapshot-file-row">
                  <span class="snapshot-path">${escapeHtml(file.path || "")}</span>
                  <span class="snapshot-size">[${escapeHtml(file.size ?? 0)} bytes]</span>
                </div>
              `)
              .join("")}</div>`
          : '<div class="text-muted">Không có</div>'
      }
      ${more > 0 ? `<div class="snapshot-more text-muted">+${more} more files in report.md</div>` : ""}
    </section>
  `;
}

function renderSnapshotDownload(snapshot) {
  const output = snapshot.output || {};
  const copiedCount = Number(output.copiedCount ?? output.copied?.length ?? 0);
  const skippedCount = Number(output.skipped || 0);
  const changedCount = Number(snapshot.summary?.added || 0) + Number(snapshot.summary?.modified || 0);

  if (copiedCount > 0 && output.downloadUrl) {
    return `
      <div class="snapshot-actions">
        <a class="btn btn-primary snapshot-download-btn" href="${escapeHtml(output.downloadUrl)}" download="${escapeHtml(output.archiveName || "login-changed-files.tar.gz")}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download add+modify files
        </a>
        <span class="snapshot-download-meta">${escapeHtml(copiedCount)} copied / ${escapeHtml(changedCount)} changed${skippedCount ? ` · ${escapeHtml(skippedCount)} skipped` : ""}</span>
      </div>
    `;
  }

  return `
    <div class="snapshot-actions">
      <button class="btn-light snapshot-download-btn" disabled>No add+modify files to download</button>
      <span class="snapshot-download-meta">${escapeHtml(copiedCount)} copied / ${escapeHtml(changedCount)} changed${skippedCount ? ` · ${escapeHtml(skippedCount)} skipped` : ""}</span>
    </div>
  `;
}

function renderLoginSnapshot(snapshot) {
  if (!snapshot || !snapshot.summary) return;
  state.loginSnapshot = snapshot;
  const s = snapshot.summary;
  dom.loginSnapshotContent.innerHTML = `
    <div class="snapshot-summary">
      Sau login: ${escapeHtml(s.afterCount)} files
      (added=${escapeHtml(s.added)} modified=${escapeHtml(s.modified)} deleted=${escapeHtml(s.deleted)})
    </div>
    ${renderSnapshotFiles("THÊM MỚI", snapshot.diff?.added, "success")}
    ${renderSnapshotFiles("THAY ĐỔI", snapshot.diff?.modified, "warning")}
    ${renderSnapshotFiles("ĐÃ XÓA", snapshot.diff?.deleted, "danger")}
    <div class="snapshot-output">
      <div class="label-caps mb-4">Xuất ra</div>
      <div class="text-mono">${escapeHtml(snapshot.output?.displayDir || "—")}</div>
      <div class="text-muted">report.md · files/</div>
      ${renderSnapshotDownload(snapshot)}
    </div>
  `;
  dom.loginSnapshotPanel.classList.remove("hidden");
  dom.loginLogPanel.classList.remove("hidden");
  setLoginLogBadge("Report ready", "success");
}

// ─── Page navigation ────────────────────────────────────────────────────────

function showPage(page) {
  dom.pageLogin.classList.toggle("hidden", page !== "login");
  dom.pageTokens.classList.toggle("hidden", page !== "tokens");
  dom.topbarTitle.textContent = page === "login" ? "AGY Login" : "Saved Tokens";

  document.querySelectorAll(".sidebar-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.page === page);
  });

  if (page === "tokens") loadTokens();
}

document.querySelectorAll(".sidebar-item").forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    showPage(item.dataset.page);
  });
});

// ─── SSE ────────────────────────────────────────────────────────────────────

function connectSSE(sessionId) {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }

  const url = `/api/login/stream/${sessionId}`;
  const es = new EventSource(url);
  state.sse = es;
  state.reconnects = 0;

  es.onopen = () => {
    console.log("[SSE] Connected");
    state.reconnects = 0;
  };

  es.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      handleSSE(data);
    } catch (err) {
      console.warn("[SSE] Parse error:", err);
    }
  };

  es.onerror = () => {
    console.warn("[SSE] Error / disconnected");
    state.reconnects++;
    if (state.reconnects > state.maxReconnects) {
      es.close();
      showError("SSE connection lost after 3 retries. Please try again.");
      setSidebarStatus("SSE disconnected");
    }
  };
}

function closeSSE() {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
    state.reconnects = 0;
  }
}

function handleSSE(data) {
  console.log("[SSE]", data.type, data);

  switch (data.type) {
    case "status":
      onStatus(data.stage, data);
      break;
    case "auth_url":
      onAuthUrl(data.url);
      break;
    case "verify_url":
      onVerifyUrl(data.url);
      break;
    case "eligibility_result":
      onEligibilityResult(data);
      break;
    case "token_saved":
      onTokenSaved(data);
      closeSSE();
      break;
    case "auth_log":
      appendLoginLog(data);
      break;
    case "login_snapshot":
      renderLoginSnapshot(data.snapshot);
      break;
    case "error":
      showError(data.message || "Unknown error");
      closeSSE();
      break;
    case "closed":
      toast("Session closed: " + (data.reason || ""), "info");
      closeSSE();
      break;
  }
}

function onStatus(stage, data) {
  state.stage = stage || state.stage;
  const labels = {
    starting: "Starting…",
    waiting_url: "Waiting for auth URL…",
    url_ready: "Auth URL ready",
    waiting_code: "Waiting for code",
    credential_wait: "OAuth complete — checking credential…",
    checking_eligibility: "Checking AGY eligibility…",
    verification_required: "Verification required",
    checking_verification: "Re-checking verification…",
    verified: "Account verified",
    eligibility_error: "Eligibility check error",
    eligibility_unknown: "Eligibility result unknown",
    success: "Verified & token saved!",
    error: "Error",
  };
  const variant = stage === "success" || stage === "verified"
    ? "success"
    : stage === "error" || stage === "eligibility_error"
      ? "danger"
      : stage === "verification_required" || stage === "eligibility_unknown"
        ? "warning"
        : "info";
  setBadge(dom.sessionBadge, labels[stage] || stage, variant);
  setSidebarStatus(labels[stage] || stage);

  if (stage === "verification_required" && data && data.verifyUrl) {
    onVerifyUrl(data.verifyUrl);
    return;
  }

  if (stage === "checking_eligibility") {
    showScreen(2);
    dom.spinnerCode.classList.remove("hidden");
    if (dom.spinnerCodeText) dom.spinnerCodeText.textContent = "OAuth complete. Waiting for AGY eligibility result…";
    setBadge(dom.authBadge, "Checking eligibility…", "info");
  }
}

function onAuthUrl(url) {
  state.authUrl = url;
  showScreen(2);
  dom.authUrlLink.href = url;
  dom.authUrlLink.textContent = url;
  setBadge(dom.authBadge, "Waiting for code", "warning");
  toast("Auth URL received — open it in your browser", "info");
  setSidebarStatus("Auth URL ready");
}

function showVerificationPanel({ hasUrl = !!state.verifyUrl } = {}) {
  showScreen(2);
  dom.oauthFlowPanel.classList.add("hidden");
  dom.verifyPanel.classList.remove("hidden");
  dom.spinnerCode.classList.add("hidden");
  dom.verifyUrlContainer.classList.toggle("hidden", !hasUrl);
  dom.btnOpenVerifyUrl.classList.toggle("hidden", !hasUrl);
}

function onVerifyUrl(url) {
  if (!url) return;
  state.verifyUrl = url;
  state.eligibilityStatus = "verification_required";
  showVerificationPanel();
  dom.verifyUrlLink.href = url;
  dom.verifyUrlLink.textContent = url;
  dom.spinnerVerify.classList.add("hidden");
  dom.btnCheckVerification.disabled = false;
  dom.checkVerificationLabel.textContent = "I verified — Check Again";
  dom.eligibilityTitle.textContent = "AGY requires account verification.";
  dom.eligibilityDescription.textContent = "This is the official verification URL printed by AGY. Open it now, complete Google verification, then return here and check again.";
  setBadge(dom.authBadge, "Verification required", "warning");
  dom.eligibilityMessage.textContent = "Complete Google verification using URL #2, then click ‘I verified — Check Again’.";
  toast("AGY requires account verification — URL #2 is ready", "warning");
  setSidebarStatus("Verification required");
}

function onEligibilityResult(data) {
  const outcome = data.outcome || "unknown";
  state.eligibilityStatus = outcome;

  if (outcome === "checking") {
    const isRecheck = state.stage === "checking_verification" || state.verifyUrl || !dom.verifyPanel.classList.contains("hidden");
    showScreen(2);
    if (isRecheck) {
      showVerificationPanel({ hasUrl: !!state.verifyUrl });
      dom.spinnerVerify.classList.remove("hidden");
      dom.btnCheckVerification.disabled = true;
      dom.eligibilityMessage.textContent = "Checking the existing OAuth credential with AGY…";
    } else {
      dom.spinnerCode.classList.remove("hidden");
      if (dom.spinnerCodeText) dom.spinnerCodeText.textContent = "OAuth complete. Waiting for AGY eligibility result…";
    }
    setBadge(dom.authBadge, "Checking eligibility…", "info");
    return;
  }

  if (outcome === "verified") {
    showScreen(2);
    dom.spinnerCode.classList.remove("hidden");
    dom.spinnerVerify.classList.add("hidden");
    dom.btnCheckVerification.disabled = true;
    setBadge(dom.authBadge, "Verified", "success");
    if (dom.spinnerCodeText) dom.spinnerCodeText.textContent = "Account verified. Saving credential…";
    if (state.verifyUrl) dom.eligibilityMessage.textContent = "AGY verification passed. Saving token…";
    toast("AGY confirms the account is verified", "success");
    return;
  }

  if (outcome === "error" || outcome === "unknown") {
    showVerificationPanel({ hasUrl: !!state.verifyUrl });
    dom.spinnerVerify.classList.add("hidden");
    dom.btnCheckVerification.disabled = data.retryable === false;
    dom.checkVerificationLabel.textContent = state.verifyUrl ? "I verified — Check Again" : "Check Again";
    const message = data.message || (outcome === "unknown" ? "AGY did not return a conclusive eligibility result." : "Eligibility check failed.");
    dom.eligibilityTitle.textContent = outcome === "unknown" ? "Eligibility result is not conclusive." : "AGY eligibility check error.";
    dom.eligibilityDescription.textContent = state.verifyUrl
      ? "The last official verification URL remains available above."
      : "No verification URL was produced for this result. This can be a network, backend, credential, or location error rather than an account-verification requirement.";
    dom.eligibilityMessage.textContent = message + (data.retryable === false ? "" : " You can retry Check Again.");
    setBadge(dom.authBadge, outcome === "unknown" ? "Eligibility unknown" : "Eligibility error", outcome === "unknown" ? "warning" : "danger");
    toast(message, outcome === "unknown" ? "warning" : "danger");
    setSidebarStatus(outcome === "unknown" ? "Eligibility unknown" : "Eligibility check error");
  }
}

function onTokenSaved(data) {
  showScreen(3);
  dom.successEmail.textContent = data.email || state.email || "—";
  dom.successKey.textContent = data.key || "—";
  dom.successTime.textContent = formatTimestamp(data.savedAt);
  dom.btnSubmitCode.disabled = false;
  dom.btnPasteConfirm.disabled = false;
  dom.spinnerCode.classList.add("hidden");
  dom.spinnerVerify.classList.add("hidden");
  if (data.snapshot) renderLoginSnapshot(data.snapshot);
  toast("Account verified and token saved successfully!", "success");
  setSidebarStatus("Verified & token saved!");
}

function showError(message) {
  showScreen(0);
  dom.errorMessage.textContent = message;
  setBadge(dom.sessionBadge, "Error", "danger");
  setSidebarStatus("Error");
  toast(message, "danger");
}

// ─── API calls ───────────────────────────────────────────────────────────────

async function apiStartLogin(emailOverride = "") {
  const email = (emailOverride || dom.inputEmail.value).trim();
  dom.errorEmail.classList.add("hidden");
  if (emailOverride) dom.inputEmail.value = email;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    dom.errorEmail.textContent = "Please enter a valid email address.";
    dom.errorEmail.classList.remove("hidden");
    dom.inputEmail.classList.add("error");
    return;
  }
  dom.inputEmail.classList.remove("error");

  state.email = email;
  state.sessionId = crypto.randomUUID();
  resetLoginLogState();
  setLoginLogBadge("Starting", "info");
  dom.loginLogPanel.classList.remove("hidden");

  dom.btnStart.disabled = true;
  setBadge(dom.sessionBadge, "Starting…", "info");
  setSidebarStatus("Starting session…");

  try {
    const res = await fetch("/api/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, sessionId: state.sessionId }),
    });
    const json = await res.json();

    if (!res.ok || !json.success) {
      showError(json.error || `HTTP ${res.status}`);
      dom.btnStart.disabled = false;
      return;
    }

    toast("Session started", "success");
    connectSSE(state.sessionId);
  } catch (err) {
    showError("Network error: " + err.message);
    dom.btnStart.disabled = false;
  }
}

async function apiSubmitCode() {
  const code = dom.inputCode.value.trim();
  dom.errorCode.classList.add("hidden");

  if (!code || code.length < 4) {
    dom.errorCode.textContent = "Please paste the authorization code (at least 4 characters).";
    dom.errorCode.classList.remove("hidden");
    dom.inputCode.classList.add("error");
    return;
  }
  dom.inputCode.classList.remove("error");

  dom.btnSubmitCode.disabled = true;
  dom.btnPasteConfirm.disabled = true;
  dom.spinnerCode.classList.remove("hidden");
  setBadge(dom.authBadge, "Submitting code…", "warning");

  try {
    const res = await fetch("/api/login/submit-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, code }),
    });
    const json = await res.json();

    if (!res.ok || !json.success) {
      showError(json.error || `HTTP ${res.status}`);
      dom.btnSubmitCode.disabled = false;
      dom.btnPasteConfirm.disabled = false;
      dom.spinnerCode.classList.add("hidden");
      return;
    }

    toast("Code submitted. Waiting for AGY eligibility check…", "info");
  } catch (err) {
    showError("Network error: " + err.message);
    dom.btnSubmitCode.disabled = false;
    dom.btnPasteConfirm.disabled = false;
    dom.spinnerCode.classList.add("hidden");
  }
}

async function apiCheckVerification() {
  if (!state.sessionId) return;
  dom.btnCheckVerification.disabled = true;
  dom.spinnerVerify.classList.remove("hidden");
  setBadge(dom.authBadge, "Re-checking…", "info");
  dom.eligibilityMessage.textContent = "Re-checking your existing OAuth credential with AGY…";

  try {
    const res = await fetch("/api/login/verify-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      dom.btnCheckVerification.disabled = false;
      dom.spinnerVerify.classList.add("hidden");
      const message = json.error || `HTTP ${res.status}`;
      dom.eligibilityMessage.textContent = message;
      toast(message, "danger");
      return;
    }

    if (json.needsRestart) {
      toast("Verification requires re-authentication. Starting new login flow…", "info");
      state.sse = null;
      state.sessionId = null;
      await apiStartLogin(state.email);
      return;
    }

    toast("Verification re-check started", "info");
  } catch (err) {
    dom.btnCheckVerification.disabled = false;
    dom.spinnerVerify.classList.add("hidden");
    dom.eligibilityMessage.textContent = "Network error: " + err.message;
    toast("Network error: " + err.message, "danger");
  }
}

async function apiResetSession(options = {}) {
  const { silent = false, keepEmail = false } = options;
  if (!state.sessionId) {
    resetUI({ keepEmail });
    return;
  }

  try {
    await fetch("/api/login/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
  } catch (_) {}

  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  resetUI({ keepEmail });
  if (!silent) toast("Session reset", "info");
}

function resetUI(options = {}) {
  const { keepEmail = false } = options;
  const currentEmail = dom.inputEmail.value;
  state.sessionId = null;
  state.authUrl = null;
  state.verifyUrl = null;
  state.eligibilityStatus = "unknown";
  state.stage = "idle";
  state.reconnects = 0;
  dom.inputEmail.value = keepEmail ? currentEmail : "";
  dom.inputCode.value = "";
  dom.btnStart.disabled = false;
  dom.btnSubmitCode.disabled = false;
  dom.btnPasteConfirm.disabled = false;
  dom.spinnerCode.classList.add("hidden");
  dom.spinnerVerify.classList.add("hidden");
  dom.oauthFlowPanel.classList.remove("hidden");
  dom.verifyPanel.classList.add("hidden");
  dom.verifyUrlContainer.classList.remove("hidden");
  dom.btnOpenVerifyUrl.classList.remove("hidden");
  dom.verifyUrlLink.href = "#";
  dom.verifyUrlLink.textContent = "—";
  dom.btnCheckVerification.disabled = false;
  dom.checkVerificationLabel.textContent = "I verified — Check Again";
  dom.eligibilityTitle.textContent = "AGY requires account verification.";
  dom.eligibilityDescription.textContent = "This is the official verification URL printed by AGY. Open it now, complete Google verification, then return here and check again.";
  dom.eligibilityMessage.textContent = "Token is not saved until AGY confirms the account no longer requires verification.";
  if (dom.spinnerCodeText) dom.spinnerCodeText.textContent = "Waiting for credential and AGY eligibility check…";
  dom.errorEmail.classList.add("hidden");
  dom.errorCode.classList.add("hidden");
  dom.inputEmail.classList.remove("error");
  dom.inputCode.classList.remove("error");
  showScreen(1);
  setBadge(dom.sessionBadge, "Idle", "info");
  setSidebarStatus("No active session");
  resetLoginLogState();
}

// ─── Tokens page ────────────────────────────────────────────────────────────

function getTokenFilters() {
  return {
    email: (dom.filterEmail.value || "").trim().toLowerCase(),
    key: (dom.filterKey.value || "").trim().toLowerCase(),
    createdAt: (dom.filterCreated.value || "").trim().toLowerCase(),
    updatedAt: (dom.filterUpdated.value || "").trim().toLowerCase(),
  };
}

function updateSortIndicators() {
  document.querySelectorAll("#tokens-table th.sortable").forEach((th) => {
    const arrow = th.querySelector(".sort-arrow");
    if (th.dataset.sortField === state.tokenSort.field) {
      th.classList.add("sorted");
      if (arrow) arrow.textContent = state.tokenSort.direction === "asc" ? " ▲" : " ▼";
    } else {
      th.classList.remove("sorted");
      if (arrow) arrow.textContent = "";
    }
  });
}

function updateFilterUI() {
  const filters = [
    { input: dom.filterEmail, btn: document.querySelector('[data-clear="filter-email"]') },
    { input: dom.filterKey, btn: document.querySelector('[data-clear="filter-key"]') },
    { input: dom.filterCreated, btn: document.querySelector('[data-clear="filter-created"]') },
    { input: dom.filterUpdated, btn: document.querySelector('[data-clear="filter-updated"]') },
  ];

  let hasActiveFilter = false;
  filters.forEach(({ input, btn }) => {
    const hasVal = !!(input.value || "").trim();
    if (hasVal) hasActiveFilter = true;
    if (btn) btn.classList.toggle("hidden", !hasVal);
  });

  if (dom.btnClearAllFilters) {
    dom.btnClearAllFilters.classList.toggle("hidden", !hasActiveFilter);
  }
}

function renderTokensTable() {
  updateFilterUI();
  const f = getTokenFilters();
  const { field, direction } = state.tokenSort;
  const list = state.tokenRows
    .filter((t) => (!f.email || String(t.email || "").toLowerCase().includes(f.email))
      && (!f.key || String(t.key || "").toLowerCase().includes(f.key))
      && (!f.createdAt || formatTimestamp(t.createdAt).toLowerCase().includes(f.createdAt))
      && (!f.updatedAt || formatTimestamp(t.updatedAt).toLowerCase().includes(f.updatedAt)))
    .sort((a, b) => {
      const av = a[field] || "";
      const bv = b[field] || "";
      if (av === bv) return 0;
      const cmp = av > bv ? 1 : -1;
      return direction === "asc" ? cmp : -cmp;
    });

  updateSortIndicators();

  if (!list.length) {
    dom.tokensBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No matching tokens.</td></tr>';
    return;
  }

  dom.tokensBody.innerHTML = list.map((t) => `
<tr>
<td class="primary-col">${escapeHtml(t.email || "—")}</td>
<td class="text-mono">${escapeHtml(t.key || "—")}</td>
<td>${formatTimestamp(t.createdAt)}</td>
<td>${formatTimestamp(t.updatedAt)}</td>
<td><div class="token-actions"><button class="btn-secondary token-action-btn token-relogin-btn" data-token-action="relogin" data-token-email="${escapeHtml(t.email || "")}">ReLogin</button><button class="btn-light token-action-btn" data-token-action="json" data-token-key="${escapeHtml(t.key)}">JSON</button><button class="btn-light token-action-btn" data-token-action="raw" data-token-key="${escapeHtml(t.key)}">Raw</button><button class="btn-light token-action-btn" data-token-action="base64" data-token-key="${escapeHtml(t.key)}">Base64</button><button class="btn-light token-action-btn" data-token-action="decode" data-token-key="${escapeHtml(t.key)}">Decode</button></div></td>
</tr>`).join("");
}

async function loadTokens() {
  state.tokenDetails.clear();
  dom.tokensBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Loading…</td></tr>';
  dom.tokenDetailPanel.classList.add("hidden");
  try {
    const res = await fetch("/api/tokens");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    state.tokenRows = Array.isArray(json.tokens) ? json.tokens : [];
    if (!state.tokenRows.length) {
      dom.tokensBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No tokens saved yet.</td></tr>';
      return;
    }
    renderTokensTable();
  } catch (err) {
    dom.tokensBody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function fetchTokenDetail(key) {
  if (state.tokenDetails.has(key)) return state.tokenDetails.get(key);
  const res = await fetch(`/api/tokens/${encodeURIComponent(key)}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  state.tokenDetails.set(key, json.token);
  return json.token;
}

function tokenPayload(detail, action) {
  if (action === "raw") return detail.raw || "";
  if (action === "base64") return detail.base64 || "";
  if (action === "decode") return detail.base64Decoded || decodeBase64Utf8(detail.base64 || "");
  return JSON.stringify(detail.parsed || {}, null, 2);
}

function showTokenPreview(detail, action, text) {
  const labels = {
    json: "JSON",
    raw: "Raw",
    base64: "Base64",
    decode: "Base64 Decoded",
  };
  state.previewText = text;
  dom.tokenDetailMode.textContent = labels[action] || "Token Payload";
  dom.tokenDetailTitle.textContent = `${detail.email || detail.key} · ${detail.key}`;
  dom.tokenDetailContent.value = text;
  dom.tokenDetailPanel.classList.remove("hidden");
}

async function handleTokenAction(key, action) {
  try {
    const detail = await fetchTokenDetail(key);
    const text = tokenPayload(detail, action);
    showTokenPreview(detail, action, text);
    await copyText(text, action === "decode" ? "Base64 decoded token" : `${action.toUpperCase()} token`);
  } catch (err) {
    toast(`Token action failed: ${err.message}`, "danger");
  }
}

async function handleTokenRelogin(email) {
  const trimmed = String(email || "").trim();
  if (!trimmed) {
    toast("Token email is missing; cannot ReLogin.", "danger");
    return;
  }

  dom.inputEmail.value = trimmed;
  if (state.sessionId) {
    await apiResetSession({ silent: true, keepEmail: true });
    dom.inputEmail.value = trimmed;
  } else {
    resetUI({ keepEmail: true });
    dom.inputEmail.value = trimmed;
  }

  showPage("login");
  toast(`Starting ReLogin for ${trimmed}`, "info");
  await apiStartLogin(trimmed);
}

// ─── Event bindings ──────────────────────────────────────────────────────────

dom.btnStart.addEventListener("click", () => apiStartLogin());
dom.btnSubmitCode.addEventListener("click", apiSubmitCode);
dom.btnPasteConfirm.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    const trimmed = (text || "").trim();
    if (!trimmed) {
      toast("Clipboard is empty or contains no text.", "warning");
      return;
    }
    dom.inputCode.value = trimmed;
    toast("Code pasted from clipboard", "success");
    await apiSubmitCode();
  } catch (err) {
    toast(`Failed to read clipboard: ${err.message}. Please paste manually.`, "danger");
  }
});
dom.btnOpenUrl.addEventListener("click", () => {
  if (state.authUrl) window.open(state.authUrl, "_blank", "noopener");
});
dom.btnOpenVerifyUrl.addEventListener("click", () => {
  if (state.verifyUrl) window.open(state.verifyUrl, "_blank", "noopener");
});
dom.btnCheckVerification.addEventListener("click", apiCheckVerification);
dom.btnLoginAnother.addEventListener("click", resetUI);
dom.btnTryAgain.addEventListener("click", () => {
  apiResetSession();
});
dom.btnResetSession.addEventListener("click", apiResetSession);
dom.btnRefreshTokens.addEventListener("click", loadTokens);
dom.btnExportExcel.addEventListener("click", () => { window.open("/api/tokens/export/excel", "_blank", "noopener"); });
dom.btnBackupTokens.addEventListener("click", async () => { const res = await fetch("/api/tokens/backup"); const json = await res.json(); if (!res.ok) return toast(json.error || "Backup failed", "danger"); const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `tokens-backup-${Date.now()}.json`; a.click(); URL.revokeObjectURL(a.href); toast("Backup completed", "success"); });
dom.btnRestoreTokens.addEventListener("click", () => dom.inputRestoreFile.click());
dom.inputRestoreFile.addEventListener("change", async (e) => { const file = e.target.files?.[0]; if (!file) return; const text = await file.text(); const payload = JSON.parse(text); const res = await fetch("/api/tokens/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); const json = await res.json(); if (!res.ok) return toast(json.error || "Restore failed", "danger"); toast(`Restored ${json.restored} token(s)`, "success"); loadTokens(); });
[dom.filterEmail, dom.filterKey, dom.filterCreated, dom.filterUpdated].forEach((el) => el.addEventListener("input", renderTokensTable));
document.querySelectorAll(".filter-clear-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const inputId = btn.dataset.clear;
    const input = document.getElementById(inputId);
    if (input) {
      input.value = "";
      renderTokensTable();
    }
  });
});
if (dom.btnClearAllFilters) {
  dom.btnClearAllFilters.addEventListener("click", () => {
    [dom.filterEmail, dom.filterKey, dom.filterCreated, dom.filterUpdated].forEach((input) => {
      input.value = "";
    });
    renderTokensTable();
  });
}
document.querySelectorAll("#tokens-table th.sortable").forEach((th) => th.addEventListener("click", () => { const field = th.dataset.sortField; if (state.tokenSort.field === field) state.tokenSort.direction = state.tokenSort.direction === "asc" ? "desc" : "asc"; else { state.tokenSort.field = field; state.tokenSort.direction = "asc"; } renderTokensTable(); }));
dom.btnRefresh.addEventListener("click", () => {
  if (!dom.pageTokens.classList.contains("hidden")) loadTokens();
});
dom.tokensBody.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-token-action]");
  if (!btn) return;
  if (btn.dataset.tokenAction === "relogin") {
    handleTokenRelogin(btn.dataset.tokenEmail);
    return;
  }
  handleTokenAction(btn.dataset.tokenKey, btn.dataset.tokenAction);
});
dom.btnCopyPreview.addEventListener("click", () => {
  if (!state.previewText) return;
  copyText(state.previewText, "Preview");
});

// Allow Enter in email input to start login
dom.inputEmail.addEventListener("keydown", (e) => {
  if (e.key === "Enter") apiStartLogin();
});

// Allow Ctrl+Enter in code textarea to submit
dom.inputCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) apiSubmitCode();
});

// ─── Init ────────────────────────────────────────────────────────────────────

try {
  const urlParams = new URLSearchParams(window.location.search);
  const loginHint = urlParams.get("login_hint");
  if (loginHint && dom.inputEmail) {
    dom.inputEmail.value = loginHint;
  }
} catch (err) {
  console.error("Failed to parse login_hint from URL:", err);
}

showScreen(1);
showPage("login");

// ─── Health probe ────────────────────────────────────────────────────────────

async function checkHealth() {
  const banner = $("health-banner");
  const bannerMsg = $("health-banner-msg");
  const topbarHealth = $("topbar-health");

  try {
    const res = await fetch("/health");
    const json = await res.json();

    const issues = [];
    if (!json.firebase || !json.firebase.ready) {
      const source = json.firebase?.serviceAccountSource || "not configured";
      const target = json.firebase?.serviceAccountPath || "FIREBASE_SERVICE_ACCOUNT_BASE64";
      issues.push(
        `<strong>Firebase:</strong> service account source is <code>${source}</code>. Set <code>FIREBASE_SERVICE_ACCOUNT_BASE64</code> or place the JSON file at <code>${target}</code>, then restart the backend.`,
      );
    }
    if (!json.docker || !json.docker.available) {
      issues.push(`<strong>Docker CLI:</strong> ${json.docker.error?.hint || "not available"}`);
    } else if (!json.docker.daemonOk) {
      issues.push(`<strong>Docker daemon:</strong> ${json.docker.error?.hint || "not reachable"}`);
    }

    if (issues.length === 0) {
      banner.classList.add("hidden");
      topbarHealth.textContent = "All systems OK";
      topbarHealth.className = "badge badge-success";
      topbarHealth.classList.remove("hidden");
      // Hide after 4s when healthy
      setTimeout(() => topbarHealth.classList.add("hidden"), 4000);
    } else {
      bannerMsg.innerHTML = issues.map((i) => `• ${i}`).join("<br>");
      banner.classList.remove("hidden");
      topbarHealth.textContent = `${issues.length} issue${issues.length > 1 ? "s" : ""}`;
      topbarHealth.className = "badge badge-danger";
      topbarHealth.classList.remove("hidden");
    }
  } catch (err) {
    bannerMsg.innerHTML = `Cannot reach <code>/health</code>: ${err.message}`;
    banner.classList.remove("hidden");
    topbarHealth.textContent = "Backend offline";
    topbarHealth.className = "badge badge-danger";
    topbarHealth.classList.remove("hidden");
  }
}

checkHealth();
setInterval(checkHealth, 30_000);

// ─── Deploy & Runtime Info ───────────────────────────────────────────────────

async function loadDeployInfo() {
  try {
    const res = await fetch("/api/deploy-info");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const info = data.deployInfo || {};
    const envVars = data.envVars || {};

    // Update footer
    if (dom.deployOrg) dom.deployOrg.textContent = info.org || "N/A";
    if (dom.deployRepo) dom.deployRepo.textContent = info.repo || "N/A";
    
    if (dom.deployCommitLink) {
      dom.deployCommitLink.textContent = info.commit || "N/A";
      if (info.commitUrl) {
        dom.deployCommitLink.href = info.commitUrl;
        dom.deployCommitLink.style.pointerEvents = "auto";
        dom.deployCommitLink.style.textDecoration = "underline";
      } else {
        dom.deployCommitLink.removeAttribute("href");
        dom.deployCommitLink.style.pointerEvents = "none";
        dom.deployCommitLink.style.textDecoration = "none";
      }
    }

    if (dom.deployDate) {
      let displayDate = info.date || "N/A";
      if (displayDate !== "N/A") {
        const d = new Date(displayDate);
        if (!isNaN(d.getTime())) {
          displayDate = d.toLocaleString();
        }
      }
      dom.deployDate.textContent = displayDate;
    }

    if (dom.deployHost) {
      dom.deployHost.textContent = info.host || "N/A";
    }

    // Populate Tunnels
    if (dom.tunnelEndpointsList) {
      const tunnelKeys = Object.keys(envVars).filter(k => k.startsWith("CLOUDFLARED_TUNNEL_HOSTNAME_"));
      if (tunnelKeys.length > 0) {
        dom.tunnelEndpointsList.innerHTML = "";
        tunnelKeys.forEach(k => {
          let val = envVars[k];
          if (!val) return;
          let label = k.replace("CLOUDFLARED_TUNNEL_HOSTNAME_", "");
          if (!label) label = "Tunnel";
          // Prepend https:// if not starting with http/https
          let url = val;
          if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = `https://${url}`;
          }
          const link = document.createElement("a");
          link.href = url;
          link.target = "_blank";
          link.className = "btn-tunnel";
          link.textContent = `${label}: ${val}`;
          dom.tunnelEndpointsList.appendChild(link);
        });
      } else {
        dom.tunnelEndpointsList.innerHTML = `<span class="text-muted" style="font-size: 0.8125rem;">No active tunnels found.</span>`;
      }
    }

    // Populate Env Table
    if (dom.envVarsList) {
      const runnerKeys = Object.keys(envVars).filter(k => k.startsWith("_DOTENVRTDB_RUNNER_"));
      if (runnerKeys.length > 0) {
        dom.envVarsList.innerHTML = "";
        runnerKeys.sort().forEach(k => {
          const val = envVars[k] || "";
          const row = document.createElement("tr");

          const nameTd = document.createElement("td");
          nameTd.className = "env-var-name";
          nameTd.textContent = k;

          const valTd = document.createElement("td");
          valTd.className = "env-var-value";
          
          if (val.startsWith("http://") || val.startsWith("https://")) {
            const link = document.createElement("a");
            link.href = val;
            link.target = "_blank";
            link.textContent = val;
            valTd.appendChild(link);
          } else {
            valTd.textContent = val;
          }

          row.appendChild(nameTd);
          row.appendChild(valTd);
          dom.envVarsList.appendChild(row);
        });
      } else {
        dom.envVarsList.innerHTML = `<tr><td colspan="2" class="text-center text-muted">No runner variables defined.</td></tr>`;
      }
    }
  } catch (err) {
    console.error("Failed to load deployment info:", err);
  }
}

// Bind modal events
if (dom.btnDeployDetails && dom.deployModal) {
  dom.btnDeployDetails.addEventListener("click", () => {
    dom.deployModal.classList.remove("hidden");
  });
}
if (dom.btnCloseDeployModal && dom.deployModal) {
  dom.btnCloseDeployModal.addEventListener("click", () => {
    dom.deployModal.classList.add("hidden");
  });
}
if (dom.deployModal) {
  dom.deployModal.addEventListener("click", (e) => {
    if (e.target === dom.deployModal) {
      dom.deployModal.classList.add("hidden");
    }
  });
}

// Load it on startup
loadDeployInfo();

