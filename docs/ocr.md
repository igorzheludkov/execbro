# OCR Text Extraction

The `ocr_screenshot` tool extracts all visible text from a screenshot with tap-ready coordinates. This is useful when accessibility labels are missing or when you need to find text that isn't exposed in the accessibility tree.

> **Note:** Many iOS interaction tools (swipe, text input, accessibility queries) require [IDB](https://github.com/facebook/idb). See the [Platform Setup](../README.md#platform-setup) section for installation instructions.

## Why OCR?

| Approach | Pros | Cons |
|----------|------|------|
| Accessibility tree (`find_element`) | Fast, reliable, low token usage | Only finds elements with accessibility labels |
| Screenshot + Vision | Visual layout understanding | High token usage, slow |
| **OCR** | Works on ANY visible text, returns tap coordinates | Requires text to be visible, may miss small text |

## Usage

```
ocr_screenshot with platform="ios"
```

Returns all visible text with tap-ready coordinates:

```json
{
  "platform": "ios",
  "engine": "cloud",
  "processingTimeMs": 550,
  "elementCount": 24,
  "elements": [
    { "text": "Settings", "confidence": 95, "tapX": 195, "tapY": 52 },
    { "text": "Login", "confidence": 95, "tapX": 187, "tapY": 420 }
  ]
}
```

Then tap the element:

```
tap with x=187 y=420
```

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

1. **Use unified `tap`** - Handles fallback chain automatically
2. **Fall back to OCR** - When `tap` suggests using coordinates
3. **Use screenshot** - For visual debugging or layout verification

```
# Simplest approach — tap handles everything
tap with text="Submit"

# If tap fails, use OCR to find coordinates
ocr_screenshot with platform="android"

# Then tap using coordinates from OCR result
tap with x=540 y=1200
```
