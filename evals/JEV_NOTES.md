# Jev 1.14 notes (Decisions API, alpha)

Sources
- https://docs.typesafe.ai/models
- https://docs.typesafe.ai/concepts/system-one
- https://openrouter.ai/docs/guides/community/jev.md
- https://openrouter.ai/docs/guides/community/jev-tutorial.md
- https://openrouter.ai/docs/guides/community/multimodal-decisions.md
- https://openrouter.ai/docs/client-sdks/python/components/decisionsresponse.md
- https://dev.to/weirui_chen_48669a172a6be/typesafejev-fails-on-openrouter-chatcompletions-how-to-call-it-and-the-three-response-shapes-4e0f
- https://docs.gumloop.com/api-reference/models/create-decision.md (third party, error codes only)
- Saved page: Downloads/Jev 1.14 - API Pricing & Providers _ OpenRouter.html

Not retrievable (404): the OpenRouter Decisions API reference page, and the cascade and classify-at-scale guides. Error body shape and question-count limits are therefore undocumented to us.

Endpoint and model
- `POST https://openrouter.ai/api/alpha/decisions`, Bearer OpenRouter key. Model id `typesafe/jev-1.14` (alias `~typesafe/jev-latest`). Not available on chat/completions.
- TypeSafe's own endpoint is `POST /v1/systemone`; OpenRouter also exposes `/api/v1/systemone`. We use the Decisions API.
- Price $0.042 per 1M input tokens, output free.

Request
- `state`: string, JSON object, or array of strings and content parts. Text stays as plain strings in the array (not wrapped objects). Images are base64 data URLs (png/jpeg/webp, 256-1568 px per side for Jev). We send an array of three strings (rules, metadata, transcript).
- `questions`: object keyed by our own names, each `{type, instructions, criteria}`.
- Criteria format by type: `noul` is a dict `{"true": text, "false": text}`; `choice` is a dict `{option: description}`; `score` is a list of descriptors ordered low to high.
- Types: noul, choice, score, and (new in 1.14) box for image localisation. We do not use box.

Response
- `{id, model, provider, answers, usage}`. usage is `{input_tokens, output_tokens, cost}` in the tutorial example (SDK docs name it `usage` with inputTokens/outputTokens, so the client accepts both spellings).
- noul: `{type, noul}` is P(yes) in 0..1. No confidence field; the distance from 0.5 is all there is.
- choice: `{type, choice, confidence, probabilities}`. The example lists every option in probabilities, including zeros.
- score: `{type, score, confidence, probabilities, legend}`. `score` is the probability-weighted mean of rubric indices (e.g. 2.38), not 0..1. `probabilities` keys are index strings "0","1",... not labels; `legend` maps index to descriptor. We pick the argmax index and map it back to the step value.

Limits and caveats
- Context: 64k per request and 32k per question by default; 262k only with header `TypeSafe-Danger-Zone-Long-Context: true`, which is slower and less accurate. The OpenRouter page lists 262K. A transcript plus 9 questions is far below 32k.
- Documented per-request question cap: none found.
- Alpha: shapes may change. Jev does not explain; it returns only typed answers.
- Decision APIs on other providers return 400 (bad request), 402 (credits), 422 (refusal, no partial answers), 429 (rate limit). Treated by the client as client/payment/client/rate_limit; only 429, 5xx, timeouts and network errors are retried.
- Data goes to TypeSafe via OpenRouter; TypeSafe states it does not train on requests.

Contradictions
- The saved page says 262K context; TypeSafe docs say 64k/32k by default and 262k only with the long-context header. Trust the TypeSafe docs.

Implementation decisions (evals/decisions.py)
- Question names are `q_<criterion id>`; the N/A companion for scale criteria is `q_<id>__na`.
- Scale answer is returned as the step value string; confidence is the argmax probability. With N/A allowed, N/A wins when its P >= 0.5 (confidence = P); otherwise the step confidence is multiplied by (1 - P(na)).
- Flag and N/A noul: confidence = max(p, 1-p).
- Token usage: the returned `usage.input_tokens` when present; otherwise an estimate of characters / 3 over state plus questions JSON, flagged `estimated: true`.
- A missing or malformed answer raises `DecisionsError(kind="malformed")`; no default answer is ever substituted.
