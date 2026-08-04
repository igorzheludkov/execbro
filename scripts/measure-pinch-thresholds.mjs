#!/usr/bin/env node
// Measures pinch recognizer thresholds on a running emulator.
// Usage: node scripts/measure-pinch-thresholds.mjs <experiment>
// Experiments: travel | halfsep | edge | ratio
//
// Open Google Maps on the emulator first — it zooms continuously, so any
// recognised pinch changes the screen.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveEmulatorBridge } from "../build/core/emulatorBridge.js";
import { sendTouchFrames } from "../build/core/emulatorGrpc.js";

const exec = promisify(execFile);
const experiment = process.argv[2] ?? "travel";

const serial = (await exec("adb", ["devices"])).stdout
    .split("\n").slice(1).map((l) => l.split("\t")[0]).filter(Boolean)[0];
const res = await resolveEmulatorBridge(serial);
if (!res.ok) throw new Error(res.message);
const bridge = res.bridge;

const size = (await exec("adb", ["shell", "wm", "size"])).stdout.match(/(\d+)x(\d+)/);
const W = Number(size[1]), H = Number(size[2]);
console.log(`# device ${serial}  ${W}x${H}  grpc :${bridge.port}  experiment=${experiment}`);

const screenshot = async () => (await exec("adb", ["exec-out", "screencap", "-p"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 })).stdout;

// Byte-length difference is a coarse but sufficient "did anything change" probe.
const changed = (a, b) => Math.abs(a.length - b.length) > a.length * 0.01;

async function pinch({ startHalf, endHalf, cx = W / 2, cy = H / 2, steps = 20, interval = 16 }) {
    const frames = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const half = Math.round(startHalf + (endHalf - startHalf) * t);
        const pressure = i === steps ? 0 : 1024;
        frames.push([
            { x: Math.round(cx - half), y: Math.round(cy), identifier: 0, pressure },
            { x: Math.round(cx + half), y: Math.round(cy), identifier: 1, pressure },
        ]);
    }
    return sendTouchFrames(bridge, frames, interval);
}

async function trial(label, params) {
    const before = await screenshot();
    const r = await pinch(params);
    await new Promise((s) => setTimeout(s, 1500));
    const after = await screenshot();
    const ok = r.success && changed(before, after);
    console.log(`${ok ? "RECOGNISED" : "no-op     "}  ${label}`);
    return ok;
}

if (experiment === "travel") {
    // Smallest separation CHANGE that still registers as a zoom.
    for (const delta of [4, 8, 12, 16, 24, 32, 48, 64, 96]) {
        await trial(`travel ${delta * 2}px total`, { startHalf: 200, endHalf: 200 + delta });
    }
} else if (experiment === "halfsep") {
    // Smallest starting half-separation that is still seen as two contacts.
    for (const half of [4, 8, 12, 16, 24, 32, 48]) {
        await trial(`start half ${half}px`, { startHalf: half, endHalf: half + 200 });
    }
} else if (experiment === "edge") {
    // How close to the screen edge a contact may start before the OS
    // back-gesture claims it. Watch the screen: navigating away = claimed.
    for (const inset of [4, 8, 16, 24, 32, 48, 64, 96, 128]) {
        const half = Math.round(W / 2) - inset;
        await trial(`inset ${inset}px (start half ${half})`, { startHalf: half, endHalf: 80 });
    }
} else if (experiment === "ratio") {
    // Largest single-gesture ratio that still produces a zoom.
    for (const ratio of [2, 3, 4, 6, 8, 12]) {
        const endHalf = Math.round(W / 2) - 64;
        await trial(`ratio ${ratio}`, { startHalf: Math.round(endHalf / ratio), endHalf });
    }
}
