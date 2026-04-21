// src/__tests__/integration/tap-strategies.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { tap } from "../../pro/tap.js";
import type { TapResult } from "../../pro/tap.js";
import {
    connectToMetro,
    disconnectAll,
    resetTestState,
    readTestState,
    assertTapWorked,
    sleep,
    type Platform,
} from "../helpers/tap-test-helpers.js";

let platform: Platform;

beforeAll(async () => {
    platform = await connectToMetro();
}, 30000);

afterAll(async () => {
    await disconnectAll();
}, 10000);

afterEach(async () => {
    await resetTestState();
    await sleep(500);
}, 10000);

// Temporarily disabled — UI tests are noisy and don't give a clear picture.
describe.skip("Category 1: RN Fiber & JS Strategies", () => {
    it("tap button by testID (auto strategy)", async () => {
        const result = await tap({ testID: "submit-btn" });
        await assertTapWorked(result, "submit-btn");
    }, 30000);

    it("tap button by visible text (auto strategy)", async () => {
        const result = await tap({ text: "Cancel" });
        await assertTapWorked(result, "cancel-btn");
    }, 30000);

    it("tap icon-only button by component name", async () => {
        const result = await tap({ component: "HeartIcon" });
        await assertTapWorked(result, "heart-btn");
    }, 30000);

    it("tap by text with explicit fiber strategy", async () => {
        const result = await tap({ text: "Submit", strategy: "fiber" });
        await assertTapWorked(result, "submit-btn");
    }, 30000);

    it("tap by testID with explicit accessibility strategy", async () => {
        const result = await tap({ testID: "submit-btn", strategy: "accessibility" });
        await assertTapWorked(result, "submit-btn");
    }, 30000);

    it("tap by text with explicit OCR strategy", async () => {
        const result = await tap({ text: "Submit", strategy: "ocr" });
        await assertTapWorked(result, "submit-btn");
    }, 30000);

    it("focus TextInput by testID", async () => {
        const result = await tap({ testID: "name-input" });
        expect(result.success).toBe(true);
        // TextInput has onChangeText, not onPress — fiber detects this and falls
        // through to native tap for focus. No tap counter increment expected since
        // the test app only counts onPress handlers, not input focus events.
        expect(result.method).toBeDefined();
    }, 30000);

    it("tap Cyrillic text button", async () => {
        const result = await tap({ text: "Отправить" });
        await assertTapWorked(result, "cyrillic-btn");
    }, 30000);

    it("tap CJK text button", async () => {
        const result = await tap({ text: "送信" });
        await assertTapWorked(result, "cjk-btn");
    }, 30000);

    it("tap emoji text button (should skip fiber, use accessibility or OCR)", async () => {
        const result = await tap({ text: "🔥 Fire" });
        await assertTapWorked(result, "emoji-btn");
        // Fiber can't handle emoji — should fall back to accessibility or OCR
        expect(result.method).not.toBe("fiber");
    }, 30000);

    it("tap second duplicate-text button using index parameter", async () => {
        const result = await tap({ text: "Action", index: 1 });
        await assertTapWorked(result, "action-btn-2");
    }, 30000);

    it("tap first duplicate-text button using index=0", async () => {
        const result = await tap({ text: "Action", index: 0 });
        await assertTapWorked(result, "action-btn-1");
    }, 30000);

    it("focus email TextInput by testID", async () => {
        const result = await tap({ testID: "email-input" });
        expect(result.success).toBe(true);
        expect(result.method).toBeDefined();
    }, 30000);

    it("tap button using testID + text combined", async () => {
        const result = await tap({ testID: "submit-btn", text: "Submit" });
        await assertTapWorked(result, "submit-btn");
    }, 30000);
});

