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

### 5. Push to Remote

- Run `git push && git push --tags`

### 6. Create GitHub Release

- Run `gh release create v<new-version> --title "v<new-version>" --notes "<release-notes>"`
- Use the composed release notes from step 3

### 7. Monitor Publish

- Run `gh run list --limit 1` to show the triggered workflow
- Inform the user that the publish workflow has been triggered
- Optionally wait and check the final status

## Arguments

- `$ARGUMENTS` - Optional: version bump type (`patch`, `minor`, or `major`). Defaults to `patch`.

## Usage Examples

- `/release` - Patch release (1.0.23 → 1.0.24)
- `/release minor` - Minor release (1.0.23 → 1.1.0)
- `/release major` - Major release (1.0.23 → 2.0.0)

## Notes

- Requires `gh` CLI to be installed and authenticated
- Uncommitted changes are committed automatically as part of step 1 (no separate `/commit` needed)
- The GitHub Actions workflow handles the actual npm publish
