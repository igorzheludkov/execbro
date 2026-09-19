# Verify Change Skill

Check work that has just been finished, on the running app, before it is handed to anyone else. The audience is the developer who wrote it.

## When to Trigger

Use this skill when the task involves:
- The user saying they have finished a feature, a refactor or a fix and want to know whether it actually works
- "Check my work", "did I break anything", "verify this before I open a PR", "is this ready for QA"
- A code change that is already written (by the user, or earlier in this session) and now needs exercising on the device
- Confirming a bug is genuinely fixed rather than apparently fixed

Do NOT use this skill while still writing the change. This is the pass that happens after the code is done.

## The one rule

**Report what you find. Do not fix it.**

When this skill is running, a bug you discover is the deliverable. A bug you quietly fix is a bug the developer never hears about, and they will hand the branch on believing the pass was clean. If something is broken, write it down and keep going.

If the user asks you to fix something you reported, that is a new task and this skill is finished.

## Instructions

### 1. Establish what "working" means

Before touching the device, read the change and state, in one or two lines, what it is supposed to do. Ask the user if the intent is not clear from the diff.

Do not take the description as fact. The value of this pass is entirely in the gap between what the developer believes they built and what the app does.

### 2. Get the change live

- `mcp__execbro__reload_app` so the current code is running
- `mcp__execbro__get_bundle_errors` to confirm it compiled at all
- Take a screenshot to establish the starting state

A change that has not actually reached the device is the most common false pass. Confirm it did.

### 3. Walk the flow

- Drive it with `mcp__execbro__tap`, `mcp__execbro__input_text`, `mcp__execbro__swipe`
- Screenshot each state you reach, not just the final one
- After each step, `mcp__execbro__get_logs` and `mcp__execbro__get_bundle_errors`

A warning that appears only during the new flow is a finding even when the screen looks correct.

### 4. Check the neighbours

This is the step that gets skipped and the one that pays.

Regressions after a refactor live **next to** the change, not in it. Identify what else reads the same state, renders the same component, or routes through the same screen, then exercise those too.

- `mcp__execbro__find_components` and `mcp__execbro__inspect_component` to find other users of a changed component
- `mcp__execbro__redux_get_state` / `mcp__execbro__inspect_global` to see what else reads a changed slice of state
- `mcp__execbro__navigate` to reach the other screens quickly

### 5. Reach the error paths

A feature that works on the happy path only is not verified. Use the data layer rather than hoping the backend misbehaves:

- `mcp__execbro__network_mock` to force the error response the UI claims to handle
- `mcp__execbro__network_condition` to force offline or a slow connection
- `mcp__execbro__network_replay` to re-issue a captured request

### 6. Report

Give the user these sections, in this order:

- **Verdict**: ready to hand over or not, and the single most important reason
- **What works**: only behaviour you actually observed on the device, each line saying what you did and what you saw
- **What does not**: each with repro steps and what you expected instead
- **Not checked**: what you could not reach and why, such as missing credentials, an unreachable backend, or a state you could not construct

**"Not checked" is what makes the rest trustworthy.** Never present a flow you did not exercise as passing. If you could not log in, say so; do not report the logged-in screens as working because the code looks right.

## Common mistakes

- **Verifying the source instead of the app.** Reading the diff tells you what was intended. Only the device tells you what happens.
- **Fixing as you go.** See "The one rule".
- **Stopping at the happy path.** Step 5 exists for this.
- **Only checking what the task mentions.** Step 4 exists for this.
- **Reporting a clean pass after a shallow one.** An honest "I checked three of the five things and here is why" is worth far more than a confident summary of a pass that did not happen.

## When the session is the wrong place for this

If the user is still editing while you verify, your reloads and their saves will fight, and neither of you will trust the result.

If `execbro-runner` is installed, the verification can run in its own worktree, Metro and simulator instead, leaving their session alone:

```bash
execbro-task add prompts/check-it.md --verify --base <their-branch>
```

That runs the same discipline as this skill against an isolated copy, and returns a written report. Suggest it when the user wants to keep working, or when the change is large enough that the pass will take a while. It is optional tooling, so check `which execbro-task` before recommending it, and do not block on it.
