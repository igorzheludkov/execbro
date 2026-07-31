# NPM Release Skill

Automate npm package releases with version bump, git push, and GitHub release creation.

## Instructions

When this skill is invoked, follow these steps:

### 1. Check Current State

- Run `git status` to check the working tree
- If the working tree is clean, continue to step 2
- If there are uncommitted changes, commit them first before releasing:
    - Run `git diff` to review the changes
    - Draft a concise commit message following the repo's existing style (feat/fix/refactor/docs/test), focusing on the "why"
    - Do NOT commit files that likely contain secrets (`.env`, credentials, etc.) — if any are present, warn the user and stop
    - Stage the relevant files (prefer specific files over `git add -A`) and commit with a HEREDOC message (no "Co-Authored-By" footer)
    - Then continue to step 2

### 2. Get Version Bump Type

- Check `$ARGUMENTS` for version type: `patch`, `minor`, or `major`
- Default to `patch` if not specified

### 3. Get Release Notes Context

- Run `git log --oneline -10` to see recent commits
- Identify commits since the last version tag
- Compose a concise release note summarizing the changes

### 4. Bump Version

- Run `npm version <type>` where type is patch/minor/major
- This automatically creates a commit and tag

### 5. Sync `server.json` to the new version

`server.json` is the MCP Registry manifest. Its `version` and
`packages[0].version` must both equal the npm version — the registry rejects a
mismatch, and `npm version` does not touch this file.

- Edit `server.json`: set `version` and `packages[0].version` to the new version
- Fold it into the version commit and move the tag onto the amended commit:
  `git add server.json && git commit --amend --no-edit && git tag -f v<new-version> HEAD`
- Run `mcp-publisher validate` — it must print `✅ server.json is valid`

The amend is safe **only** because nothing has been pushed yet. If step 6 has
already run, do not amend — make a follow-up commit and a new patch release
instead.

### 6. Push to Remote

- Run `git push && git push --tags`

### 7. Create GitHub Release

- Run `gh release create v<new-version> --title "v<new-version>" --notes "<release-notes>"`
- Use the composed release notes from step 3

### 8. Monitor Publish

- Run `gh run list --limit 1` to show the triggered workflow
- Inform the user that the publish workflow has been triggered
- Optionally wait and check the final status

### 9. Publish to the MCP Registry

The registry proves ownership by downloading the **published** npm tarball and
matching its `mcpName` against `server.json`'s `name`, so this step only works
after step 8 has succeeded.

- Confirm the tarball is live and marked:
  `npm view execbro version mcpName` — version must be the new one, `mcpName`
  must be `io.github.igorzheludkov/execbro`
- Run `mcp-publisher publish` from the repo root
- If it reports no valid token, `mcp-publisher login github` is required first.
  That is an interactive GitHub device flow — ask the user to run it themselves
  (`! mcp-publisher login github`) and authorize as **igorzheludkov**; the
  registry only grants the `io.github.igorzheludkov/*` namespace to that identity
- Verify:
  `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.igorzheludkov/execbro"`

### 10. Sync the website's tool registry (only when the tool list changed)

`tools.json` is regenerated automatically by `postbuild` and published with the
package, so the released artifact is always correct without any action here.
The **website** is a separate repo and cannot be updated by this build, so it is
the one part that needs a step.

- Check whether this release added or removed a tool:
  `git diff <previous-tag>..HEAD -- tools.json`
- If it is unchanged, skip the rest of this step — say so and stop.
- If it changed, wait for the publish workflow to finish, then in `../web`:
    - `npm run sync:tools` (pulls `tools.json` from the newly published package;
      add `-- --local` only to preview against the sibling checkout before release)
    - `npm test` — the catalogue test **will fail** until `src/lib/tools/catalog.ts`
      describes each added tool and drops each removed one. That failure is the
      guard, not an obstacle.
    - Write the missing catalogue entries. These are read by humans on
      `/readme/tools`, so describe what the tool is for in plain prose — do not
      paste the agent-facing MCP description, which carries PURPOSE/WHEN TO USE
      blocks that would bloat the page.
    - Commit in `../web` (its landing page prints the tool count, so the number
      users see moves with this commit).

**When this release removes every tool in a catalogue section**, delete the whole
section — heading, `note`, and rows. `catalog.test.ts` fails on an empty section
and scans section notes for dead tool names, but it cannot tell you that a note's
surrounding prose has quietly become a lie; read it.

**The analytics dashboard needs no action.** It reads the published package's own
`tools.json` at runtime via the worker's `/api/tools`, so its tool table follows
this release automatically once npm publish completes (1h edge cache). There is no
list to sync and no Pages redeploy.

**When this release DELETES a parameter or a documented value**, add its name to
the `RETIRED` list in `../web/__tests__/lib/tools/catalog.test.ts`. That list is
the only guard against prose that names dead vocabulary without `=` syntax — the
form "TONL format" took. It is deliberately hand-maintained: inferring it was
tried and abandoned, because parameter names here are ordinary English (`native`,
`events`, `component`, `platform`), so "this word is a parameter of some other
tool" flagged 16 correct descriptions and caught nothing.

Two guards run automatically and need no action:
- `registry.json` now carries each tool's parameter names, so any `name=` in a
  catalogue description must be a real parameter of that tool.
- `tools.json` records parameters, and `toolsJson.test.ts` fails if they drift
  from the live registry.

## Arguments

- `$ARGUMENTS` - Optional: version bump type (`patch`, `minor`, or `major`). Defaults to `patch`.

## Usage Examples

- `/release` - Patch release (1.0.23 → 1.0.24)
- `/release minor` - Minor release (1.0.23 → 1.1.0)
- `/release major` - Major release (1.0.23 → 2.0.0)

## Notes

- Requires `gh` CLI to be installed and authenticated
- Requires `mcp-publisher` (`brew install mcp-publisher`) for steps 5 and 9
- Uncommitted changes are committed automatically as part of step 1 (no separate `/commit` needed)
- The GitHub Actions workflow handles the actual npm publish