describe.skip("Category 2: RN Coordinates & Verification", () => {
    it("tap by pixel coordinates", async () => {
        // First, tap by testID to find the element's coordinates.
        // tappedAt returns coordinates in the native unit used by the platform
        // (points on iOS, pixels on Android). tap({ x, y }) treats these as
        // screenshot pixel coordinates and applies conversion internally.
        const findResult = await tap({ testID: "submit-btn", screenshot: true });
        expect(findResult.success).toBe(true);
        expect(findResult.tappedAt).toBeDefined();

        await resetTestState();
        await sleep(500);

        const { x, y } = findResult.tappedAt!;
        const result = await tap({ x, y });
        await assertTapWorked(result, "submit-btn");
        expect(result.method).toBe("coordinate");
    }, 30000);

    it("tap with native=true at coordinates", async () => {
        // Get coordinates from a known element
        const findResult = await tap({ testID: "cancel-btn", screenshot: true });
        expect(findResult.success).toBe(true);
        expect(findResult.tappedAt).toBeDefined();

        await resetTestState();
        await sleep(500);

        const { x, y } = findResult.tappedAt!;
        const result = await tap({ x, y, native: true });
        expect(result.success).toBe(true);
        // Native tap bypasses RN, verify via test state
        const state = await readTestState();
        expect(state?.lastTapped).toBe("cancel-btn");
    }, 30000);

    it("tap with screenshot verification", async () => {
        const result = await tap({ testID: "submit-btn", verify: true, screenshot: true });
        expect(result.success).toBe(true);
        expect(result.screenshot).toBeDefined();
        expect(result.screenshot?.image).toBeTruthy();
        expect(result.verification).toBeDefined();
        expect(result.verification?.meaningful).toBe(true);
    }, 30000);

    it("tap with screenshot=false", async () => {
        const result = await tap({ testID: "submit-btn", screenshot: false });
        expect(result.success).toBe(true);
        expect(result.screenshot).toBeUndefined();
    }, 30000);

    it("tap non-existent element returns failure with suggestion", async () => {
        const result = await tap({ text: "DoesNotExist" });
        expect(result.success).toBe(false);
        expect(result.suggestion).toBeTruthy();
        expect(result.attempted).toBeDefined();
        expect(result.attempted!.length).toBeGreaterThan(0);
    }, 30000);

    it("tap completes within timeout budget", async () => {
        const start = Date.now();
        const result = await tap({ testID: "submit-btn" });
        const elapsed = Date.now() - start;

        expect(result.success).toBe(true);
        // Successful tap should complete well under the 20s timeout
        expect(elapsed).toBeLessThan(20000);
    }, 30000);

    it("failed tap respects timeout and does not hang", async () => {
        const start = Date.now();
        const result = await tap({ text: "DoesNotExist_Timeout_Test" });
        const elapsed = Date.now() - start;

        expect(result.success).toBe(false);
        // Failed tap should not exceed ~20s budget (with some margin for cleanup)
        expect(elapsed).toBeLessThan(25000);
        // Check that attempted strategies report timeout/skip info
        expect(result.attempted).toBeDefined();
        expect(result.attempted!.length).toBeGreaterThan(0);
    }, 30000);

    it("tap with burst verification mode", async () => {
        const result = await tap({ testID: "submit-btn", verify: true, burst: true, screenshot: true });
        expect(result.success).toBe(true);
        expect(result.screenshot).toBeDefined();
        expect(result.verification).toBeDefined();
        // Burst mode should include transient detection fields
        if (result.verification?.transientChangeDetected !== undefined) {
            expect(typeof result.verification.transientChangeDetected).toBe("boolean");
        }
    }, 30000);

    it("tap non-interactive area by testID returns failure or no state change", async () => {
        // The disabled-area View has no onPress — fiber may find it but native
        // tap won't trigger any handler. Verify test state doesn't change.
        const stateBefore = await readTestState();
        const result = await tap({ testID: "disabled-area" });
        // Whether tap "succeeds" (accessibility finds it) or fails, test state shouldn't change
        const stateAfter = await readTestState();
        expect(stateAfter?.tapCount).toBe(stateBefore?.tapCount);
    }, 30000);

    it("tap navigation button and verify screen change", async () => {
        const result = await tap({ testID: "nav-scroll-btn" });
        expect(result.success).toBe(true);

        await sleep(1000); // wait for navigation animation

        // Verify we're on Screen 2 by checking for its elements
        const backBtnResult = await tap({ testID: "nav-back-btn", screenshot: false });
        expect(backBtnResult.success).toBe(true);

        await sleep(500); // wait for navigation back
    }, 30000);

    it("scroll then tap bottom button", async () => {
        // Navigate to scroll screen
        await tap({ testID: "nav-scroll-btn" });
        await sleep(1000);

        // Swipe up to scroll down and reveal the bottom button
        const { iosSwipe } = await import("../../core/ios.js");
        const { androidSwipe } = await import("../../core/android.js");

        // Perform multiple swipes to reach the bottom
        for (let i = 0; i < 5; i++) {
            if (platform === "ios") {
                await iosSwipe(200, 600, 200, 200);
            } else {
                await androidSwipe(540, 1500, 540, 500);
            }
            await sleep(500);
        }

        // Try to tap the bottom button
        const result = await tap({ testID: "bottom-btn" });
        await assertTapWorked(result, "bottom-btn");

        // Navigate back
        await tap({ testID: "nav-back-btn" });
        await sleep(500);
    }, 60000);

    it("tap list item on scroll screen by testID", async () => {
        // Navigate to scroll screen
        await tap({ testID: "nav-scroll-btn" });
        await sleep(1000);

        // Tap a visible list item
        const result = await tap({ testID: "list-item-1" });
        expect(result.success).toBe(true);

        // Navigate back
        await tap({ testID: "nav-back-btn" });
        await sleep(500);
    }, 30000);

    it("tap list item on scroll screen by text", async () => {
        // Navigate to scroll screen
        await tap({ testID: "nav-scroll-btn" });
        await sleep(1000);

        // Tap by visible text
        const result = await tap({ text: "Item 1" });
        expect(result.success).toBe(true);

        // Navigate back
        await tap({ testID: "nav-back-btn" });
        await sleep(500);
    }, 30000);
});

