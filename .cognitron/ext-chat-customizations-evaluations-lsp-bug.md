# Bug: Chat Customizations Evaluations — language server never starts

**Last updated:** 2026-08-11 09:40
**Status:** Root-caused ✅ · Locally patched ✅ (re-applied after 1.1.2026080719 update) · Upstream reported ✅ · **Fix implemented & pushed ✅** — [PR ready](https://github.com/karol-brejna-i/vscode-chat-customizations-evaluation/tree/dev/kbrejna/fix-outputchannel-logoutputchannel) · [Issue #276](https://github.com/microsoft/vscode-chat-customizations-evaluation/issues/276)

> **Scope note.** This document is *not* about `ghcp-history-viewer`. It concerns
> a third-party VS Code extension (`ms-vscode.vscode-chat-customizations-evaluations`)
> that the author uses as tooling on this repo. It lives here only because this is
> the active workspace. Move or delete it freely — no code in this repo depends on it.

---

## 1. TL;DR

The extension creates a **plain `OutputChannel`** and injects it into a
`vscode-languageclient` **v10** `LanguageClient`. v10 requires a
**`LogOutputChannel`**. The client calls `.error()` on it during startup, which
doesn't exist on a plain channel → `TypeError` → `start()` rejects → the server
never runs → every analysis fails with `Client is not running`.

**Fix:** add `{ log: true }` to the `createOutputChannel` call. One line.

---

## 2. Environment

| Item                  | Value                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Extension             | `ms-vscode.vscode-chat-customizations-evaluations`                                              |
| Version               | `1.1.2026072818`                                                                                |
| Install path          | `~/.vscode-insiders/extensions/ms-vscode.vscode-chat-customizations-evaluations-1.1.2026072818` |
| Host                  | VS Code **Insiders**, macOS                                                                     |
| Upstream repo         | https://github.com/microsoft/vscode-chat-customizations-evaluation                              |
| Bundle under analysis | `client/out/extension.js` (esbuild bundle, ~26k lines, `vscode` external)                       |

Dependency versions (these matter — see §4):

| Manifest                   | Declares `vscode-languageclient`            |
| -------------------------- | ------------------------------------------- |
| `package.json` (root)      | `^9.0.1`                                    |
| `client/package.json`      | `^10.1.0`                                   |
| `client/package-lock.json` | **resolved `10.1.0`** ← what actually ships |

The root manifest is stale/inconsistent. The client bundle is the one loaded by
`main` (`./client/out/extension.js`), so **v10 semantics apply**.

---

## 3. Symptom

Output channel *Chat Customizations Evaluations*:

```
[Activation] Extension path: …/ms-vscode.vscode-chat-customizations-evaluations-1.1.2026072818
[Activation] Server module: …/out/server.js (exists: true)
[Code Actions] Registering code action provider
[Activation] Language server failed to start: this.outputChannel.error is not a function
Chat Customizations Evaluations initialized
[Analysis] Error: Error: Client is not running
```

Note the two-stage failure — the second line is a *consequence*, not an
independent bug. `Client is not running` will reappear for **every** command
until startup succeeds. Do not chase it separately.

Also note `Server module: … (exists: true)` — the server bundle is fine. The
failure is entirely client-side, before the server process is ever spawned.

---

## 4. Root cause

Three facts in the shipped bundle, in order:

**a. The channel is created without `{ log: true }`** — `client/out/extension.js:25574`
(line number is *pre-patch*; see §5):

```js
activate(context) {
  this.outputChannel = vscode.window.createOutputChannel("Chat Customizations Evaluations");
```

**b. It is injected into the language client** — `client/out/extension.js:25651`,
in `createClientOptions()`:

```js
  outputChannel: this.outputChannel
};
```

**c. v10 treats an injected channel as a `LogOutputChannel`** — `client/out/extension.js:19074`:

```js
if (clientOptions.outputChannel) {
  this._outputChannel = clientOptions.outputChannel;
  this._disposeOutputChannel = false;
  this._traceLogLevel = this._outputChannel.logLevel;   // undefined on a plain channel
}
```

…and then logs through the `LogOutputChannel` API (`19429`–`19453`):

```js
this.outputChannel.error(this.getLogMessage(message, data));   // 19429  ← throws
this.outputChannel.warn(…);                                    // 19437
this.outputChannel.info(…);                                    // 19445
this.outputChannel.debug(…);                                   // 19453
```

A plain `OutputChannel` exposes only `append` / `appendLine` / `replace` /
`clear` / `show` / `hide` / `dispose`. `error` / `warn` / `info` / `debug` /
`logLevel` / `onDidChangeLogLevel` exist **only** on `LogOutputChannel`, which
you get exclusively via `createOutputChannel(name, { log: true })`.

### Why this is a v9 → v10 regression

In `vscode-languageclient` **9.x**, `LanguageClientOptions.outputChannel` was
typed `OutputChannel` and the client logged via `appendLine`. In **10.x** it was
narrowed to `LogOutputChannel`. The extension's `activate()` was written against
the v9 contract; the dependency was bumped to `^10.1.0` without updating the
channel creation. TypeScript should have caught this at build time — which
suggests the client is built with stale/loose types, or the assignment is widened
somewhere. **Worth flagging upstream alongside the fix.**

Corroborating evidence that `{ log: true }` is the intended shape: when *no*
channel is injected, the vendored client creates its own correctly
(`client/out/extension.js:19149`):

```js
this._outputChannel = vscode_1.window.createOutputChannel(…, { log: true });
```

---

## 5. Local fix (applied 2026-08-04)

Patched in place at `client/out/extension.js:25574`:

```diff
- this.outputChannel = vscode.window.createOutputChannel("Chat Customizations Evaluations");
+ this.outputChannel = vscode.window.createOutputChannel("Chat Customizations Evaluations", { log: true });
```

**Safe by construction:** `LogOutputChannel` extends `OutputChannel`, so the
extension's own ~15 `this.outputChannel.appendLine(...)` calls keep working
unchanged. Nothing else needs touching.

Verified: `grep` confirms the patch, and the bundle still parses
(`vm.compileFunction` → `syntax OK`).

**Then reload the window** (`Developer: Reload Window`). A reload is required —
`activate()` only runs once per host session.

### ⚠️ This patch is volatile

It edits an installed extension in place. It is **lost on every update** of
`ms-vscode.vscode-chat-customizations-evaluations`. Symptom of regression is
identical to §3.

To re-apply after an update (path version will differ):

```sh
EXT=$(ls -d ~/.vscode-insiders/extensions/ms-vscode.vscode-chat-customizations-evaluations-*/ | tail -1)
grep -n 'createOutputChannel("Chat Customizations Evaluations")' "$EXT/client/out/extension.js"
```

If that grep matches, the bug is back; re-apply the diff above. If it matches
nothing, either it's already patched or upstream fixed it — confirm with
`grep -c 'log: true' "$EXT/client/out/extension.js"`.

### 5.1 Validating the source fix

The source-level fix is in `client/src/extension.ts:48`. Two ways to confirm:

#### Quick — trust the local patch

The local bundle patch (§5) is byte-identical to what the source fix produces
after `npm run build`. If the extension has been working since you applied the
local patch, the source fix is correct by construction — no further validation
needed.

#### Full — build from source and test in Extension Development Host

```sh
cd /path/to/vscode-chat-customizations-evaluation

# 1. Full build (server + client bundle)
npm run build

# 2. Launch Extension Development Host
code-insiders --extensionDevelopmentPath="$PWD" --disable-extensions
```

In the dev host window, verify:

1. **Output panel** → dropdown → **Chat Customizations Evaluations**
2. You should see `[Activation] Language server started successfully`
   — **not** `this.outputChannel.error is not a function`
3. Open any `.prompt.md`, `.instructions.md`, or `AGENTS.md` file
4. Run **Chat Customizations Evaluations: Analyze** from the command palette
5. Diagnostics should appear in the Problems panel — **not** `Client is not running`

#### Sanity check — the change is trivially correct

`LogOutputChannel` extends `OutputChannel`, so all existing `appendLine()`
calls remain valid, and the `LanguageClient` now gets the `.error()`,
`.warn()`, `.info()`, `.debug()` methods it calls during startup. Both
`tsc -p ./` (root) and `tsc -p ./` (client) compile with zero errors.

---

## 6. Upstream status

**Reported.** [Issue #276](https://github.com/microsoft/vscode-chat-customizations-evaluation/issues/276) — *"Chat customizations evaluations: this.outputChannel.error is not a function"* — opened by `roblourens` (~1 week before this writing), currently **open**, assigned to `aiday-mar`, labeled `bug`.

**Fix implemented & pushed.** Forked into [`karol-brejna-i/vscode-chat-customizations-evaluation`](https://github.com/karol-brejna-i/vscode-chat-customizations-evaluation), branch [`dev/kbrejna/fix-outputchannel-logoutputchannel`](https://github.com/karol-brejna-i/vscode-chat-customizations-evaluation/tree/dev/kbrejna/fix-outputchannel-logoutputchannel). One-line change in `client/src/extension.ts:48`:

```diff
-    this.outputChannel = vscode.window.createOutputChannel('Chat Customizations Evaluations');
+    this.outputChannel = vscode.window.createOutputChannel('Chat Customizations Evaluations', { log: true });
```

Both `tsc -p ./` (root) and `tsc -p ./` (client) compile clean. Ready to open a PR against `microsoft/vscode-chat-customizations-evaluation` targeting #276.

---

## 7. If you are an AI agent picking this up

Current state: **fix implemented, built, pushed to fork; PR not yet opened.**

Remaining work:

1. **Open a PR** from `karol-brejna-i/vscode-chat-customizations-evaluation` branch `dev/kbrejna/fix-outputchannel-logoutputchannel` → `microsoft/vscode-chat-customizations-evaluation` `main`. Reference #276 in the description.
2. The one-line change is in `client/src/extension.ts:48` — nothing else was touched.

Fork: https://github.com/karol-brejna-i/vscode-chat-customizations-evaluation
Branch: `dev/kbrejna/fix-outputchannel-logoutputchannel`

Rules of engagement:

- **Do not** file a duplicate of #276.
- **Do not** "fix" `Client is not running` directly. It is downstream of the
  startup TypeError and has no independent cause.
- **Do not** modify anything in `ghcp-history-viewer` because of this. The two
  are unrelated; this doc is a lodger.
- Line numbers in §4 are for bundle `1.1.2026072818` **before** the §5 patch.
  After patching, line 25574 is longer by ` , { log: true }`. Re-`grep` rather
  than trusting the numbers on any other version.
- The bundle is generated (esbuild). Never hand-edit it as a *durable* fix —
  the §5 patch is an interim unblock only. The real fix is upstream.
