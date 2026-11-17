import { describe, it, expect } from "@jest/globals";

import { isNewer, noticeFor, updateNotice } from "../../core/updateNotice.js";

describe("update notice", () => {
    it("compares x.y.z numerically, not as strings", () => {
        expect(isNewer("2.26.4", "2.19.0")).toBe(true);
        expect(isNewer("2.10.0", "2.9.9")).toBe(true);
        expect(isNewer("2.19.0", "2.19.0")).toBe(false);
        expect(isNewer("2.19.0", "2.26.4")).toBe(false); // running ahead of latest (beta)
        expect(isNewer("2.20.0", "2.19.0-harmony.9")).toBe(true);
        expect(isNewer("2.20.0", "unknown")).toBe(false);
    });

    it("names both versions and the @latest fix, or stays silent when current", () => {
        const notice = noticeFor("2.19.0", "2.26.4")!;
        expect(notice).toContain("2.19.0");
        expect(notice).toContain("2.26.4");
        expect(notice).toContain("npx -y execbro@latest");
        expect(noticeFor("2.26.4", "2.26.4")).toBeNull();
    });

    it("never shows in a source checkout", () => {
        expect(updateNotice()).toBeNull();
    });
});
