# CHANGE LOGS (User-facing)

---

## [2.2.0] — 2026-08-08 — Verify account directly from AGY Auth UI

### What's New

**OAuth no longer stops at “token file created”.** After the Google authorization
code is submitted, the app waits for AGY's own eligibility result.

- If the account is already eligible, the UI shows **Verified** and then saves the token.
- If AGY requires extra account verification, the UI shows **Verification URL #2**.
  Open it, complete Google verification, then click **I verified — Check Again**.
- Re-check uses the OAuth credential you just created; you do **not** repeat the first
  Google OAuth code flow.
- Network/location/backend errors are shown separately instead of being mistaken for
  an unverified account.
- A verification URL may be temporary, so open it promptly; if it expires, use
  **Check Again** to let AGY issue a fresh result/URL.

The feature follows AGY/Google's official eligibility flow; it does not bypass
account, region, age, subscription, or other eligibility controls.

---

## [2.0.0] — 2026-04-09 — Modular Stack Template

### What's New

**Deploy any Docker image in minutes**
Change two lines in `.env` (`APP_IMAGE` and `APP_PORT`) and your app is live — no YAML editing required.

**Feature flags — enable what you need**
Turn ops tools on or off with simple env vars:

```env
ENABLE_DOZZLE=true
ENABLE_FILEBROWSER=true
ENABLE_WEBSSH=false
ENABLE_TAILSCALE=false
```

**Subdomains auto-generated**
Set `PROJECT_NAME=gitea` and `DOMAIN=example.com` once. All service URLs follow automatically:

- `gitea.example.com` → your app
- `logs.gitea.example.com` → log viewer
- `files.gitea.example.com` → file manager
- `ttyd.gitea.example.com` → web terminal

**One-command validation before deploy**

```bash
npm run dockerapp-validate:all
```

Checks env vars, Tailscale key format, and compose YAML — all at once.

**One-command deploy**

```bash
npm run dockerapp-exec:up
```

### What Changed (migration from v1)

If upgrading from the previous `docker-compose.yml` setup:

1. Replace `SUBDOMAIN_APP/DOZZLE/FILEBROWSER/WEBSSH` with just `PROJECT_NAME`
2. Replace `TAILSCALE_CLIENT_SECRET` with `TAILSCALE_AUTHKEY`
3. Replace `docker compose up` with `bash docker-compose/scripts/dc.sh up` or `npm run dockerapp-exec:up`
4. Update `cloudflared/config.yml` manually from `cloudflared/config.yml.example` if you use Cloudflare Tunnel

See `docs/DEPLOY.md` for the full migration guide.

---
