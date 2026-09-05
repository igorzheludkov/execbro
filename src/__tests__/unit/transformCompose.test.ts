import { composeTransformOps, isNativeDriven, animatedValueOf } from "../../core/injected/transformCompose.js";

const nativeAnimated = (value: number) => ({ __getValue: () => value, __isNative: true });
const jsAnimated = (value: number) => ({ __getValue: () => value, __isNative: false });

describe("composeTransformOps", () => {
    // The bug this file exists for: Gorhom holds its sheet open with a plain numeric
    // translateY, measureInWindow already reports the displaced frame, and composing the
    // translation moved the sheet's CLOSE button off the viewport so the sheet listed as
    // containing no pressables at all.
    it("does not move the frame for a static numeric translation", () => {
        const c = composeTransformOps([{ translateY: 422 }]);
        expect(c.dy).toBe(0);
        expect(c.dx).toBe(0);
        expect(c.uncertain).toBe(false);
    });

    // <View style={s}/> renders an RCTView carrying the identical style, so the walk up the
    // ancestors meets the same translation twice. Composing nothing is what makes that
    // harmless — 422 became 844 and put the sheet's only button off the viewport.
    it("stays at zero however many ancestors repeat the same static translation", () => {
        const ops = [{ translateY: 422 }];
        const total = [composeTransformOps(ops), composeTransformOps(ops)]
            .reduce((sum, c) => sum + c.dy, 0);
        expect(total).toBe(0);
    });

    it("does not move the frame for a JS-driven Animated translation", () => {
        const c = composeTransformOps([{ translateY: jsAnimated(422) }]);
        expect(c.dy).toBe(0);
        expect(c.uncertain).toBe(false);
    });

    // The case the composition exists for: RN pins sticky headers with useNativeDriver,
    // which never reaches the shadow tree measureInWindow reads.
    it("composes a native-driven translation and flags it", () => {
        const c = composeTransformOps([{ translateX: nativeAnimated(-40) }, { translateY: nativeAnimated(1830) }]);
        expect(c.dx).toBe(-40);
        expect(c.dy).toBe(1830);
        expect(c.uncertain).toBe(true);
        expect(c.label).toBe("translateX:-40");
    });

    it("flags a non-identity scale/rotate without pretending to model it", () => {
        expect(composeTransformOps([{ scale: 1 }]).uncertain).toBe(false);
        const c = composeTransformOps([{ rotate: 0.5 }]);
        expect(c.uncertain).toBe(true);
        expect(c.label).toBe("rotate:0.5");
    });

    it("flags an unreadable value rather than dropping it silently", () => {
        const c = composeTransformOps([{ translateY: { some: "opaque node" } }]);
        expect(c.dy).toBe(0);
        expect(c.uncertain).toBe(true);
        expect(c.label).toBe("translateY:<unreadable>");
    });

    it("flags a transform that is not an array", () => {
        const c = composeTransformOps("translateY(10px)");
        expect(c.uncertain).toBe(true);
        expect(c.label).toBe("transform:<opaque>");
    });

    it("returns a zero offset for no transform", () => {
        expect(composeTransformOps(null)).toEqual({ dx: 0, dy: 0, uncertain: false, label: null });
    });
});

describe("value readers", () => {
    it("reads an Animated node's current value", () => {
        expect(animatedValueOf(jsAnimated(12))).toBe(12);
        expect(animatedValueOf(42)).toBeNull();
        expect(animatedValueOf({ __getValue: () => NaN })).toBeNull();
        expect(
            animatedValueOf({
                __getValue: () => {
                    throw new Error("detached");
                }
            })
        ).toBeNull();
    });

    it("recognises only an explicitly native-driven node", () => {
        expect(isNativeDriven(nativeAnimated(1))).toBe(true);
        expect(isNativeDriven(jsAnimated(1))).toBe(false);
        expect(isNativeDriven(5)).toBe(false);
    });
});
