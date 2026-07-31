import { withRestartDividers, evictionNotice, resolveEpochFilter } from "../../core/epochRender.js";
import { bumpEpoch, resetEpochs } from "../../core/state.js";

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
    beforeEach(() => resetEpochs());

    it("defaults to no filter", () => {
        expect(resolveEpochFilter(undefined, "dev")).toBeUndefined();
        expect(resolveEpochFilter("all", "dev")).toBeUndefined();
    });

    it("resolves 'current' to the device's epoch", () => {
        bumpEpoch("dev");
        expect(resolveEpochFilter("current", "dev")).toBe(2);
    });

    it("passes a numeric epoch through", () => {
        expect(resolveEpochFilter(1, "dev")).toBe(1);
    });
});
