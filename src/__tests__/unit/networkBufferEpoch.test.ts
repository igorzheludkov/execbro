import { NetworkBuffer } from "../../core/network.js";
import { bumpEpoch, resetEpochs } from "../../core/state.js";
import type { NetworkRequest } from "../../core/types.js";

const req = (id: string, epoch: number, url = "https://api.test/x"): NetworkRequest => ({
    requestId: id,
    timestamp: new Date(),
    method: "GET",
    url,
    headers: {},
    completed: true,
    epoch,
});

describe("NetworkBuffer epoch scoping", () => {
    beforeEach(() => resetEpochs());

    it("keeps same-id requests from different epochs", () => {
        const buf = new NetworkBuffer(10, "dev");
        buf.set("1", req("1", 1, "https://api.test/before"));
        buf.set("1", req("1", 2, "https://api.test/after"));
        expect(buf.size).toBe(2);
        expect(buf.getAll({}).map(r => r.url)).toEqual([
            "https://api.test/before",
            "https://api.test/after",
        ]);
    });

    it("updates in place within one epoch", () => {
        const buf = new NetworkBuffer(10, "dev");
        buf.set("1", req("1", 1));
        buf.set("1", { ...req("1", 1), status: 200 });
        expect(buf.size).toBe(1);
        expect(buf.getAll({})[0].status).toBe(200);
    });

    it("get() finds an entry from a previous epoch", () => {
        const buf = new NetworkBuffer(10, "dev");
        buf.set("1", req("1", 1, "https://api.test/old"));
        bumpEpoch("dev");
        expect(buf.get("1")?.url).toBe("https://api.test/old");
    });

    it("filters getAll by epoch", () => {
        const buf = new NetworkBuffer(10, "dev");
        buf.set("1", req("1", 1));
        buf.set("2", req("2", 2));
        expect(buf.getAll({ epoch: 2 }).map(r => r.requestId)).toEqual(["2"]);
    });

    it("counts evictions", () => {
        const buf = new NetworkBuffer(2, "dev");
        buf.set("1", req("1", 1));
        buf.set("2", req("2", 1));
        buf.set("3", req("3", 1));
        expect(buf.size).toBe(2);
        expect(buf.droppedCount).toBe(1);
    });
});
