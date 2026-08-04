import http2 from "node:http2";
import type { EmulatorBridge } from "./emulatorBridge.js";

/** One contact in a touch frame. Coordinates are DEVICE pixels. */
export interface TouchPoint {
    x: number;
    y: number;
    identifier: number;
    pressure: number;
}

const SEND_TOUCH_PATH = "/android.emulation.control.EmulatorController/sendTouch";
/** A single frame should never take this long; something is wrong if it does. */
const FRAME_TIMEOUT_MS = 5000;

function varint(value: number): Buffer {
    const out: number[] = [];
    let v = value;
    while (v > 0x7f) {
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    out.push(v);
    return Buffer.from(out);
}

/** field number + wire type 0 (varint), then the value. */
function varintField(fieldNumber: number, value: number): Buffer {
    return Buffer.concat([varint(fieldNumber << 3), varint(value)]);
}

/** field number + wire type 2 (length-delimited), then length, then bytes. */
function lengthField(fieldNumber: number, payload: Buffer): Buffer {
    return Buffer.concat([varint((fieldNumber << 3) | 2), varint(payload.length), payload]);
}

/**
 * Encode `TouchEvent { repeated Touch touches = 1 }` where
 * `Touch { x = 1, y = 2, identifier = 3, pressure = 4 }`.
 *
 * All four fields are written even when zero. Proto3 would let us omit them,
 * but pressure 0 is the release signal and being explicit keeps the release
 * frame readable on the wire.
 *
 * `display` (field 2) is omitted, which the emulator reads as display 0.
 */
export function encodeTouchEvent(touches: TouchPoint[]): Buffer {
    return Buffer.concat(
        touches.map((t) =>
            lengthField(
                1,
                Buffer.concat([
                    varintField(1, Math.max(0, Math.round(t.x))),
                    varintField(2, Math.max(0, Math.round(t.y))),
                    varintField(3, t.identifier),
                    varintField(4, t.pressure),
                ])
            )
        )
    );
}

/** gRPC length-prefixed message framing: 1 flag byte + 4-byte big-endian length. */
export function frameGrpcMessage(message: Buffer): Buffer {
    const header = Buffer.alloc(5);
    header.writeUInt8(0, 0);
    header.writeUInt32BE(message.length, 1);
    return Buffer.concat([header, message]);
}

function sendOneFrame(
    session: http2.ClientHttp2Session,
    bridge: EmulatorBridge,
    touches: TouchPoint[]
): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = session.request({
            ":method": "POST",
            ":path": SEND_TOUCH_PATH,
            // Must be exactly application/grpc. 'application/grpc+proto' gets
            // the session destroyed by the emulator's server.
            "content-type": "application/grpc",
            authorization: `Bearer ${bridge.token}`,
            te: "trailers",
        });

        let status: string | null = null;
        const timer = setTimeout(() => {
            req.close();
            reject(new Error("timed out waiting for sendTouch"));
        }, FRAME_TIMEOUT_MS);

        const readStatus = (headers: http2.IncomingHttpHeaders) => {
            const s = headers["grpc-status"];
            if (s != null) status = String(s);
        };
        req.on("response", readStatus);
        req.on("trailers", readStatus);
        req.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
        req.on("end", () => {
            clearTimeout(timer);
            if (status === null || status === "0") resolve();
            else reject(new Error(`grpc-status ${status}`));
        });

        req.end(frameGrpcMessage(encodeTouchEvent(touches)));
        req.resume();
    });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Send an ordered list of touch frames over one HTTP/2 session.
 *
 * Reusing the session matters: a fresh connection per frame would blow the
 * gesture's duration budget and the recognizer would see a stutter rather
 * than a smooth pinch.
 *
 * Connects on 127.0.0.1 and uses the port from the discovery file. Never
 * assume the 8554 default — an unrelated process can hold it.
 */
export async function sendTouchFrames(
    bridge: EmulatorBridge,
    frames: TouchPoint[][],
    frameDelayMs: number
): Promise<{ success: boolean; error?: string }> {
    let session: http2.ClientHttp2Session | undefined;
    try {
        session = http2.connect(`http://127.0.0.1:${bridge.port}`);
        // Without a handler an emitted 'error' would be an unhandled rejection;
        // per-request handlers surface the actual failure.
        session.on("error", () => {});

        for (let i = 0; i < frames.length; i++) {
            await sendOneFrame(session, bridge, frames[i]);
            if (i < frames.length - 1 && frameDelayMs > 0) await sleep(frameDelayMs);
        }
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        session?.close();
    }
}
