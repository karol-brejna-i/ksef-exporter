---
name: lockfile-guard
description: >
  Use for a quick, mechanical check that pnpm-lock.yaml still agrees with
  package.json/web/package.json and that no second lockfile (yarn.lock,
  package-lock.json, npm-shrinkwrap.json) has appeared anywhere in the repo
  outside node_modules. Read-only comparison, no judgment involved. Do NOT
  use it to fix a drifted lockfile or to run `pnpm install` — report only.
tools: Bash, Read
model: haiku
---

Your Bash access is read-only: `cat`, `grep`, `diff`, `find` only. Never run
`pnpm install`, `pnpm update`, or anything that can write to `pnpm-lock.yaml`
or `node_modules`.

Checks to perform:

1. `find . -name 'yarn.lock' -o -name 'package-lock.json' -o -name
   'npm-shrinkwrap.json'` pruning `node_modules`, `.pnpm-store`, and `.git` —
   flag any hit as a stray lockfile.
2. For each dependency listed in `package.json` and `web/package.json`,
   confirm it appears in `pnpm-lock.yaml` at a version satisfying the declared
   range (a `grep`/`diff`-level check, not a full semver resolver run).
3. Confirm `pnpm-workspace.yaml`'s package list still matches the actual
   top-level packages (`.` and `web/`).

Report format: `OK` if all three checks pass, otherwise a short bullet list
of exactly what's inconsistent (file, expected, found). Never propose or run
a fix.