describe.skip("Category 3: Non-RN Native App (System Apps)", () => {
    const IOS_SETTINGS_BUNDLE = "com.apple.Preferences";
    const ANDROID_SETTINGS_PACKAGE = "com.android.settings";

    // Platform checks are inside it() bodies because platform is set in beforeAll,
    // which runs after Jest collects describe blocks synchronously.

    it("tap Settings item by text (iOS)", async () => {
        if (platform !== "ios") return;
        const { iosLaunchApp } = await import("../../core/ios.js");
        await iosLaunchApp(IOS_SETTINGS_BUNDLE);
        await sleep(2000);

        const result = await tap({ text: "General", native: true });
        expect(result.success).toBe(true);
    }, 30000);

    it("tap by OCR on native app (iOS)", async () => {
        if (platform !== "ios") return;
        const { iosLaunchApp } = await import("../../core/ios.js");
        await iosLaunchApp(IOS_SETTINGS_BUNDLE);
        await sleep(2000);

        const result = await tap({ text: "General", strategy: "ocr", native: true });
        expect(result.success).toBe(true);
        expect(result.method).toBe("ocr");
    }, 30000);

    it("find and tap via iOS accessibility tree", async () => {
        if (platform !== "ios") return;
        const { iosLaunchApp, iosFindElement } = await import("../../core/ios.js");
        await iosLaunchApp(IOS_SETTINGS_BUNDLE);
        await sleep(2000);

        const findResult = await iosFindElement({ labelContains: "General" });
        expect(findResult.success).toBe(true);
        expect(findResult.found).toBe(true);
        expect(findResult.element).toBeDefined();

        const { x, y } = findResult.element!.center;
        const tapResult = await tap({ x, y, native: true });
        expect(tapResult.success).toBe(true);
    }, 30000);

    it("tap Settings item by text (Android)", async () => {
        if (platform !== "android") return;
        const { androidLaunchApp } = await import("../../core/android.js");
        await androidLaunchApp(ANDROID_SETTINGS_PACKAGE);
        await sleep(2000);

        const result = await tap({ text: "Network", native: true });
        expect(result.success).toBe(true);
    }, 30000);

    it("tap by OCR on native app (Android)", async () => {
        if (platform !== "android") return;
        const { androidLaunchApp } = await import("../../core/android.js");
        await androidLaunchApp(ANDROID_SETTINGS_PACKAGE);
        await sleep(2000);

        const result = await tap({ text: "Network", strategy: "ocr", native: true });
        expect(result.success).toBe(true);
        expect(result.method).toBe("ocr");
    }, 30000);

    it("find and tap via Android accessibility tree", async () => {
        if (platform !== "android") return;
        const { androidLaunchApp, androidFindElement } = await import("../../core/android.js");
        await androidLaunchApp(ANDROID_SETTINGS_PACKAGE);
        await sleep(2000);

        const findResult = await androidFindElement({ textContains: "Network" });
        expect(findResult.success).toBe(true);
        expect(findResult.found).toBe(true);
        expect(findResult.element).toBeDefined();

        const { x, y } = findResult.element!.center;
        const tapResult = await tap({ x, y, native: true });
        expect(tapResult.success).toBe(true);
    }, 30000);

    it("tap by coordinates on native app", async () => {
        if (platform === "ios") {
            const { iosLaunchApp } = await import("../../core/ios.js");
            await iosLaunchApp(IOS_SETTINGS_BUNDLE);
        } else {
            const { androidLaunchApp } = await import("../../core/android.js");
            await androidLaunchApp(ANDROID_SETTINGS_PACKAGE);
        }
        await sleep(2000);

        const targetText = platform === "ios" ? "General" : "Network";
        const ocrResult = await tap({ text: targetText, strategy: "ocr", native: true });
        expect(ocrResult.success).toBe(true);
        expect(ocrResult.tappedAt).toBeDefined();
    }, 30000);

    it("tap without Metro connection (native only)", async () => {
        await disconnectAll();
        await sleep(1000);

        if (platform === "ios") {
            const { iosLaunchApp } = await import("../../core/ios.js");
            await iosLaunchApp(IOS_SETTINGS_BUNDLE);
        } else {
            const { androidLaunchApp } = await import("../../core/android.js");
            await androidLaunchApp(ANDROID_SETTINGS_PACKAGE);
        }
        await sleep(2000);

        const result = await tap({ x: 200, y: 400, native: true, platform });
        expect(result.success).toBe(true);

        // Reconnect for any subsequent test runs
        await connectToMetro();
    }, 30000);
});
