# OCR Text Extraction

OCR is the last fallback in `tap`'s strategy chain. When the fiber tree and the accessibility tree both fail to find the element, `tap(text="...")` reads the screen with OCR and taps the matching text. There is no standalone OCR tool — OCR runs inside `tap`, not as a separate call.

> **Note:** Many iOS interaction tools (swipe, text input, accessibility queries) require [IDB](https://github.com/facebook/idb). See the [Platform Setup](../README.md#platform-setup) section for installation instructions.

## Why OCR?

| Approach | Pros | Cons |
|----------|------|------|
| Fiber / accessibility tree (`tap`, `get_screen_layout`) | Fast, reliable, low token usage | Only finds elements the tree exposes (testID, text, labels) |
| Screenshot + Vision | Visual layout understanding | High token usage, slow |
| **OCR** (inside `tap`) | Works on ANY visible text, no tree required | Requires text to be visible, may miss small or stylized text |

## Usage

Nothing to call directly — just target the element by its visible text:

```
tap with text="Submit"
```

`tap` tries accessibility, then fiber, then OCR, and reports which strategy won.

## OCR Engine

OCR uses **Google Cloud Vision API** via a cloud proxy for fast, accurate text recognition (~97%+ accuracy, ~0.5s processing time). This works out of the box with no local dependencies.

Screenshots are sent over HTTPS to our cloud endpoint for processing and immediately deleted after recognition — no images are stored.

## Offline Fallback (EasyOCR)

If the cloud endpoint is unreachable (no internet, timeout), OCR falls back to local EasyOCR (Python-based). This requires Python 3.6+:

```bash
# macOS
brew install python@3.11

# Ubuntu/Debian
sudo apt install python3
```

EasyOCR and its Python dependencies are installed automatically by `node-easyocr`. The local fallback is slower (~2-3s) and less accurate (~85-90%) but works offline.

## OCR Language Configuration

Google Cloud Vision automatically detects and recognizes text in most languages without configuration.

For the offline EasyOCR fallback, set `EASYOCR_LANGUAGES` to add language support:

```bash
EASYOCR_LANGUAGES=es,fr
```

## Recommended Workflow

1. **`tap(text=...)`** — runs the whole fallback chain, OCR included
2. **`get_screen_state`** — when you need the element list rather than a single tap
3. **`ios_screenshot` / `android_screenshot`** — for visual debugging or layout verification

```
# Simplest approach — tap handles everything, OCR included
tap with text="Submit"

# If tap still can't find it, look at the screen and tap by coordinate
android_screenshot
tap with x=540 y=1200
```
