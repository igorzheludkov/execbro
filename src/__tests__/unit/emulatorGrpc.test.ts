import { describe, it, expect } from "@jest/globals";
import { encodeTouchEvent, frameGrpcMessage } from "../../core/emulatorGrpc.js";

describe("encodeTouchEvent", () => {
    it("encodes two contacts byte-identically to the official serializer", () => {
        const bytes = encodeTouchEvent([
            { x: 100, y: 200, identifier: 0, pressure: 1024 },
            { x: 900, y: 200, identifier: 1, pressure: 1024 },
        ]);
        expect(bytes.toString("hex")).toBe(
            "0a0a086410c80118002080080a0b08840710c8011801208008"
        );
    });

    it("encodes a zero-pressure release explicitly", () => {
        // pressure 0 is the release signal; it must appear on the wire as 20 00.
        const bytes = encodeTouchEvent([{ x: 5, y: 0, identifier: 1, pressure: 0 }]);
        expect(bytes.toString("hex")).toBe("0a080805100018012000");
    });

    it("encodes multi-byte varints for coordinates above 127", () => {
        // x=900 -> 0x384 -> varint 84 07
        const bytes = encodeTouchEvent([{ x: 900, y: 0, identifier: 0, pressure: 0 }]);
        expect(bytes.toString("hex")).toContain("088407");
    });
});

describe("frameGrpcMessage", () => {
    it("prefixes an uncompressed flag and a big-endian length", () => {
        const framed = frameGrpcMessage(Buffer.from([0xaa, 0xbb]));
        expect(framed.toString("hex")).toBe("00000000 02 aabb".replace(/ /g, ""));
    });

    it("keeps the payload intact after the 5-byte header", () => {
        const payload = encodeTouchEvent([{ x: 1, y: 2, identifier: 0, pressure: 1 }]);
        const framed = frameGrpcMessage(payload);
        expect(framed.length).toBe(payload.length + 5);
        expect(framed.subarray(5).equals(payload)).toBe(true);
        expect(framed.readUInt32BE(1)).toBe(payload.length);
    });
});
