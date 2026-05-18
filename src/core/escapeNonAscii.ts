export type EscapeResult = { ok: true; expression: string } | { ok: false; reason: string };

const ASCII_PRINTABLE_MIN = 0x20;
const ASCII_PRINTABLE_MAX = 0x7e;

function isAsciiPrintable(cp: number): boolean {
    return (cp >= ASCII_PRINTABLE_MIN && cp <= ASCII_PRINTABLE_MAX) || cp === 0x09 || cp === 0x0a || cp === 0x0d;
}

function escapeCodePoint(cp: number): string {
    if (cp <= 0xffff) return "\\u" + cp.toString(16).toUpperCase().padStart(4, "0");
    return "\\u{" + cp.toString(16).toUpperCase() + "}";
}

function isIdentStart(ch: string): boolean {
    return /[A-Za-z_$]/.test(ch);
}
function isIdentChar(ch: string): boolean {
    return /[A-Za-z0-9_$]/.test(ch);
}

// Identifier tokens after which a following `/` should be treated as the
// start of a regex literal rather than a division operator.
const REGEX_FOLLOWING_TOKENS = new Set([
    "return", "typeof", "in", "of", "delete", "void", "instanceof",
    "new", "throw", "yield", "await", "case", "do", "else",
]);

/**
 * Walk a JS source string and rewrite non-ASCII-printable code points that
 * occur inside string literals (single quote, double quote, template literal
 * cooked body) to \uXXXX or \u{XXXXX} escape sequences. Code in regular
 * expression bodies, comments, identifiers, and template-literal `${...}`
 * substitution expressions is left untouched.
 *
 * Returns a structured error on unbalanced quotes / unterminated literals.
 */
