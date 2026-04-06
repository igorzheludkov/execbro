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
