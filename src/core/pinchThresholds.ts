/**
 * Pinch geometry thresholds, measured on our own hardware.
 *
 * Every value here comes from scripts/measure-pinch-thresholds.mjs run against
 * a Pixel 9 emulator (emulator 37.1.11, API 36, 1080x2424) driving Google Maps.
 * Do not adjust one without re-running that experiment and updating both the
 * number and the comment. Full measurement record:
 * docs/devtools-core/notes/2026-08-04-pinch-threshold-measurements.md
 */

/**
 * Gap between frames. Every gesture in every experiment used a 16ms cadence
 * and was recognised, so this is the measured-good value rather than a
 * derived one. Recognizers read velocity from the frame sequence, so a much
 * coarser cadence would read as a jump.
 */
export const FRAME_INTERVAL_MS = 16;

/** Non-zero pressure means "contact down". The proto's range maxes at 1024. */
export const PRESSURE_DOWN = 1024;

/**
 * MEASURED: injected contacts stay separate no matter how close they are —
 * a 4px half-separation was still recognised as a two-finger pinch. Unlike
 * real fingers they cannot merge, because each is its own kernel MT slot with
 * its own tracking id. 8px is 4px doubled for rounding headroom, not a
 * recognizer limit.
 */
export const MIN_HALF_SEPARATION_PX = 8;

/**
 * MEASURED: the recognizer floor. A 68px total separation change produced
 * BYTE-IDENTICAL screenshots — literally nothing moved — while 72px zoomed
 * the map. Below this a gesture is a guaranteed no-op, so we report it rather
 * than emitting motion nothing will act on.
 */
export const MIN_TRAVEL_PX = 72;

/**
 * Fallback guards, used only when the device's real system bar heights cannot
 * be queried (see androidSystemBars.ts). The two axes differ, and the reason
 * matters:
 *
 * LEFT/RIGHT — MEASURED as safe. Contacts starting at x=0 and x=screenWidth
 * were recognised as a pinch under BOTH three-button and gesture navigation,
 * and the focused window never changed. Android's back-gesture handler bails
 * as soon as a second pointer is down, and both of ours land in the same
 * frame. 4px is only to keep rounded coordinates on screen.
 *
 * TOP/BOTTOM — MEASURED as NOT safe, which a first round of measurement
 * missed. The status and navigation bars are separate windows, not gesture
 * zones: a contact that goes DOWN inside one is delivered to SystemUI and the
 * app never sees it. A vertical pinch whose first contact landed at y=4
 * pulled the notification shade down instead of zooming. The initial vertical
 * experiment only tested pinch-OUT, whose contacts land near the centre, so
 * it never put a touch-down in the status bar.
 *
 * 220/200 covers the Pixel 9 emulator's measured need (a contact had to start
 * below y=176 to reach the app, against a 142px status bar) with headroom.
 * Real values are queried per device at plan time.
 */
export const EDGE_GUARD_PX = { left: 4, right: 4, top: 220, bottom: 200 };

/**
 * MEASURED: full-span gestures (contacts at the very screen edge) were
 * recognised, so there is no need to sacrifice zoom range for safety. This
 * trims 2% purely as rounding headroom.
 */
export const EDGE_UTILIZATION = 0.98;

/**
 * MEASURED: three chained gestures reached street level with a 250ms pause
 * and only city level with no pause, so the pause is doing real work — the
 * third gesture merges into the second without it. 100ms came close to 250ms;
 * 250ms produced the deepest zoom, and it only applies between chained
 * sub-gestures, which are rare.
 */
export const SETTLE_MS = 250;

/**
 * MEASURED: single-gesture ratios of 2, 3, 4, 6, 8, 12 and 16 all zoomed the
 * map — no recognizer ceiling was found. The real limit is geometric (the
 * narrow end cannot go below MIN_HALF_SEPARATION_PX and the wide end cannot
 * leave the screen), and planPinch enforces that separately. 16 is the
 * largest ratio actually verified, so we chain beyond it rather than
 * extrapolating past the evidence.
 */
export const MAX_RATIO_PER_GESTURE = 16;

/**
 * Default `span` for a pinch-IN when the caller does not set one.
 *
 * A pinch-in starts with the fingers at their widest, so at span 1 its first
 * contacts land at the screen extremes — on a status bar, a search field, or
 * a bottom sheet, any of which takes the gesture before the zoomable surface
 * sees it. Measured: a vertical `direction:"in"` on Google Maps and on a
 * gesture-handler lightbox both did nothing at span 1 and zoomed at span 0.5.
 *
 * A pinch-OUT has the opposite geometry — its contacts start near the focal
 * point and travel outward — so it keeps the full span and the widest
 * possible zoom range.
 */
export const PINCH_IN_DEFAULT_SPAN = 0.5;
