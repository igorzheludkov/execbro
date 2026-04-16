export interface PressableCandidate {
    name: string;
    meaningfulComponentName?: string | null;
    text: string;
    testID: string | null;
    ancestorTestIDs?: string[];
    path?: string;
    isInput: boolean;
    isPressable?: boolean;
    source?: string;
}

export interface FiberMatchQuery {
    text?: string;
    testID?: string;
    component?: string;
    index?: number;
}

export interface FiberMatchResult {
    matchIndex: number;
    candidate: PressableCandidate;
    totalMatches: number;
    allMatches: number[];
}

export function matchFiberCandidates(
    pressables: PressableCandidate[],
    query: FiberMatchQuery
): FiberMatchResult | null {
    const { text, testID, component, index = 0 } = query;
    const textQ = text ? text.toLowerCase() : null;
    const componentQ = component ? component.toLowerCase() : null;
    const matches: number[] = [];

    for (let i = 0; i < pressables.length; i++) {
        const p = pressables[i];

        if (textQ !== null && !(p.text || "").toLowerCase().includes(textQ)) continue;

        if (testID) {
            const ownMatch = p.testID === testID;
            const ancestorMatch = (p.ancestorTestIDs || []).includes(testID);
            if (!ownMatch && !ancestorMatch) continue;
        }

        if (componentQ !== null) {
            const ownName = (p.name || "").toLowerCase();
            const meaningful = (p.meaningfulComponentName || "").toLowerCase();
            if (!ownName.includes(componentQ) && !meaningful.includes(componentQ)) continue;
        }

        matches.push(i);
    }

    if (matches.length === 0) return null;
    if (index >= matches.length) return null;
    return {
        matchIndex: matches[index],
        candidate: pressables[matches[index]],
        totalMatches: matches.length,
        allMatches: matches,
    };
}
