# G-4 holdout run: gpt-6.1-sol medium, prompt v2 (gpt-only)

Run 20261108-035417-gpt_sol_medium-holdout: 12 holdout cases, 1 repeat, live mode. No Opus comparison and no judge were run (the user chose the gpt-only version). Holdout labels are the original dataset labels; criterion 06 holdout labels have not been human-adjudicated and the labels were written by gpt-6.1-sol.

| Check | Threshold | Result |
|---|---|---|
| Errors | 0 | 0 |
| Truncations | 0 | 0 |
| Repair turns | at most 5% | 0 of 12 (0%) |
| Cost per conversation | at most $0.02 | mean $0.0134, max $0.0188 |
| Latency p95 per conversation | at most 20 s | p50 10.2 s, p95 11.9 s, max 12.6 s |
| Evidence quotes grounded | 100% | 156 of 156 |
| Refusals, needs_review | none expected | 0, 0 |
| Accuracy versus Opus | within 2 answers excluding 06 | not measured (no Opus run) |

Accuracy against the original labels: 89 of 96 answers (92.7%). Excluding criterion 06: 82 of 84 (97.6%). Per criterion: 01 12/12, 02 11/12, 03 12/12, 04 11/12, 05 12/12, 06 7/12, 07 12/12, 08 12/12. By channel and length: call/long 16/16, call/medium 14/16, call/short 15/16, chat/long 13/16, chat/medium 16/16, chat/short 15/16.

Misses: criterion 06 in case-005, case-018, case-024, case-029, case-030 (the model's step is lower than the label in all five: 10 to 7, 10 to 4, 10 to 4, 10 to 7, 7 to 4, the same one-sided direction seen on dev), case-018 criterion 02 (label na, model no) and criterion 04 (label 15, model 10).

Verdict against the hard thresholds: GO on the operational checks. The accuracy comparison with Opus was not run, so the plan's "within 2 answers of Opus" condition is unevaluated.
