import { describe, it, expect, beforeEach } from "@jest/globals";
import {
    rememberHostAddresses,
    hostAddressChangeHint,
    resetHostAddress,
} from "../../core/hostAddress.js";

describe("host address change detection", () => {
    let addresses: string[];

    beforeEach(() => {
        addresses = ["192.168.1.73"];
        resetHostAddress(() => addresses);
    });

    it("says nothing before any device connected", () => {
        addresses = ["192.168.0.105"];
        expect(hostAddressChangeHint()).toBeNull();
    });

    it("says nothing while the address is unchanged", () => {
        rememberHostAddresses();
        expect(hostAddressChangeHint()).toBeNull();
    });

    it("says nothing when an address is only added (e.g. VPN up)", () => {
        rememberHostAddresses();
        addresses = ["192.168.1.73", "10.8.0.2"];
        expect(hostAddressChangeHint()).toBeNull();
    });

    it("names the old and new address when the connect-time address is gone", () => {
        rememberHostAddresses();
        addresses = ["192.168.0.105"];
        const hint = hostAddressChangeHint(8081);
        expect(hint).toContain("NETWORK ADDRESS CHANGED");
        expect(hint).toContain("192.168.1.73");
        expect(hint).toContain("192.168.0.105");
        expect(hint).toContain("http%3A%2F%2Flocalhost%3A8081");
    });

    it("re-arms on the next successful connect", () => {
        rememberHostAddresses();
        addresses = ["192.168.0.105"];
        rememberHostAddresses();
        expect(hostAddressChangeHint()).toBeNull();
    });
});
