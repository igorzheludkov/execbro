import { getEpoch, bumpEpoch, resetEpochs } from "../../core/state.js";
import { logBufferSize, networkBufferSize } from "../../core/bufferConfig.js";

describe("sessionEpoch", () => {
    beforeEach(() => resetEpochs());

    it("starts at 1 for an unseen device", () => {
        expect(getEpoch("iPhone 17 Pro")).toBe(1);
    });

    it("increments on bump and returns the new value", () => {
        expect(bumpEpoch("iPhone 17 Pro")).toBe(2);
        expect(getEpoch("iPhone 17 Pro")).toBe(2);
    });

    it("tracks epochs independently per device", () => {
        bumpEpoch("iPhone 17 Pro");
        bumpEpoch("iPhone 17 Pro");
        expect(getEpoch("iPhone 17 Pro")).toBe(3);
        expect(getEpoch("sdk_gphone64_arm64")).toBe(1);
    });
});

describe("bufferConfig", () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    it("defaults to 2000 logs and 1000 network entries", () => {
        expect(logBufferSize()).toBe(2000);
        expect(networkBufferSize()).toBe(1000);
    });

    it("honours env overrides", () => {
        process.env.EXECBRO_LOG_BUFFER_SIZE = "50";
        process.env.EXECBRO_NET_BUFFER_SIZE = "25";
        expect(logBufferSize()).toBe(50);
        expect(networkBufferSize()).toBe(25);
    });

    it("ignores non-numeric and non-positive overrides", () => {
        process.env.EXECBRO_LOG_BUFFER_SIZE = "abc";
        expect(logBufferSize()).toBe(2000);
        process.env.EXECBRO_LOG_BUFFER_SIZE = "0";
        expect(logBufferSize()).toBe(2000);
    });
});
