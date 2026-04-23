# Changelog

## 1.6.0

### BREAKING CHANGES

- **Removed 12 zero-use platform-specific MCP tools** (all showed 0 calls across the 30-day telemetry window on the full install base):
  - iOS: `ios_describe_all`, `ios_describe_point`, `ios_find_element`, `ios_wait_for_element`, `ios_input_text`, `ios_key_event`, `ios_key_sequence`, `ios_swipe`
  - Android: `android_describe_all`, `android_describe_point`, `android_find_element`, `android_wait_for_element`
- Replacements: use `get_screen_layout` (was describe_all), `inspect_at_point` (was describe_point), `find_components` or `tap(text=...)` (was find_element), `ios_button` (was key_event/key_sequence), `tap(text=...)` (was input_text). `wait_for_element` and `ios_swipe` have no direct replacement — telemetry showed 0 real usage.

### Added

- Structured tool descriptions (PURPOSE / WHEN TO USE / WORKFLOW / LIMITATIONS / GOOD / BAD / SEE ALSO) on all primary and mid-volume tools to improve agent discoverability from the tool list alone.
- Platform-fallback banners on remaining iOS and Android native tools pointing at cross-platform equivalents.
- Regression test (`src/__tests__/unit/toolDescriptions.test.ts`) enforcing description length, template coverage, and cross-reference validity.

### Changed

- Server-level MCP `instructions` and `get_usage_guide()` default response now emit a unified decision tree directing agents to primary tools and topic-specific playbooks.
- Registration order of tools now reflects usage priority — agents reading `tools/list` top-down see the most-likely-first-pick tools first.
