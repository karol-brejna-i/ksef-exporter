# Project Guidelines

## Conventions

### Git commit messages
Use [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages:

```
<type>(<optional scope>): <short summary>

<optional body>

<optional footer(s)>
```

- `type` must be one of: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- If a commit genuinely spans multiple types, prefer the most impactful type (e.g. `fix` over `test`) and describe both changes in the body. Ideally, split such work into separate commits.
- Use the imperative mood in the summary (e.g. "add", not "added"/"adds").
- Keep the summary line concise (~72 chars max) and all lowercase, including proper nouns and acronyms (e.g. `fix jwt token expiry`, not `fix JWT token expiry`); no trailing period.
- Add a `!` after the type/scope (e.g. `feat!:`) or a `BREAKING CHANGE:` footer for breaking changes.
- Reference issues/PRs in the footer when relevant (e.g. `Refs #12`).

<!--
Add future conventions below as their own subsections, e.g.:
### Branch naming
### PR titles
-->
