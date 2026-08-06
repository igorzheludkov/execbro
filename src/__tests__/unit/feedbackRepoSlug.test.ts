import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildGitHubUrl, getGitHubRepo, parseRepoSlug } from "../../core/feedback.js";

const pkg = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"), "utf-8")
);

describe("feedback GitHub repo slug", () => {
    it("is derived from package.json rather than hardcoded to the pre-rename name", () => {
        expect(getGitHubRepo()).toBe("igorzheludkov/execbro");
        expect(getGitHubRepo()).not.toContain("react-native-ai-devtools");
    });

    it("tracks package.json's bugs.url, so a rename cannot desync it", () => {
        expect(pkg.bugs.url).toContain(getGitHubRepo());
        expect(pkg.repository.url).toContain(getGitHubRepo());
    });

    it("parses an issues URL down to owner/repo", () => {
        expect(parseRepoSlug("https://github.com/igorzheludkov/execbro/issues")).toBe("igorzheludkov/execbro");
    });

    it("parses a git+https clone URL down to owner/repo", () => {
        expect(parseRepoSlug("git+https://github.com/igorzheludkov/execbro.git")).toBe("igorzheludkov/execbro");
    });

    it("parses an ssh remote down to owner/repo", () => {
        expect(parseRepoSlug("git@github.com:igorzheludkov/execbro.git")).toBe("igorzheludkov/execbro");
    });

    it("returns undefined for a non-GitHub or missing URL", () => {
        expect(parseRepoSlug(undefined)).toBeUndefined();
        expect(parseRepoSlug("https://gitlab.com/foo/bar")).toBeUndefined();
    });

    it("builds an issue URL against the current repo", () => {
        const url = buildGitHubUrl("Crash on tap", "bug");
        expect(url).toBe("https://github.com/igorzheludkov/execbro/issues/new?title=Crash+on+tap&labels=bug");
    });
});
