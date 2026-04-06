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

describe("Category 1: RN Fiber & JS Strategies", () => {
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
        // Verify input is focused by checking if keyboard appeared or component state
        // The fiber strategy detects onChangeText and falls through to native tap
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
});

describe("Category 2: RN Coordinates & Verification", () => {
    it("tap by pixel coordinates", async () => {
        // First, tap by testID to find the element's coordinates
        const findResult = await tap({ testID: "submit-btn", screenshot: true });
        expect(findResult.success).toBe(true);
        expect(findResult.tappedAt).toBeDefined();

        await resetTestState();
        await sleep(500);

        // Now tap at those exact coordinates
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
});

describe("Category 3: Non-RN Native App (System Apps)", () => {
    const IOS_SETTINGS_BUNDLE = "com.apple.Preferences";
    const ANDROID_SETTINGS_PACKAGE = "com.android.settings";

    const describeIOS = () => platform === "ios" ? describe : describe.skip;
    const describeAndroid = () => platform === "android" ? describe : describe.skip;

    describeIOS()("iOS native app tests", () => {
        it("tap Settings item by text (iOS)", async () => {
            const { iosLaunchApp } = await import("../../core/ios.js");
            await iosLaunchApp(IOS_SETTINGS_BUNDLE);
            await sleep(2000);

            const result = await tap({ text: "General", native: true });
            expect(result.success).toBe(true);
        }, 30000);

        it("tap by OCR on native app (iOS)", async () => {
            const { iosLaunchApp } = await import("../../core/ios.js");
            await iosLaunchApp(IOS_SETTINGS_BUNDLE);
            await sleep(2000);

            const result = await tap({ text: "General", strategy: "ocr", native: true });
            expect(result.success).toBe(true);
            expect(result.method).toBe("ocr");
        }, 30000);

        it("find and tap via iOS accessibility tree", async () => {
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
    });

    describeAndroid()("Android native app tests", () => {
        it("tap Settings item by text (Android)", async () => {
            const { androidLaunchApp } = await import("../../core/android.js");
            await androidLaunchApp(ANDROID_SETTINGS_PACKAGE);
            await sleep(2000);

            const result = await tap({ text: "Network", native: true });
            expect(result.success).toBe(true);
        }, 30000);

        it("tap by OCR on native app (Android)", async () => {
            const { androidLaunchApp } = await import("../../core/android.js");
            await androidLaunchApp(ANDROID_SETTINGS_PACKAGE);
            await sleep(2000);

            const result = await tap({ text: "Network", strategy: "ocr", native: true });
            expect(result.success).toBe(true);
            expect(result.method).toBe("ocr");
        }, 30000);

        it("find and tap via Android accessibility tree", async () => {
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
    });

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
