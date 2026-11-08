# G-10 shadow run: gpt-6.1-sol medium, prompt v2, through the production evaluator

Script: scripts/shadow_compare.py on a COPY of the database (checklist version id 2, which holds the stored Opus 5.5 evaluations), 10 DEV conversations: p1-ru-022, p1-ru-023, p4-ru-004 (115 turns), p4-ru-005 (voice call), p1-kz-013, p1-en-013, p1-en-001, p1-kz-001, p1-en-002, p1-en-003. The real cqa.db was not opened (size and mtime unchanged). DEV is not ground truth and the Opus rows are not labels.

Acceptance (all PASS): 10 of 10 evaluated, 0 failed, 0 needs_review, 0 repair turns, mean cost $0.0124 (cap $0.02), p95 latency 13.3 s (cap 20 s), gross-violation flag agrees on 10 of 10, median absolute total-score difference 2.26 points (cap 5), no criterion flipping on more than 3 of 10 conversations (maximum 3).

Measured means per conversation: uncached input 1,272 tokens, cache read 1,456, output 974 (reasoning included); p50 latency 10.1 s. Total spend $0.124.

Divergences to read (listed, not resolved): criterion 02 flipped on 3 conversations (p1-ru-023 and p1-kz-013: gpt na, Opus no; p1-kz-001: gpt na, Opus yes), the most frequent difference; criterion 07 flipped on 2 (p4-ru-005 gpt no, Opus yes; p1-en-003 gpt yes, Opus no); criterion 05 on 1 (p1-kz-013 gpt no, Opus yes); criterion 06 on 1 (p1-ru-022 gpt 10, Opus 4, a 11-point total difference); one-step scale differences on criterion 04 in 4 conversations and on 06 in 2. Largest total-score differences: p1-ru-022 11.25, p1-en-013 7.7, p1-en-003 7.69. A gpt na on criterion 02 removes that criterion's weight from the total, which is why those conversations move.
