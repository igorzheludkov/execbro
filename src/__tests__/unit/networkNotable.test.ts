import { describe, it, expect } from "@jest/globals";
import { notableLines } from "../../core/networkNotable.js";
import type { NetworkRequest } from "../../core/types.js";

const req = (id: string, url: string, postData?: string, responseBody?: string, status = 200) =>
    ({ requestId: id, url, method: "POST", headers: {}, timestamp: new Date(0), completed: true, epoch: 1, postData, responseBody, status }) as NetworkRequest;

describe("notableLines", () => {
    it("flags price sent as string where responses carry a number", () => {
        // The benchmark's T1: the order body was printed in all three runs, named as a bug once.
        const order = req("o", "http://localhost:8092/carts", '{"items":[{"id":1,"quantity":2,"price":"9.99"}]}');
        const others = [
            req("a", "http://localhost:8092/products", undefined, '[{"id":1,"price":9.99}]'),
            req("b", "http://localhost:8092/products/1", undefined, '{"id":1,"price":9.99}'),
        ];
        expect(notableLines(order, others)).toEqual(['"price" is a string here, a number in 2 other bodies on localhost:8092.']);
    });

    it("ignores other hosts", () => {
        const order = req("o", "http://localhost:8092/carts", '{"price":"9.99"}');
        expect(notableLines(order, [req("a", "https://api.keygen.sh/v1", undefined, '{"price":9.99}')])).toEqual([]);
    });

    it("ignores keys whose type already varies elsewhere", () => {
        const order = req("o", "http://localhost:8092/carts", '{"price":"9.99"}');
        const others = [req("a", "http://localhost:8092/p", undefined, '{"price":9.99}'), req("b", "http://localhost:8092/q", undefined, '{"price":"1.00"}')];
        expect(notableLines(order, others)).toEqual([]);
    });

    it("ignores null on either side", () => {
        const order = req("o", "http://localhost:8092/carts", '{"price":null}');
        expect(notableLines(order, [req("a", "http://localhost:8092/p", undefined, '{"price":9.99}')])).toEqual([]);
    });

    it("quotes a 4xx validation message", () => {
        expect(notableLines(req("x", "http://localhost:8092/carts", "{}", '{"errors":[{"message":"price must be a number"}]}', 422), []))
            .toEqual(['422 says "price must be a number".']);
    });

    it("returns nothing for non-JSON bodies", () => {
        expect(notableLines(req("x", "http://localhost:8092/page", "a=1", "<html>oops</html>", 404), [])).toEqual([]);
    });
});

describe("formatRequestDetails with notable lines", () => {
    it("renders them right after the header block", async () => {
        const { formatRequestDetails } = await import("../../core/network.js");
        const out = formatRequestDetails(req("o", "http://localhost:8092/carts", '{"price":"9.99"}'), { notable: ['"price" is a string here, a number in 2 other bodies on localhost:8092.'] });
        expect(out).toContain('Notable: "price" is a string here');
        expect(out.indexOf("Notable:")).toBeLessThan(out.indexOf("--- Request Body ---"));
    });
});
