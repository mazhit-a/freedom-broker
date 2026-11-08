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

## Round 3: blind human adjudication of criterion 06

The human reviewer labelled criterion 06 blind (no labels, model answers or tags shown, shuffled order) for the 12 dev cases where any model disagreed with the dataset label: `evals/review/adjudication_06.json`, scored by `scripts/score_adjudication.py`.

- 11 answered, 1 unsure (case-016).
- The dataset label matched the human on 2 of 11. In 9 of 11 the label differed, and in 8 of those 9 the label was higher than the human's answer (one lower).
- Agreement with the human on the 11: Sonnet medium 6, Opus low + fix05 5, Opus medium 5, Jev default 3, gpt-6.1-sol medium 2.
- The 12 dev cases where all of gpt-6.1-sol, Opus low + fix05 and Opus medium agreed with the label were not adjudicated and keep the dataset label.

Consequence: the 06 labels in dataset v1 run generous relative to the human reviewer, in the direction the Claude models score. Comparisons that reward matching the v1 06 labels favour the model that wrote them (gpt-6.1-sol). A sensitivity analysis with the 9 changed answers as the 06 reference removes gpt-6.1-sol's lead: Opus medium 91.4%, Opus low + fix05 91.1%, gpt-6.1-sol medium 91.4%, Sonnet medium 88.5% exact (original labels: 89.8, 88.8, 93.5, 86.5).

Open: criteria 04, 02 and 07 were flagged by the blind Sonnet check as well and have not been adjudicated by the human. Dataset v1 is unchanged; a v2 with corrected 06 answers has not been frozen.
