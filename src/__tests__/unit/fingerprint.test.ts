import { jest } from "@jest/globals";

// Pass-through mocks: spread the real module so any export the deferred setup
// or transitive deps consume (e.g. child_process.exec) keeps working. Using
// the `node:` protocol bypasses Jest's mock registry for the inner lookup,
// since unstable_mockModule below is keyed on the bare specifier.
const realChildProcess = await import("node:child_process");
const realFs = await import("node:fs");
const realOs = await import("node:os");

const mockExecSync = jest.fn();
jest.unstable_mockModule("child_process", () => ({
    ...realChildProcess,
    execSync: mockExecSync,
}));

const mockReadFileSync = jest.fn();
const mockExistsSync = jest.fn();
jest.unstable_mockModule("fs", () => ({
    ...realFs,
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
}));

const mockUserInfo = jest.fn();
const mockCpus = jest.fn();
const mockPlatform = jest.fn();
jest.unstable_mockModule("os", () => ({
    ...realOs,
    userInfo: mockUserInfo,
    cpus: mockCpus,
    platform: mockPlatform,
}));

const { getDeviceFingerprint, getMachineId } = await import("../../core/fingerprint.js");

describe("fingerprint", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUserInfo.mockReturnValue({ username: "testuser" });
        mockCpus.mockReturnValue([{ model: "Apple M2 Pro" }]);
    });

    describe("getMachineId", () => {
        it("reads hardware UUID on macOS", () => {
            mockPlatform.mockReturnValue("darwin");
            mockExecSync.mockReturnValue("Hardware UUID: ABC123-DEF456-GHI789\n");

            const id = getMachineId();
            expect(id).toBe("ABC123-DEF456-GHI789");
            expect(mockExecSync).toHaveBeenCalledWith("system_profiler SPHardwareDataType", expect.any(Object));
        });

        it("reads /etc/machine-id on Linux", () => {
            mockPlatform.mockReturnValue("linux");
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue("abc123def456\n");

            const id = getMachineId();
            expect(id).toBe("abc123def456");
        });

        it("reads MachineGuid from registry on Windows", () => {
            mockPlatform.mockReturnValue("win32");
            mockExecSync.mockReturnValue("    MachineGuid    REG_SZ    {12345-ABCDE}\n");

            const id = getMachineId();
            expect(id).toBe("{12345-ABCDE}");
        });

        it("returns empty string on unsupported platform", () => {
            mockPlatform.mockReturnValue("freebsd");

            const id = getMachineId();
            expect(id).toBe("");
        });

        it("returns empty string when command fails", () => {
            mockPlatform.mockReturnValue("darwin");
            mockExecSync.mockImplementation(() => {
                throw new Error("command not found");
            });

            const id = getMachineId();
            expect(id).toBe("");
        });
    });

    describe("getDeviceFingerprint", () => {
        it("returns consistent SHA256 hash", () => {
            mockPlatform.mockReturnValue("darwin");
            mockExecSync.mockReturnValue("Hardware UUID: ABC123\n");

            const fp1 = getDeviceFingerprint();
            const fp2 = getDeviceFingerprint();
            expect(fp1).toBe(fp2);
            expect(fp1).toMatch(/^[a-f0-9]{64}$/);
        });

        it("produces different hashes for different inputs", () => {
            mockPlatform.mockReturnValue("darwin");
            mockExecSync.mockReturnValue("Hardware UUID: ABC123\n");
            const fp1 = getDeviceFingerprint();

            mockUserInfo.mockReturnValue({ username: "otheruser" });
            const fp2 = getDeviceFingerprint();

            expect(fp1).not.toBe(fp2);
        });

        it("still produces a hash when machineId is unavailable (degraded mode)", () => {
            mockPlatform.mockReturnValue("darwin");
            mockExecSync.mockImplementation(() => {
                throw new Error("permission denied");
            });

            const fp = getDeviceFingerprint();
            expect(fp).toMatch(/^[a-f0-9]{64}$/);
        });
    });
});
