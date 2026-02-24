# Native Library Rebuild & Verify

Rebuild and verify the app after installing native Expo libraries. Use this after adding any native module that requires a dev client rebuild (e.g. expo install of a native package).

## When to Trigger

Use this skill when the task involves:
- Installing a native Expo library (any package that requires a dev client rebuild)
- Adding native modules that are not compatible with Expo Go
- After running `npx expo install` for a native package
- When the app crashes due to missing native modules after a new package install

After a native library has been installed, run the full rebuild and verification pipeline. Execute each step sequentially — only proceed to the next step if the previous one succeeds.

## Step 1 — Prebuild

Run the Expo prebuild to regenerate native projects:

```
npx expo prebuild --clean
```

If prebuild fails, stop and report the error. Do NOT continue to the build steps.

## Step 2 — Build & run on iOS

```
npm run ios:dev
```

Wait for the build to complete and the app to launch on the iOS simulator. If the build fails, stop and report the error.

## Step 3 — Verify iOS

Use MCP tools to take a screenshot of the iOS simulator and verify the app is running correctly. Report what you see.

## Step 4 — Build & run on Android

```
npm run android
```

Wait for the build to complete and the app to launch on the Android emulator. If the build fails, stop and report the error.

## Step 5 — Verify Android

Use MCP tools to take a screenshot of the Android device/emulator and verify the app is running correctly. Report what you see.

## Step 6 — Summary

Provide a summary:
- What was installed: $ARGUMENTS
- Prebuild: pass/fail
- iOS build: pass/fail
- iOS screenshot: what was observed
- Android build: pass/fail
- Android screenshot: what was observed
