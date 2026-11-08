# GPT dev gate: final prompt for gpt-6.1-sol

Model gpt-6.1-sol, reasoning effort medium, Responses API. Data: the 24 synthetic dev cases x 2 repeats (48 rows, 384 criterion answers, 192 case-criterion pairs per repeat comparison).

## Decision rule (in force before the v4_xml_tiebreak run)

Pick `v4_xml_tiebreak` only if it is at least as accurate as `v3_xml` on corrected exact answers (no net loss), shows 0 repair turns and 0 errors, evidence grounding 100%, and per-criterion regressions are not concentrated on one criterion; otherwise pick `v3_xml` (best single change, +4/-0). If neither beats `v2` by more than the repeat-noise (99.5% agreement means about 1 answer of 192), choose `v2`, the smallest change. The choice is recorded as `FINAL_PROMPT` in `evals/GPT_DEV_GATE.md`.

## Definitions

- Corrected reference: criterion 06 uses the human answer from `evals/review/adjudication_06.json` for every case that has a non-null answer there (11 of 12 reviewed cases), and the dataset label (`evals/dataset.json`, `expected[criterion].answer`) everywhere else.
- Original labels: the dataset labels for all criteria.
- Exact accuracy: share of the 384 criterion answers (48 rows x 8 criteria) equal to the reference.
- Per-criterion accuracy: corrected reference, 48 answers per criterion.
- Repeat agreement: criterion answers identical across the two repeats of a case, out of 192 (24 cases x 8 criteria).
- Cost per conversation: mean over the 48 rows of the cost recomputed from recorded usage with `evals/prices.py` (live prices, no batch discount); it equals the recorded run cost.
- Latency: sum of call latencies per row (live mode), p50 and p95 over 48 rows, linear interpolation as in `evals/graders.py`.
- Evidence grounding: share of evidence quotes for which `backend.app.services.evaluator.quote_matches(quote, message_text)` holds for the cited message.
- Judge score: mean of `case_score` over all 48 rows of `judge.json` (workflow score); judged only for v2.

## Results

| Prompt | Run | Exact vs corrected | Exact vs original | Repair turns | Errors | Repeat agreement | Evidence grounded | Cost / conversation | Latency p50 / p95 | Judge score |
|---|---|---|---|---|---|---|---|---|---|---|
| v2 | 20261108-005254-gpt_sol_medium-dev | 351/384 = 91.4% | 359/384 = 93.5% | 0 | 0 | 191/192 = 99.5% | 680/680 = 100% | $0.01244 | 9.69 s / 12.87 s | 9.21 (mean case_score, 48 rows) |
| v3_xml | 20261108-014405-gpt_sol_xml-dev | 355/384 = 92.4% | 360/384 = 93.8% | 0 | 0 | 188/192 = 97.9% | 695/695 = 100% | $0.01247 | 9.93 s / 13.98 s | not judged |
| v3_tiebreak | 20261108-014613-gpt_sol_tiebreak-dev | 354/384 = 92.2% | 360/384 = 93.8% | 0 | 0 | 192/192 = 100% | 701/701 = 100% | $0.01269 | 9.31 s / 12.72 s | not judged |
| v4_xml_tiebreak | NOT RUN (G-3 live run held for user approval) | NOT RUN (G-3 live run held for user approval) | NOT RUN (G-3 live run held for user approval) | NOT RUN (G-3 live run held for user approval) | NOT RUN (G-3 live run held for user approval) | NOT RUN (G-3 live run held for user approval) | NOT RUN (G-3 live run held for user approval) | NOT RUN (G-3 live run held for user approval) | NOT RUN (G-3 live run held for user approval) | NOT RUN (G-3 live run held for user approval) |

### Per-criterion accuracy against the corrected reference (48 answers each)

| Prompt | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 |
|---|---|---|---|---|---|---|---|---|
| v2 | 48/48 | 46/48 | 48/48 | 38/48 | 48/48 | 27/48 | 48/48 | 48/48 |
| v3_xml | 48/48 | 46/48 | 48/48 | 39/48 | 48/48 | 30/48 | 48/48 | 48/48 |
| v3_tiebreak | 48/48 | 46/48 | 48/48 | 38/48 | 48/48 | 30/48 | 48/48 | 48/48 |
| v4_xml_tiebreak | NOT RUN (G-3 live run held for user approval) | | | | | | | | 

Criteria 04, 02 and 07 were never human-adjudicated, and gpt-6.1-sol also wrote the dataset labels and rationales; the judge score lead is inflated by authorship.

FINAL_PROMPT: PENDING

## Commands for the later live step

Run from the repository root. The script is run as a file, not as a module. Dry run first (the default, nothing is sent):

```
.venv/bin/python scripts/eval.py run gpt_sol_xml_tiebreak --split dev --reps 2 --mode live --max-spend 1.5
```

Live run (needs explicit user approval; the ledger and the budget guard apply):

```
.venv/bin/python scripts/eval.py run gpt_sol_xml_tiebreak --split dev --reps 2 --mode live --max-spend 1.5 --execute
```

Then judge the new run id printed by the run (dry run first, then with `--execute`; judge mode is `batch` by default, `--mode live` is also supported):

```
.venv/bin/python scripts/eval.py judge <run_id> --max-spend 1.5
.venv/bin/python scripts/eval.py judge <run_id> --max-spend 1.5 --execute
```

Report and ledger:

```
.venv/bin/python scripts/eval.py report <run_id>
.venv/bin/python scripts/eval.py ledger
```
