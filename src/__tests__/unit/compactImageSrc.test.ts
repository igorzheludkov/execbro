import { describe, it, expect } from "@jest/globals";
import { compactImageSrc } from "../../core/screenState.js";

describe("compactImageSrc", () => {
    it("names an inline image by type instead of printing base64", () => {
        // The app-side collector already cuts the src, so a size would be invented.
        expect(compactImageSrc("data:application/octet-stream;base64,/9j/4QDeRXhpZgAASUkqAAg")).toBe("data:application/octet-stream (inline)");
    });

    it("leaves a URL alone", () => {
        expect(compactImageSrc("https://picsum.photos/x.jpg")).toBe("https://picsum.photos/x.jpg");
    });
});
