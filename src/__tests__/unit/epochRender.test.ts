import { withRestartDividers, evictionNotice, resolveEpochFilter } from "../../core/epochRender.js";
import { bumpEpoch, resetEpochs, getLogBuffer, logBuffers, networkBuffers } from "../../core/state.js";

describe("withRestartDividers", () => {
    it("inserts a divider where the epoch changes", () => {
        const entries = [
            { epoch: 1, msg: "a" },
            { epoch: 1, msg: "b" },
            { epoch: 2, msg: "c" },
        ];
        expect(withRestartDividers(entries, e => e.msg)).toBe(
            "a\nb\n── app restarted (epoch 2) ──\nc"
        );
    });

    it("emits no divider for a single epoch", () => {
        expect(withRestartDividers([{ epoch: 1, msg: "a" }], e => e.msg)).toBe("a");
    });

    it("handles an empty list", () => {
        expect(withRestartDividers([] as { epoch: number; msg: string }[], e => e.msg)).toBe("");
    });
});

describe("evictionNotice", () => {
    it("is empty when nothing was dropped", () => {
        expect(evictionNotice(0, "EXECBRO_LOG_BUFFER_SIZE")).toBe("");
    });

    it("reports the count with a thousands separator", () => {
        expect(evictionNotice(3412, "EXECBRO_LOG_BUFFER_SIZE")).toBe(
            "\n\n[3,412 older entries evicted — raise EXECBRO_LOG_BUFFER_SIZE to retain more]"
        );
    });
});

describe("resolveEpochFilter", () => {
    beforeEach(() => {
        resetEpochs();
        logBuffers.clear();
        networkBuffers.clear();
    });

    it("defaults to no filter", () => {
        expect(resolveEpochFilter(undefined, "dev")).toBeUndefined();
        expect(resolveEpochFilter("all", "dev")).toBeUndefined();
    });

    it("resolves 'current' to the device's epoch", () => {
        getLogBuffer("dev");
        bumpEpoch("dev");
        expect(resolveEpochFilter("current", "dev")).toBe(2);
    });

    it("resolves 'current' from a device SUBSTRING, not the raw argument", () => {
        // The tool argument is a substring ("iPhone"); the buffer key is the
        // full name. Looking the epoch up under the raw argument returns 1 and
        // serves pre-restart data labelled as current.
        getLogBuffer("iPhone 17 Pro");
        bumpEpoch("iPhone 17 Pro");
        expect(resolveEpochFilter("current", "iPhone")).toBe(2);
    });

    it("resolves 'current' to the newest run when no device is given", () => {
        getLogBuffer("iPhone 17 Pro");
        getLogBuffer("sdk_gphone64_arm64");
        bumpEpoch("sdk_gphone64_arm64");
        expect(resolveEpochFilter("current", undefined)).toBe(2);
    });

    it("passes a numeric epoch through", () => {
        expect(resolveEpochFilter(1, "dev")).toBe(1);
    });
});
