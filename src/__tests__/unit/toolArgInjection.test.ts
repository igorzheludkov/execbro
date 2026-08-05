import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Regression guard for the argv conversion (`fix(exec): stop tool arguments
 * reaching a host shell`). Four parameters were confirmed to execute host
 * commands before it:
 *
 *   ios_open_url(url)           -> xcrun simctl openurl <udid> "<url>"
 *   ios_launch_app(bundleId)    -> xcrun simctl launch <udid> <bundleId>
 *   ios_boot_simulator(udid)    -> xcrun simctl boot <udid>
 *   android_launch_app(package) -> adb shell monkey -p <package> ...
 *
 * The property asserted is that a payload containing shell metacharacters
 * arrives as ONE argv element, never as a command string a shell would parse.
 * That is what makes `$(...)` and `; ...` inert.
 *
 * The exec layer is mocked. An earlier version of this file called the real
 * xcrun and adb paths and asserted that a marker file was absent afterwards —
 * which meant every `npx jest` opened URLs, launched apps, booted simulators
 * and typed the payload onto whatever emulator happened to be attached. The
 * guarantee is about the arguments we construct, so the arguments are what
 * this checks; a device was never needed to see them.
 *
 * The complementary check — that execFileAsync itself does not hand its
 * arguments to a shell — lives in commandInjection.test.ts and runs against
 * echo and sh, no device tooling required.
 */

const execFileAsyncMock =
    jest.fn<(file: string, args: string[], opts?: unknown) => Promise<{ stdout: string; stderr: string }>>();

jest.unstable_mockModule("../../core/exec.js", () => ({
    execFileAsync: execFileAsyncMock,
    // Real implementation: the device-side shell still parses what adb hands it,
    // so quoting has to behave normally for the android assertions to mean
    // anything. Copied rather than imported to keep the mock self-contained.
    quoteForDeviceShell: (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`,
    execAsync: jest.fn(),
    withCancelableTimeout: jest.fn(),
}));

const { iosOpenUrl, iosLaunchApp, iosTerminateApp, iosBootSimulator } = await import("../../core/ios.js");
const { androidLaunchApp, androidInputText } = await import("../../core/android.js");

const MARKER = "/tmp/execbro-marker.txt";
const SUBSTITUTION = `$(touch ${MARKER})`;
const SEPARATOR = `; touch ${MARKER}`;

/** Every argv element passed to the exec layer across all recorded calls. */
function allArgs(): string[] {
    return execFileAsyncMock.mock.calls.flatMap((call) => call[1] ?? []);
}

/** Device-side shell quoting, mirroring core/exec.ts. */
const quoted = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** The whole command as a flat string, for "no element was concatenated" checks. */
function flattened(): string {
    return execFileAsyncMock.mock.calls
        .map((call) => `${call[0]} ${(call[1] ?? []).join(" ")}`)
        .join("\n");
}

describe("tool arguments never reach a host shell", () => {
    beforeEach(() => {
        execFileAsyncMock.mockReset();
        // Device discovery goes through the same call. Without a device in the
        // list the android tools return before building a command, and the
        // assertions below would pass against a command that never existed.
        execFileAsyncMock.mockImplementation(async (file, args) => {
            const argv = (args ?? []).join(" ");
            if (file === "adb" && argv.startsWith("devices")) {
                return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
            }
            return { stdout: "", stderr: "" };
        });
    });

    it("ios_open_url: a url with command substitution stays one argv element", async () => {
        const url = `myapp://x${SUBSTITUTION}`;
        await iosOpenUrl(url, "booted").catch(() => undefined);

        expect(execFileAsyncMock).toHaveBeenCalled();
        // The payload is present verbatim as a single argument — not split on
        // whitespace, not embedded in a longer command string.
        expect(allArgs()).toContain(url);
        for (const [file] of execFileAsyncMock.mock.calls) {
            expect(file).not.toMatch(/\s/); // argv[0] is a bare binary, never a shell line
            expect(file).not.toBe("sh");
            expect(file).not.toBe("/bin/sh");
        }
    });

    it("ios_launch_app: a bundle id with a statement separator stays one argv element", async () => {
        const bundleId = `com.example.app${SEPARATOR}`;
        await iosLaunchApp(bundleId, "booted").catch(() => undefined);
        expect(allArgs()).toContain(bundleId);
    });

    it("ios_terminate_app: a bundle id with a statement separator stays one argv element", async () => {
        const bundleId = `com.example.app${SEPARATOR}`;
        await iosTerminateApp(bundleId, "booted").catch(() => undefined);
        expect(allArgs()).toContain(bundleId);
    });

    it("ios_boot_simulator: a udid with a statement separator stays one argv element", async () => {
        const udid = `AAAA${SEPARATOR}`;
        await iosBootSimulator(udid).catch(() => undefined);
        expect(allArgs()).toContain(udid);
    });

    it("android_launch_app: a package name with a statement separator is not shell-parsed", async () => {
        const pkg = `com.example.app${SEPARATOR}`;
        await androidLaunchApp(pkg).catch(() => undefined);

        // `adb shell` hands its command to a shell ON THE DEVICE, which parses
        // it a second time — so here the protection is quoting, not argv
        // separation. The payload must appear wrapped, making the `;` literal.
        const flat = flattened();
        expect(flat).toContain("monkey"); // the launch command was actually built
        expect(flat).toContain(quoted(pkg));
        // And never bare, which is what would let the device shell act on it.
        expect(flat).not.toContain(` ${pkg} `);
    });

    it("android_input_text: text with command substitution is not shell-parsed", async () => {
        const text = `hello ${SUBSTITUTION}`;
        await androidInputText(text).catch(() => undefined);

        // androidInputText types character by character, each one quoted for the
        // device shell separately. The metacharacters therefore never even
        // appear adjacent to each other, let alone unquoted.
        const flat = flattened();
        expect(flat).toContain("input text"); // the type command was actually built
        expect(flat).toContain(quoted("$")); // the '$' went across as a literal
        expect(flat).not.toContain("$("); // never a substitution the shell could see
        expect(flat).not.toContain(text); // and never the whole payload in one piece
    });

    it("no tool builds argv[0] as a shell invocation", async () => {
        await iosOpenUrl(`myapp://x${SUBSTITUTION}`, "booted").catch(() => undefined);
        await androidLaunchApp(`com.example.app${SEPARATOR}`).catch(() => undefined);
        await androidInputText(`hello ${SUBSTITUTION}`).catch(() => undefined);

        for (const [file] of execFileAsyncMock.mock.calls) {
            expect(["sh", "bash", "zsh", "/bin/sh", "/bin/bash"]).not.toContain(file);
        }
    });
});
