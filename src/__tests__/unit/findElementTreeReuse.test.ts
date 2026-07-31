import { describe, it, expect } from "@jest/globals";
import { iosFindElement } from "../../core/ios.js";
import { androidFindElement } from "../../core/android.js";

/**
 * The accessibility tap strategy runs two or three predicates over the SAME
 * screen. Each find used to re-dump the accessibility tree (`axe describe-ui`
 * ~210ms on iOS, a uiautomator dump on Android), so a single tap paid for the
 * dump 2-3x. These tests pin the contract that makes the reuse possible: when a
 * tree is supplied, no device call happens and matching runs against it.
 *
 * They also guard the failure mode of the optimisation — a caller passing a
 * failed/empty tree must get an honest miss, never a silent device re-fetch.
 */

const iosTree = {
    success: true,
    rawOutput: JSON.stringify([{ frame: { x: 0, y: 0, width: 402, height: 874 } }]),
    elements: [
        {
            label: "Proceed to Checkout",
            value: "",
            type: "Button",
            identifier: "checkout-btn",
            frame: { x: 20, y: 810, width: 380, height: 56 },
            center: { x: 210, y: 838 },
            enabled: true,
            traits: [],
        },
    ],
} as unknown as Parameters<typeof iosFindElement>[2];

describe("iosFindElement with a pre-fetched tree", () => {
    it("matches against the supplied tree without touching the device", async () => {
        // No simulator is involved: a udid that cannot exist would make a real
        // describe-ui fail, so a match here proves the tree was used.
        const result = await iosFindElement(
            { labelContains: "Checkout" },
            "00000000-0000-0000-0000-000000000000",
            iosTree
        );

        expect(result.success).toBe(true);
        expect(result.allMatches?.length).toBe(1);
        expect(result.allMatches?.[0].label).toBe("Proceed to Checkout");
    });

    it("reports a clean miss for a predicate the tree doesn't satisfy", async () => {
        const result = await iosFindElement(
            { labelContains: "Nonexistent" },
            "00000000-0000-0000-0000-000000000000",
            iosTree
        );

        expect(result.found).toBeFalsy();
        expect(result.allMatches ?? []).toHaveLength(0);
    });

    it("surfaces a failed tree instead of silently re-fetching", async () => {
        const failed = { success: false, error: "axe not installed" } as unknown as Parameters<
            typeof iosFindElement
        >[2];
        const result = await iosFindElement(
            { labelContains: "Checkout" },
            "00000000-0000-0000-0000-000000000000",
            failed
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("axe not installed");
    });
});

describe("androidFindElement with a pre-fetched tree", () => {
    const androidTree = {
        success: true,
        elements: [
            {
                text: "Proceed to Checkout",
                resourceId: "com.app:id/checkout",
                contentDesc: "",
                bounds: { x: 20, y: 810, width: 380, height: 56 },
                center: { x: 210, y: 838 },
                clickable: true,
            },
        ],
    } as unknown as Parameters<typeof androidFindElement>[3];

    it("matches against the supplied tree without running uiautomator", async () => {
        const result = await androidFindElement(
            { textContains: "Checkout" },
            "no-such-device",
            undefined,
            androidTree
        );

        expect(result.success).toBe(true);
        expect(result.allMatches?.length).toBe(1);
    });

    it("surfaces a failed tree instead of silently re-dumping", async () => {
        const failed = { success: false, error: "adb offline" } as unknown as Parameters<
            typeof androidFindElement
        >[3];
        const result = await androidFindElement(
            { textContains: "Checkout" },
            "no-such-device",
            undefined,
            failed
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("adb offline");
    });
});
