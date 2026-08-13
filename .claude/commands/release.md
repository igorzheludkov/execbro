# NPM Release Skill

Automate npm package releases with version bump, git push, and GitHub release creation.

## Instructions

When this skill is invoked, follow these steps:

### 1. Check Current State

- Run `git status` to check the working tree
- If the working tree is clean, continue to step 1b
- If there are uncommitted changes, commit them first before releasing:
    - Run `git diff` to review the changes
    - Draft a concise commit message following the repo's existing style (feat/fix/refactor/docs/test), focusing on the "why"
    - Do NOT commit files that likely contain secrets (`.env`, credentials, etc.) — if any are present, warn the user and stop
    - Stage the relevant files (prefer specific files over `git add -A`) and commit with a HEREDOC message (no "Co-Authored-By" footer)
    - Then continue to step 1b

### 1b. Sweep every surface that describes a changed tool — BEFORE bumping

A tool's schema is not where people and agents learn the tool, and one of the
other surfaces **ships**: `src/core/guides.ts` is what `get_usage_guide` returns,
and it is where agents are explicitly pointed for workflows. A guide that
predates the change goes out inside the build and needs a second release to
correct. That is exactly what 2.8.4 → 2.8.5 was: `tap({duration})` shipped with
only its own description updated, so the shipped guide never mentioned long press
and no agent reading it could discover the parameter.

- Diff the release for tool-surface changes:
  `git diff <previous-tag>..HEAD -- src/tools/ tools.json`
- If a tool gained or lost a parameter, or its behaviour changed in a way its
  description promises, update all of these before bumping:
    - `src/core/guides.ts` — **SHIPS.** The topic guide covering that tool
    - `CLAUDE.md` — the tool list entry *and* the Agent Usage Guidelines bullets
    - `docs/tools.md` — the table row and the example block
    - `skills/*.md` — the skill for that area (e.g. `device-interact.md`)
    - `README.md` — only if its capability list names the behaviour
- Re-describe sibling tools that used to be the way to do the thing. A new
  parameter usually demotes an older tool: `android_long_press` went from "long
  press" to "the no-RN coordinate escape hatch". Grep the tool name across the
  repo — it appears in more places than you expect.
- Verify the shipped guide by calling `get_usage_guide` against the running dev
  server, not by reading the source. That is the copy agents actually receive.
- Commit the sweep, then continue to step 2.

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
  must be `com.execbro/execbro`
- Run `mcp-publisher publish` from the repo root
- If it reports an expired or missing token, re-authenticate. This is **domain**
  auth, not GitHub — it is non-interactive and safe to run unattended:

  ```bash
  mcp-publisher login dns --domain=execbro.com \
    --private-key="$(openssl pkey -in mcp-registry-key.pem -outform DER | tail -c 32 | xxd -p -c 64)"
  ```

  The registry grants the `com.execbro/*` namespace to whoever can sign for the
  apex TXT record on `execbro.com`. `mcp-registry-key.pem` is gitignored and
  lives only on the maintainer's machine — if it is missing, the key must be
  restored from the password manager, not regenerated (regenerating requires
  replacing the DNS record, see below).
- Verify:
  `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.execbro/execbro"`

**Key rotation.** If the signing key is ever replaced, the **old apex TXT record
must be deleted**. A stale record is tried first and causes verification to fail
with a generic signature error that says nothing about the real cause.

**The old namespace is frozen, not redirected.** `io.github.igorzheludkov/execbro`
still lists versions up to 2.1.1 and will never update again. There is no
redirect; nothing to do about it, but do not be surprised to see it in search.

### 10. Sync the website's tool registry (whenever `tools.json` changed)

`tools.json` is regenerated automatically by `postbuild` and published with the
package, so the released artifact is always correct without any action here.
The **website** is a separate repo and cannot be updated by this build, so it is
the one part that needs a step.

- Check whether `tools.json` changed **at all**:
  `git diff <previous-tag>..HEAD -- tools.json`
  A tool added or removed is the obvious case. A **parameter** added or removed on
  an existing tool counts too: it changes the website's copy while leaving the tool
  count identical, so nothing fails and nothing prompts you. That is how the `tap`
  `duration` parameter reached users with a website still describing a tap that
  could not hold.
- If it is unchanged, skip the rest of this step — say so and stop.
- If it changed, wait for the publish workflow to finish, then in `../web`:
    - `npm run tools:sync` (pulls `tools.json` from the newly published package;
      add `-- --local` only to preview against the sibling checkout before release)
    - `npm test` — the catalogue test **will fail** until `src/lib/tools/catalog.ts`
      describes each added tool and drops each removed one. That failure is the
      guard, not an obstacle.
    - Write the missing catalogue entries. These are read by humans on
      `/readme/tools`, so describe what the tool is for in plain prose — do not
      paste the agent-facing MCP description, which carries PURPOSE/WHEN TO USE
      blocks that would bloat the page.
    - When only parameters changed, `catalog.test.ts` stays green — the add/remove
      guard has nothing to catch. Read the affected descriptions yourself and fix
      the ones the change made wrong; a passing suite is not evidence the prose is
      still true.
    - `npm run tools:sync` also picks up drift from *earlier* releases that were
      never synced. Read the whole `registry.json` diff, not just the parameter you
      came for, and mention any extras in the commit message.
    - Commit in `../web` and **push to `main`** — the site auto-deploys from it, so
      an unpushed commit changes nothing users see. Its landing page prints the tool
      count, so that number moves with this commit.

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
- Step 1b runs before the version bump on purpose: `src/core/guides.ts` ships inside the build, so docs fixed after the bump need another release to reach anyone
- The GitHub Actions workflow handles the actual npm publish