export function escapeNonAsciiInStringLiterals(src: string): EscapeResult {
    let i = 0;
    const out: string[] = [];

    // Track previous significant token kind so we can disambiguate `/` between
    // regex literal and division operator.
    let prevSig:
        | "op"
        | "ident"
        | "number"
        | "regex"
        | "string"
        | "paren-close"
        | "bracket-close"
        | "brace-close"
        | "none" = "none";
    let prevIdent = "";

    // Stack of brace depths for `${...}` substitution expressions currently
    // open. When we see `${` we push 0. Each `{` inside increments the top,
    // each `}` decrements. When `}` would take the top to -1, we instead pop
    // and resume the surrounding template literal body.
    const tplStack: number[] = [];

    function emit(s: string): void {
        out.push(s);
    }

    function emitCodePoint(cp: number): void {
        if (isAsciiPrintable(cp)) {
            emit(String.fromCodePoint(cp));
        } else {
            emit(escapeCodePoint(cp));
        }
    }

    // Read a quoted string starting at `i` (which points at the opening quote).
    // On success: appends to `out`, advances `i` past closing quote, returns null.
    // On failure: returns { ok: false, reason }.
    function readStringLiteral(quote: string): EscapeResult | null {
        emit(quote);
        i++;
        while (i < src.length) {
            const ch = src[i];
            if (ch === "\\") {
                if (i + 1 >= src.length) {
                    return { ok: false, reason: "unterminated string literal (trailing backslash)" };
                }
                emit(src[i]);
                emit(src[i + 1]);
                i += 2;
                continue;
            }
            if (ch === quote) {
                emit(quote);
                i++;
                return null;
            }
            if (ch === "\n" || ch === "\r") {
                return { ok: false, reason: "unterminated string literal (line break)" };
            }
            const cp = src.codePointAt(i)!;
            emitCodePoint(cp);
            i += cp > 0xffff ? 2 : 1;
        }
        return { ok: false, reason: "unterminated string literal" };
    }

    // Read a template-literal body. On encountering `${`, returns "expr" so
    // caller resumes code scanning; on closing backtick returns "done".
    function readTemplateBody(): EscapeResult | "expr" | "done" {
        while (i < src.length) {
            const ch = src[i];
            if (ch === "\\") {
                if (i + 1 >= src.length) {
                    return { ok: false, reason: "unterminated template literal (trailing backslash)" };
                }
                emit(src[i]);
                emit(src[i + 1]);
                i += 2;
                continue;
            }
            if (ch === "`") {
                emit("`");
                i++;
                return "done";
            }
            if (ch === "$" && src[i + 1] === "{") {
                emit("${");
                i += 2;
                tplStack.push(0);
                return "expr";
            }
            const cp = src.codePointAt(i)!;
            emitCodePoint(cp);
            i += cp > 0xffff ? 2 : 1;
        }
        return { ok: false, reason: "unterminated template literal" };
    }

    function readLineComment(): void {
        while (i < src.length && src[i] !== "\n") {
            emit(src[i]);
            i++;
        }
        if (i < src.length) {
            emit(src[i]);
            i++;
        }
    }

    function readBlockComment(): EscapeResult | null {
        emit("/*");
        i += 2;
        while (i < src.length) {
            if (src[i] === "*" && src[i + 1] === "/") {
                emit("*/");
                i += 2;
                return null;
            }
            emit(src[i]);
            i++;
        }
        return { ok: false, reason: "unterminated block comment" };
    }

    function readRegexLiteral(): EscapeResult | null {
        emit("/");
        i++;
        let inClass = false;
        while (i < src.length) {
            const ch = src[i];
            if (ch === "\\") {
                if (i + 1 >= src.length) {
                    return { ok: false, reason: "unterminated regex literal" };
                }
                emit(src[i]);
                emit(src[i + 1]);
                i += 2;
                continue;
            }
            if (ch === "[") inClass = true;
            else if (ch === "]") inClass = false;

            if (ch === "/" && !inClass) {
                emit("/");
                i++;
                while (i < src.length && /[a-zA-Z]/.test(src[i])) {
                    emit(src[i]);
                    i++;
                }
                return null;
            }
            emit(src[i]);
            i++;
        }
        return { ok: false, reason: "unterminated regex literal" };
    }

    // Helper: after we've just emitted a template-literal token (opened with `,
    // or resumed from }), drive readTemplateBody and handle nested ${ ... }
    // expressions iteratively. Returns null on success (template fully closed
    // or we re-entered code via ${), or an error result.
    function enterTemplate(): EscapeResult | null {
        const r = readTemplateBody();
        if (typeof r === "object") return r; // error
        // r is "expr" → tplStack pushed, caller loop will scan code until matching }
        // r is "done" → template literal closed
        return null;
    }

    while (i < src.length) {
        const ch = src[i];

        // Whitespace
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            emit(ch);
            i++;
            continue;
        }

        // Comments
        if (ch === "/" && src[i + 1] === "/") {
            readLineComment();
            continue;
        }
        if (ch === "/" && src[i + 1] === "*") {
            const e = readBlockComment();
            if (e) return e;
            continue;
        }

        // String literals
        if (ch === "'" || ch === '"') {
            const e = readStringLiteral(ch);
            if (e) return e;
            prevSig = "string";
            prevIdent = "";
            continue;
        }

        // Template literal start
        if (ch === "`") {
            emit("`");
            i++;
            const e = enterTemplate();
            if (e) return e;
            // If tplStack pushed, we are now inside ${...} (code context).
            // Otherwise the template closed; treat as string-like token.
            if (tplStack.length === 0) {
                prevSig = "string";
                prevIdent = "";
            } else {
                // Reset prevSig at start of expression context.
                prevSig = "op";
                prevIdent = "";
            }
            continue;
        }

        // Inside a ${...} expression — watch for the matching closing `}`.
        if (tplStack.length > 0) {
            if (ch === "{") {
                tplStack[tplStack.length - 1]++;
                emit("{");
                i++;
                prevSig = "op";
                prevIdent = "";
                continue;
            }
            if (ch === "}") {
                if (tplStack[tplStack.length - 1] === 0) {
                    // End of substitution expression — resume template body.
                    tplStack.pop();
                    emit("}");
                    i++;
                    const e = enterTemplate();
                    if (e) return e;
                    if (tplStack.length === 0) {
                        prevSig = "string";
                        prevIdent = "";
                    }
                    continue;
                }
                tplStack[tplStack.length - 1]--;
                emit("}");
                i++;
                prevSig = "brace-close";
                prevIdent = "";
                continue;
            }
        }

        // Regex literal vs division
        if (ch === "/") {
            const isRegex =
                prevSig === "op" ||
                prevSig === "none" ||
                (prevSig === "ident" && REGEX_FOLLOWING_TOKENS.has(prevIdent));
            if (isRegex) {
                const e = readRegexLiteral();
                if (e) return e;
                prevSig = "regex";
                prevIdent = "";
                continue;
            }
            emit("/");
            i++;
            prevSig = "op";
            prevIdent = "";
            continue;
        }

        // Identifier
        if (isIdentStart(ch)) {
            let j = i;
            while (j < src.length && isIdentChar(src[j])) j++;
            const ident = src.slice(i, j);
            emit(ident);
            i = j;
            prevSig = "ident";
            prevIdent = ident;
            continue;
        }

        // Number
        if (/[0-9]/.test(ch)) {
            while (i < src.length && /[0-9._a-fA-FxXeE]/.test(src[i])) {
                emit(src[i]);
                i++;
            }
            prevSig = "number";
            prevIdent = "";
            continue;
        }

        // Punctuation and operators
        if (
            ch === "(" || ch === "[" || ch === "{" || ch === "," || ch === ";" ||
            ch === ":" || ch === "?" || ch === "=" || ch === "!" || ch === "<" ||
            ch === ">" || ch === "+" || ch === "-" || ch === "*" || ch === "%" ||
            ch === "&" || ch === "|" || ch === "^" || ch === "~" || ch === "."
        ) {
            emit(ch);
            i++;
            prevSig = "op";
            prevIdent = "";
            continue;
        }
        if (ch === ")") {
            emit(ch);
            i++;
            prevSig = "paren-close";
            prevIdent = "";
            continue;
        }
        if (ch === "]") {
            emit(ch);
            i++;
            prevSig = "bracket-close";
            prevIdent = "";
            continue;
        }
        if (ch === "}") {
            emit(ch);
            i++;
            prevSig = "brace-close";
            prevIdent = "";
            continue;
        }

        // Anything else (non-ASCII in code position) — emit verbatim.
        const cp = src.codePointAt(i)!;
        emit(String.fromCodePoint(cp));
        i += cp > 0xffff ? 2 : 1;
        prevSig = "ident";
        prevIdent = "";
    }

    if (tplStack.length > 0) {
        return { ok: false, reason: "unterminated template literal" };
    }
    return { ok: true, expression: out.join("") };
}
