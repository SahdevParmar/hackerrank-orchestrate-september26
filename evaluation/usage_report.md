# Usage Report — HackerRank Orchestrate "Buy or Wait?"

## Model providers and names

None. This agent uses a **pure deterministic engine**. No LLM API is called
for any request.

## API calls

- Total calls: **0**
- Per request: **0**

## Token usage

- Input tokens: **0**
- Output tokens: **0**
- Total tokens: **0**
- Average tokens per request: **0**

## Cost

- Estimated total cost: **$0.00**
- Per-request cost: **$0.00**

## Notes on optional offline components

- `code/dataset/ocr.js` uses `tesseract.js`, a **local, offline** OCR library,
  to read the 16 image-linked event amounts (see `dataset/images.csv`). It runs
  once, writes `code/dataset/image_amounts.json`, and is not part of the
  per-request decision path. No network calls, no API keys, no cost.
- Explanations are generated from deterministic templates in
  `code/engine/explain.js`. No LLM is used.

## Determinism

Given the same `dataset/` inputs, the engine produces byte-identical
`output.csv` on every run. There is no randomness, no time-dependent logic
(`Date.now()` is not used in decision paths), and no network dependence.