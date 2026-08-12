# Experiment — automating a web-based token renewal flow

**Last updated:** 2026-08-11
**Status:** Capability audit complete ✅ · Target system not yet disclosed ⏳ · No code written

> **Scope note.** This document is *not* about `ksef-exporter`. It describes an
> experiment in reverse-engineering and automating a **token renewal flow on some
> web portal**, discussed while this happened to be the active workspace. Nothing in
> this repo depends on it. Move or delete it freely.
>
> The target system is **not yet identified** — see §6. Do not assume it is KSeF; the
> `ksef-client` dependency manages its own tokens and is unrelated.

---

## 1. TL;DR

**Goal:** understand the mechanics of a manual "renew token for resource X" web flow
(authentication → renewal request → confirmation) well enough to automate it
unattended.

**Central finding of the capability audit:** Claude Code **cannot drive a browser** in
this setup. Not VS Code's integrated browser, not the Claude in Chrome extension, not
anything else. Zero browser tools are wired in, and there is no setting that grants
them — the blocker is architectural, not configuration.

**Consequence:** the experiment splits cleanly in two, and only the second half is
mine to do.

| Phase            | What                                                                   | Who / how                                                                    |
| ---------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **A — Observe**  | Capture the real HTTP sequence of one manual renewal                   | **Human or a browser-capable agent.** Output: a HAR file or equivalent trace |
| **B — Automate** | Reconstruct the sequence as a script, verify against the live endpoint | **Claude Code**, via Bash + Node                                             |

Phase B is straightforward once Phase A exists. Phase A is the whole risk.

---

## 2. Capability audit (verified 2026-08-11)

### 2.1 What this session actually has

| Tool           | Verdict for this task                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `WebFetch`     | **Useless.** One unauthenticated GET, HTML→markdown. No JS, no cookies, no POST, no cross-host redirects |
| `Bash`         | **The real capability.** `curl`, plus any script I write and run                                         |
| File tools     | Read/write scripts, parse captured traces                                                                |
| Browser tools  | **None exist**                                                                                           |
| IDE-side tools | **None exist** — a `ToolSearch` for any `ide`/editor tool returns nothing                                |

MCP servers configured: **none** (`claude mcp list` → "No MCP servers configured").

### 2.2 VS Code integrated browser — why it is out of reach

