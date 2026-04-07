import { describe, it, expect, beforeEach } from "@jest/globals";
import { ImageBuffer } from "../../core/imageBuffer.js";
import type { ImageEntry, ImageGroup } from "../../core/imageBuffer.js";

function makeEntry(overrides: Partial<ImageEntry> = {}): ImageEntry {
    return {
        id: overrides.id || `img-${Date.now()}-${Math.random()}`,
        image: overrides.image || Buffer.from("fake-png-data"),
        timestamp: overrides.timestamp || Date.now(),
        source: overrides.source || "test",
        groupId: overrides.groupId,
        metadata: overrides.metadata,
    };
}

describe("ImageBuffer", () => {
    let buffer: ImageBuffer;

    beforeEach(() => {
        buffer = new ImageBuffer(5);
    });

    it("starts empty", () => {
        expect(buffer.size).toBe(0);
        expect(buffer.listEntries()).toEqual([]);
    });

    it("adds and retrieves an entry by ID", () => {
        const entry = makeEntry({ id: "img-1", source: "ios_screenshot" });
        buffer.add(entry);
        expect(buffer.size).toBe(1);
        const retrieved = buffer.getById("img-1");
        expect(retrieved).toBeDefined();
        expect(retrieved!.source).toBe("ios_screenshot");
        expect(retrieved!.image).toEqual(entry.image);
    });

    it("evicts oldest entry when capacity exceeded", () => {
        for (let i = 0; i < 6; i++) {
            buffer.add(makeEntry({ id: `img-${i}`, timestamp: i }));
        }
        expect(buffer.size).toBe(5);
        expect(buffer.getById("img-0")).toBeUndefined();
        expect(buffer.getById("img-1")).toBeDefined();
        expect(buffer.getById("img-5")).toBeDefined();
    });

    it("listEntries returns metadata without image data", () => {
        buffer.add(makeEntry({ id: "img-1", source: "tap-burst", metadata: { frameIndex: 0 } }));
        const list = buffer.listEntries();
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe("img-1");
        expect(list[0].source).toBe("tap-burst");
        expect(list[0].metadata).toEqual({ frameIndex: 0 });
        expect((list[0] as any).image).toBeUndefined();
    });

    it("filters entries by source", () => {
        buffer.add(makeEntry({ id: "img-1", source: "ios_screenshot" }));
        buffer.add(makeEntry({ id: "img-2", source: "tap-burst" }));
        buffer.add(makeEntry({ id: "img-3", source: "ios_screenshot" }));
        const filtered = buffer.listEntries({ source: "ios_screenshot" });
        expect(filtered).toHaveLength(2);
        expect(filtered.every(e => e.source === "ios_screenshot")).toBe(true);
    });

    it("returns last N entries", () => {
        for (let i = 0; i < 5; i++) {
            buffer.add(makeEntry({ id: `img-${i}`, timestamp: i }));
        }
        const last2 = buffer.listEntries({ last: 2 });
        expect(last2).toHaveLength(2);
        expect(last2[0].id).toBe("img-3");
        expect(last2[1].id).toBe("img-4");
    });

    it("clears all entries and returns count", () => {
        buffer.add(makeEntry({ id: "img-1" }));
        buffer.add(makeEntry({ id: "img-2" }));
        const count = buffer.clear();
        expect(count).toBe(2);
        expect(buffer.size).toBe(0);
    });
});

describe("ImageBuffer groups", () => {
    let buffer: ImageBuffer;

    beforeEach(() => {
        buffer = new ImageBuffer(20);
    });

    it("adds a group and retrieves it", () => {
        buffer.addGroup({
            groupId: "burst-1",
            intent: "tap-verification",
            source: "tap-burst",
            timestamp: Date.now(),
            frameCount: 5,
            summary: { peakChangeRate: 0.04, peakFrame: 2 },
        });
        const groups = buffer.listGroups();
        expect(groups).toHaveLength(1);
        expect(groups[0].groupId).toBe("burst-1");
        expect(groups[0].summary.peakChangeRate).toBe(0.04);
    });

    it("retrieves entries by groupId", () => {
        buffer.add(makeEntry({ id: "f-0", groupId: "burst-1", metadata: { frameIndex: 0 } }));
        buffer.add(makeEntry({ id: "f-1", groupId: "burst-1", metadata: { frameIndex: 1 } }));
        buffer.add(makeEntry({ id: "other", source: "ios_screenshot" }));
        const frames = buffer.listEntries({ groupId: "burst-1" });
        expect(frames).toHaveLength(2);
        expect(frames.every(e => e.groupId === "burst-1")).toBe(true);
    });

    it("retrieves specific frame from group by frameIndex", () => {
        buffer.add(makeEntry({ id: "f-0", groupId: "burst-1", metadata: { frameIndex: 0 } }));
        buffer.add(makeEntry({ id: "f-1", groupId: "burst-1", metadata: { frameIndex: 1 } }));
        buffer.add(makeEntry({ id: "f-2", groupId: "burst-1", metadata: { frameIndex: 2 } }));
        const frame = buffer.getByGroupFrame("burst-1", 1);
        expect(frame).toBeDefined();
        expect(frame!.id).toBe("f-1");
    });

    it("evicts group metadata when all group entries are evicted", () => {
        const smallBuffer = new ImageBuffer(3);
        smallBuffer.addGroup({
            groupId: "burst-old",
            intent: "tap-verification",
            source: "tap-burst",
            timestamp: Date.now(),
            frameCount: 2,
            summary: {},
        });
        smallBuffer.add(makeEntry({ id: "g-0", groupId: "burst-old" }));
        smallBuffer.add(makeEntry({ id: "g-1", groupId: "burst-old" }));
        smallBuffer.add(makeEntry({ id: "new-1" }));
        smallBuffer.add(makeEntry({ id: "new-2" }));
        smallBuffer.add(makeEntry({ id: "new-3" }));
        expect(smallBuffer.listEntries({ groupId: "burst-old" })).toHaveLength(0);
        expect(smallBuffer.listGroups()).toHaveLength(0);
    });
});
