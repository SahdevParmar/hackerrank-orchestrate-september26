**Completed Steps**

- **Agent Protocol & Logging:** Configured `log.txt` integration to ensure 100% compliant execution transcript tracking per `AGENTS.md` rules.
- **Step 1 — Data Reader (**`code/parser/csvLoader.js`**):** Built CSV parsing engine with Excel BOM stripping, type safety, map lookups, and context aggregation across all dataset files.
- **Step 2 — FX Converter (**`code/engine/currency.js`**):** Implemented $O(1)$ indexed exchange rate engine with settlement date priority, inverse pair fallbacks, and money rounding.

- **Step 3 — OCR & Message Parsing (**`code/parser/llmExtractor.js`**):** Extract missing transaction amounts from images via LLM vision API and parse `messages.csv` for event cancellations or modifications.
- **Step 4 — Financial Ledger Engine (**`code/engine/ledger.js`**):** Aggregate user starting balances, project recurring salary/expense schedules, and deduplicate linked events.
- **Step 5 — 90-Day Cash Flow Simulator (**`code/engine/simulator.js`**):** Model daily bank balances day-by-day over a 90-day window to enforce `minimum_balance_to_keep` constraints.
- **Step 6 — Decision Tree & Plan Ranker (**`code/engine/optimizer.js`**):** Evaluate Full, Partial, Installment, Wait, and Do Not Buy strategies, applying official tie-breaker rules and flexible expense reductions.
- **Step 7 — Verification Guardrails (**`code/utils/verifier.js`**):** Enforce hard rules on output schema, bounds ($0 \le \text{amountsafe} \le \text{requestedamount}$), valid enums, and exact payment dates.
- **Step 8 — Token & Cost Reporter (**`code/utils/usageReporter.js`**):** Track LLM token usage and generate `evaluation/usage_report.md` automatically.
- **Step 9 — Main Pipeline Orchestrator (**`code/main.js`**):** Connect all modules into a single executable pipeline.
- **Step 10 — Run & Package Submission:** Execute pipeline to generate `output.csv`, verify `log.txt` completeness, and confirm zero-error compliance.

