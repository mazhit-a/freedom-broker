# Evaluation dataset card

- version: 1
- hash: `8d32af582b63e544d3c7d73784efe058e1406016a4a482d677cbbed35a057adf`
- checklist: `evals/checklist_v2.json`
- cases: 36 (dev 24, holdout 12)
- synthetic conversations; expected results reviewed by one human reviewer

## Review status

| status | cases |
|---|---|
| pending | 0 |
| accepted | 36 |
| edited | 0 |
| rejected | 0 |

## Channel

| value | dev | holdout | all |
|---|---|---|---|
| chat | 12 | 6 | 18 |
| call | 12 | 6 | 18 |

## Language

| value | dev | holdout | all |
|---|---|---|---|
| ru | 12 | 6 | 18 |
| kk | 6 | 2 | 8 |
| en | 3 | 2 | 5 |
| switch | 3 | 2 | 5 |

## Length

| value | dev | holdout | all |
|---|---|---|---|
| short | 8 | 4 | 12 |
| medium | 8 | 4 | 12 |
| long | 8 | 4 | 12 |

## Topic

| value | dev | holdout | all |
|---|---|---|---|
| account_opening_kyc | 3 | 2 | 5 |
| deposit_withdrawal | 4 | 1 | 5 |
| ipo_participation | 2 | 2 | 4 |
| order_execution_complaint | 5 | 0 | 5 |
| tariffs_fees | 4 | 1 | 5 |
| tax_documents | 2 | 4 | 6 |
| trading_platform_failure | 4 | 2 | 6 |

## Hard cases

| hard case | dev | holdout | all |
|---|---|---|---|
| angry_client_with_empathy | 1 | 0 | 1 |
| angry_client_without_empathy | 1 | 0 | 1 |
| bot_greets_no_greeting | 1 | 0 | 1 |
| chat_ends_before_request | 2 | 1 | 3 |
| client_leaves_before_closing | 2 | 1 | 3 |
| confidential_disclosure | 1 | 0 | 1 |
| insult | 1 | 1 | 2 |
| missed_item_long | 1 | 1 | 2 |
| near_miss_rude_no_violation | 1 | 0 | 1 |
| paid_personal_consultation | 1 | 0 | 1 |
| verification_needed_not_confirmed | 1 | 1 | 2 |
| verification_not_needed | 2 | 0 | 2 |
| wait_without_warning | 1 | 1 | 2 |

## Expected answers per criterion

| criterion | answer | dev | holdout | all |
|---|---|---|---|---|
| 01 | yes | 16 | 10 | 26 |
| 01 | no | 8 | 2 | 10 |
| 02 | yes | 8 | 5 | 13 |
| 02 | no | 12 | 4 | 16 |
| 02 | na | 4 | 3 | 7 |
| 03 | yes | 13 | 6 | 19 |
| 03 | no | 4 | 4 | 8 |
| 03 | na | 7 | 2 | 9 |
| 04 | 20 | 5 | 3 | 8 |
| 04 | 15 | 6 | 2 | 8 |
| 04 | 10 | 4 | 4 | 8 |
| 04 | 5 | 5 | 1 | 6 |
| 04 | 0 | 2 | 1 | 3 |
| 04 | na | 2 | 1 | 3 |
| 05 | yes | 14 | 9 | 23 |
| 05 | no | 10 | 3 | 13 |
| 06 | 10 | 13 | 7 | 20 |
| 06 | 7 | 7 | 2 | 9 |
| 06 | 4 | 2 | 3 | 5 |
| 06 | 0 | 2 | 0 | 2 |
| 07 | yes | 15 | 6 | 21 |
| 07 | no | 5 | 4 | 9 |
| 07 | na | 4 | 2 | 6 |
| 08 | yes | 3 | 1 | 4 |
| 08 | no | 21 | 11 | 32 |

## Message counts

| channel | length | cases | min | median | mean | max |
|---|---|---|---|---|---|---|
| agent chat | short | 6 | 6 | 9.0 | 8.7 | 11 |
| agent chat | medium | 6 | 16 | 20.0 | 21.7 | 29 |
| agent chat | long | 6 | 46 | 57.0 | 58.3 | 71 |
| voice call | short | 6 | 6 | 8.0 | 7.8 | 10 |
| voice call | medium | 6 | 17 | 22.0 | 22.2 | 28 |
| voice call | long | 6 | 41 | 56.0 | 55.0 | 71 |

## Speaker mix (share of messages)

| channel | operator | client | bot | system |
|---|---|---|---|---|
| agent chat | 43.0% | 44.4% | 3.4% | 9.2% |
| voice call | 42.5% | 42.0% | 4.1% | 11.4% |
| all | 42.8% | 43.2% | 3.7% | 10.3% |

## Realism check against DEV statistics

No DEV reference statistics were supplied. Pass a JSON file with message_count and speaker_share, as produced by conversation_stats, to fill this table.

## Open flags

none
