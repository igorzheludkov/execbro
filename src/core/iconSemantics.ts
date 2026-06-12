// ============================================================================
// Icon component name → semantic hint ("possibly back button")
//
// Icon-only pressables usually wrap an icon component whose NAME carries the
// semantics the visible UI doesn't (SvgChevronBackward, CloseIcon, RadioOn).
// This module maps those names to a human/agent-readable guess so labels read
// "SvgChevronBackward — possibly back button" instead of "(icon/image)".
// ============================================================================

/**
 * Split a component name into lowercase words: strips Svg/Icon affixes,
 * splits camelCase / kebab / snake. "SvgChevronBackward" → ["chevron","backward"].
 */
function iconNameWords(name: string): string[] {
    return String(name)
        .replace(/^(Svg|Icon|Ico)(?=[A-Z0-9])/, "")
        .replace(/(Svg|Icon)$/, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
}

// Ordered rules — first match wins. Keywords are matched as whole words so
// "Feedback" does not match "back" and "Background" does not match "back".
// More specific rules (checkbox) must precede their prefixes (check).
const ICON_HINT_RULES: Array<{ keywords: string[]; hint: string }> = [
    { keywords: ["checkbox"], hint: "possibly checkbox" },
    { keywords: ["radio"], hint: "possibly radio button" },
    { keywords: ["back", "backward", "backwards", "goback", "previous", "prev"], hint: "possibly back button" },
    { keywords: ["forward", "next"], hint: "possibly forward/next button" },
    { keywords: ["close", "cross", "xmark", "times", "dismiss"], hint: "possibly close button" },
    { keywords: ["check", "checkmark", "tick", "done"], hint: "possibly confirm/check button" },
    { keywords: ["plus", "add"], hint: "possibly add button" },
    { keywords: ["minus", "subtract"], hint: "possibly remove/decrease button" },
    { keywords: ["trash", "delete", "bin", "garbage"], hint: "possibly delete button" },
    { keywords: ["search", "magnifier", "magnify", "magnifying"], hint: "possibly search button" },
    { keywords: ["menu", "hamburger", "bars", "drawer"], hint: "possibly menu button" },
    { keywords: ["settings", "gear", "cog"], hint: "possibly settings button" },
    { keywords: ["heart", "favorite", "favourite"], hint: "possibly favorite button" },
    { keywords: ["star", "rating"], hint: "possibly rating/favorite button" },
    { keywords: ["share", "export"], hint: "possibly share button" },
    { keywords: ["edit", "pencil", "pen"], hint: "possibly edit button" },
    { keywords: ["camera", "photo"], hint: "possibly camera button" },
    { keywords: ["bell", "notification", "notifications"], hint: "possibly notifications button" },
    { keywords: ["user", "profile", "person", "avatar", "account"], hint: "possibly profile button" },
    { keywords: ["home", "house"], hint: "possibly home button" },
    { keywords: ["cart", "bag", "basket"], hint: "possibly cart button" },
    { keywords: ["filter", "funnel"], hint: "possibly filter button" },
    { keywords: ["refresh", "reload", "sync"], hint: "possibly refresh button" },
    { keywords: ["logout", "signout"], hint: "possibly logout button" },
    { keywords: ["send"], hint: "possibly send button" },
    { keywords: ["download"], hint: "possibly download button" },
    { keywords: ["upload"], hint: "possibly upload button" },
    { keywords: ["copy"], hint: "possibly copy button" },
    { keywords: ["qr", "scan", "barcode"], hint: "possibly scan button" },
    { keywords: ["play"], hint: "possibly play button" },
    { keywords: ["pause"], hint: "possibly pause button" },
    { keywords: ["eye", "visibility"], hint: "possibly visibility toggle" },
    { keywords: ["lock", "padlock"], hint: "possibly lock button" },
    { keywords: ["calendar", "date"], hint: "possibly calendar/date button" },
    { keywords: ["info", "information"], hint: "possibly info button" },
    { keywords: ["question", "help", "faq"], hint: "possibly help button" },
    { keywords: ["more", "dots", "ellipsis", "kebab", "meatball", "options"], hint: "possibly more-options button" },
    { keywords: ["toggle", "switch"], hint: "possibly toggle" },
];

// Direction words for composite chevron/arrow/caret matching.
const ICON_BASES = ["chevron", "arrow", "caret", "angle"];
const DIRECTION_HINTS: Array<{ keywords: string[]; hint: string }> = [
    { keywords: ["left", "back", "backward", "backwards", "previous", "prev"], hint: "possibly back button" },
    { keywords: ["right", "forward", "next"], hint: "possibly forward/next button" },
    { keywords: ["down"], hint: "possibly expand/open button" },
    { keywords: ["up"], hint: "possibly collapse button" },
];

/**
 * Map an icon component name to a semantic guess, or null when the name
 * carries no recognizable icon keyword.
 *
 *   iconSemanticHint("SvgChevronBackward") → "possibly back button"
 *   iconSemanticHint("CheckboxOutline")    → "possibly checkbox"
 *   iconSemanticHint("FloatingHeader")     → null
 */
export function iconSemanticHint(name: string | null | undefined): string | null {
    if (!name) return null;
    const words = iconNameWords(name);
    if (words.length === 0) return null;
    const has = (keywords: string[]) => keywords.some((k) => words.includes(k));

    if (has(ICON_BASES)) {
        for (const rule of DIRECTION_HINTS) {
            if (has(rule.keywords)) return rule.hint;
        }
    }
    for (const rule of ICON_HINT_RULES) {
        if (has(rule.keywords)) return rule.hint;
    }
    return null;
}

/**
 * Build the display label for an icon-only pressable: the most specific
 * component name plus the semantic guess when one exists.
 *
 *   iconLabel("FloatingHeader", "SvgChevronBackward") → "SvgChevronBackward — possibly back button"
 *   iconLabel("FloatingHeader", null)                 → null
 */
export function iconLabel(component: string | null | undefined, icon: string | null | undefined): string | null {
    const source = icon || component;
    const hint = iconSemanticHint(source);
    return hint ? `${source} — ${hint}` : null;
}