The feature is real and genuinely agent-facing. Per the
[docs](https://vscode.club/docs/debugtest/integrated-browser):

- Opened via **Browser: Open Integrated Browser**, **View > Browser** (⌥⌘/), the globe
  button, localhost links (`workbench.browser.openLocalhostLinks`), or a debug session of
  type `editor-browser`.
- `workbench.browser.enableChatTools` — **enabled by default** — gives agents tools to
  "open browser pages, navigate to URLs, read page content and console errors, take
  screenshots, select elements, type text, hover over elements, drag elements, handle
  dialogs, and **run Playwright code**, all without an external MCP server."
- Access is gated per-session: the user shares a tab via a **Share with Agent** button,
  and "an agent can only read and interact with the tabs that belong to its own session."

That capability set is close to ideal for this experiment. **But those tools are
contributed into VS Code's own chat/agent system (Copilot agent mode).** Claude Code runs
as a separate extension driving the CLI over its own IDE bridge, which exposes files,
diffs, selection and diagnostics — nothing more. The documentation notes **no public
extension API** for third parties to reach the browser programmatically.

Empirical confirmation: no `workbench.browser.*` capability appears anywhere in this
session's tool inventory.

**Implication, and it is a useful one:** Copilot agent mode *is* a viable Phase A
executor. See option A2 in §4.

### 2.3 Claude in Chrome — useful to the human, not callable here

Separate product surface (Claude side panel in Chrome), no bridge to this CLI session.
I cannot invoke it or see what it sees.

- **Good for:** a fast qualitative pass inside the already-authenticated session — what
  the flow looks like, whether an OTP step exists, whether the new token is displayed
  once or emailed.
- **Bad for:** everything automation needs. It operates at the DOM/visual level and will
  not surface request headers, CSRF/nonce values, exact POST bodies, or the response
  field carrying the new token.
- **Risk flag:** renewal is a state-changing action in an authenticated session. Browser
  agents acting on live pages carry prompt-injection exposure. Acceptable on a trusted
  portal; worth stating.

---

## 3. Host environment (verified 2026-08-11)

| Item                     | Status                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Node                     | v24.16.0 ✅                                                                             |
| npm / npx                | 11.13.0 ✅                                                                              |
| Google Chrome            | installed ✅                                                                            |
| Microsoft Edge           | installed ✅                                                                            |
| Playwright browser cache | `chromium-1217`, `chromium-1234`, `chromium_headless_shell-1217/1234`, `ffmpeg-1011` ✅ |
| `playwright` npm package | not present (not in this project, not global) ❌                                        |
| Python `playwright`      | not installed ❌                                                                        |
| Python                   | 3.14.6 ✅                                                                               |

**Reading:** browser binaries are already downloaded, so enabling a scripted browser is
one `pnpm add -D playwright` away — no multi-hundred-MB download.

**Corporate network caveat:** uppercase `HTTP_PROXY` / `HTTPS_PROXY` are required on this
network. Playwright and any agent-launched Chrome need proxy configured **explicitly** —
it is not reliably inherited. Budget time for this; it is a classic silent-hang cause.

---

## 4. Options for Phase A (observe), ranked

### A1 — Chrome DevTools → Save all as HAR  ⭐ recommended

Human performs one renewal in Chrome with DevTools open: Network tab, ✔ Preserve log,
✔ Disable cache. Then right-click → **Save all as HAR (with sensitive data)** and drop the
file into the workspace. Claude Code parses it.

- **Pros:** zero install; complete ground truth including headers and bodies in exact
  order; credentials never pass through the model; works regardless of how dynamic the
  page is.
- **Cons:** manual; captures one pass, so token-expiry edge cases stay unobserved.

### A2 — Copilot agent mode + integrated browser

Use the browser tools described in §2.2 to drive the flow, then have that agent emit a
network trace / HAR / written request log. Bring it back here for Phase B.

- **Pros:** stays entirely inside VS Code; nothing to install; can also run Playwright
  code directly.
- **Cons:** hands the analysis to a different agent whose trace fidelity is unproven;
  requires per-tab sharing.

### A3 — Chrome DevTools MCP server

`claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest`

Attaches to an already-logged-in Chrome and exposes network requests, console and DOM as
tools I *can* call — credentials stay in your profile.

- **Pros:** the only option giving *me* live interactive access; best if the flow proves
  too dynamic to read from a static HAR.
- **Cons:** installs an MCP server; **requires restarting the session** to pick up the
  tools; another moving part behind the proxy.

### A4 — Claude in Chrome

Reconnaissance only, per §2.3. Use to answer "is there 2FA?" quickly, not to produce the
trace.

---

## 5. Phase B plan (automate) — Claude Code

Assumes a HAR or equivalent trace from Phase A.

1. **Parse the trace.** Write a small Node script to extract the ordered request chain,
   filtering out static assets. Produce a table: method, URL, key headers, body shape,
   status, redirect target.
2. **Identify the state machine.** Specifically:
   - the auth handshake — plain form POST, or an OIDC/SAML redirect chain
   - session carrier — cookie vs bearer, and its lifetime
   - anti-CSRF material — where the nonce/token originates and which requests echo it
   - the renewal call itself, and the field in the response carrying the new token
   - the confirmation step — is it a second request, a polled status, or an email?
3. **Choose the automation substrate:**
   - **Plain HTTP** (`undici`) if the chain is deterministic and JS-free — preferred:
     fast, headless, no browser dependency.
   - **Playwright** if the flow needs real JS execution, or if a persistent
     authenticated profile is the only way past 2FA. Browsers are already cached (§3).
4. **Build with an observable loop.** Log every request/response to JSON and screenshot
   to PNG; I can read both, which closes the observe→fix→rerun cycle without a browser
   tool.
5. **Secrets handling.** Read credentials from a `.env`-style file, never echo values,
   never write a token into this document or into git. Prefer a pre-authenticated browser
   profile over storing a password if the flow permits.
6. **Verify** against the live endpoint, then decide the scheduling story (cron / launchd
   / manual invocation) and the failure-notification story.

---

## 6. Open questions — blocking Phase A

1. **What is the target?** URL, and what the token/resource actually is.
2. **Authentication type?** Plain form login · SSO (OIDC/SAML) redirect chain · client
   certificate · qualified signature.
3. **Is there 2FA / OTP?** ← *the architecturally decisive one.* If yes, fully unattended
   renewal is likely impossible, and the design changes to a **persistent browser profile
   plus long-lived session**, with a manual re-auth fallback and alerting. Answer this
   before anything else.
4. **Token lifetime and renewal window?** Determines scheduling and whether renewal is
   idempotent or consumes a quota.
5. **Credential handling preference?** Pre-authenticated Chrome profile vs `.env`.
6. **Authorization.** Assumed to be the author's own account and resource — authorized
   self-service automation. State otherwise if not.

---

## 7. Risks

| Risk                                    | Impact                             | Mitigation                                                                 |
| --------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| 2FA in the flow                         | Kills unattended automation        | Resolve Q3 first; fall back to persistent session + alerting               |
| Proxy not inherited by scripted browser | Silent hangs, hours lost           | Set `HTTP_PROXY`/`HTTPS_PROXY` explicitly in launch options                |
| Renewal is rate-limited or single-shot  | Failed experiments burn real quota | Establish the limit from docs/HAR **before** iterating live                |
| Portal markup/flow changes              | Automation breaks silently         | Assert on the confirmation signal, not on DOM structure; alert on failure  |
| Token leaked into logs, HAR, or git     | Credential exposure                | HAR and logs to an ignored path; never commit; scrub before sharing        |
| Prompt injection via browser agent      | Unintended authenticated actions   | Prefer A1 (human-driven) over agent-driven browsing for the renewal itself |

---

## 8. Immediate next actions

1. **Human:** answer Q3 (2FA) and Q1 (target) in §6.
2. **Human:** run option A1 — capture the HAR of one manual renewal.
3. **Claude Code:** on receipt of the HAR, execute Phase B steps 1–2 and report the
   reconstructed state machine before writing any automation.
