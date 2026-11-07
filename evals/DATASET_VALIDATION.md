# Dataset v1 validation

Dataset: `evals/dataset.json`, version 1, hash `8d32af582b63e544d3c7d73784efe058e1406016a4a482d677cbbed35a057adf`. 36 synthetic cases, 24 dev and 12 holdout, with expected results written by the generator (OpenAI gpt-6.1-sol) and reviewed by one human.

## Round 1: human review

All 36 cases accepted without edits.

## Round 2: blind check by an independent model

Claude Sonnet 5.5 answered every case against checklist v2 without seeing the expected results (Batch API, cost $0.19).

| Criterion | Disagreements of 36 |
|---|---|
| 01, 03, 08 | 0 |
| 05 | 2 |
| 07 | 6 |
| 02 | 10 |
| 04 (scale) | 12 |
| 06 (scale) | 17 |

- 47 of 288 criterion results disagreed (16.3%), across 29 of 36 cases.
- 24 of them were one scale step apart. 23 were yes/no/na flips or scale gaps of two steps or more, across 19 cases.
- The 17 cases with serious disagreements (excluding 007 and 022, whose only serious flag was a 07 reading that contradicts the v2 wording "summarised or offered further help and said goodbye") were re-reviewed by the human reviewer. No expected result was changed. The reviewer's judgement was that the blind model's disagreements were wrong and the original expected results were right.

## What this means for results

- The expected results are the reviewer's judgement. They are not independently verified, and one reviewer is a limitation.
- An independent model agreed on 01, 03 and 08 and disagreed most on 06, 04 and 02. The expected scale steps in particular rest on one reviewer's reading of the v2 descriptors, so 04 and 06 results carry the least confidence.
- The report breaks results down per criterion for this reason.
