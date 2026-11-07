import json
import random
from types import SimpleNamespace

from evals.gen import assemble
from evals.graders import load_checklist
from tests.test_eval_graders import make_case

CFG = load_checklist()
RATIONALE = "Оператор выполнил требование критерия."
QUOTE = "hello there"
USAGE = dict(input_tokens=1000, output_tokens=500, cache_read_input_tokens=2000, cache_creation_input_tokens=0)


def tiny_dataset(n=3):
    cases = [make_case(f"c{i}", violation=(i == 2)) for i in range(1, n + 1)]
    for i, c in enumerate(cases):
        c["split"] = "dev" if i < n - 1 else "holdout"
    return assemble.assemble_dataset(cases)


def good_item(c, answer=None):
    if answer is None:
        answer = {"yes_no": "yes", "scale": str(c.max_step), "flag": "no"}[c.type]
        if c.id == "03":
            answer = "na"
    item = {
        "criterion_id": c.id,
        "answer": str(answer),
        "rationale": RATIONALE,
        "evidence": [] if (answer == "na" or (c.type == "flag" and answer == "no")) else [{"message_index": 0, "quote": QUOTE}],
        "checked_range": None,
        "na_reason": "Проверка личности не требовалась." if answer == "na" else None,
    }
    if answer == "no" and c.type == "yes_no":
        item["checked_range"] = {"from": 0, "to": 2}
    return item


def results_text(ids, extra=None, overrides=None):
    items = []
    for c in CFG.criteria:
        if c.id not in ids:
            continue
        item = good_item(c, (overrides or {}).get(c.id))
        if extra:
            item.update(extra)
        items.append(item)
    return json.dumps({"results": items}, ensure_ascii=False)


def facts_text():
    return json.dumps(
        {
            "events": [{"message_index": 1, "kind": "other", "note": "x"}, {"message_index": 99, "kind": "other", "note": "bad"}],
            "greeting": {"operator_greeted": True, "operator_introduced": False, "message_index": 0, "quote": QUOTE, "bot_greeted_only": False},
            "verification": {"needed": False, "confirmed": False, "message_index": None, "note": "n"},
            "escalation": {"occurred": False, "message_index": None, "operator_first_reply_index": None},
            "offers": [],
            "client_requests": [{"message_index": 1, "summary": "balance"}],
            "closing": {"operator_closed": True, "message_index": 2},
        }
    )


def default_responder(params):
    schema = params["output_config"]["format"]["schema"]
    props = schema["properties"]
    if "events" in props:
        return facts_text()
    item = props["results"]["items"]
    ids = item["properties"]["criterion_id"]["enum"]
    extra = {"disputed": False, "dispute_reason": None} if "disputed" in item["properties"] else None
    return results_text(ids, extra)


def message(text, params, stop="end_turn", usage=None, model=None):
    return SimpleNamespace(
        id="msg",
        type="message",
        role="assistant",
        model=model if model is not None else params["model"] + "-20261001",
        content=[SimpleNamespace(type="text", text=text)],
        stop_reason=stop,
        usage=SimpleNamespace(**(usage or USAGE)),
    )


class FakeAnthropic:
    def __init__(self, responder=default_responder, batch_polls=2, seed=1, entry_override=None):
        self.responder = responder
        self.live_calls = []
        self.batches_created = []
        self.batch_polls = batch_polls
        self.rng = random.Random(seed)
        self.entry_override = entry_override
        self.polls = {}
        self.stored = {}
        self.messages = SimpleNamespace(
            create=self.create,
            batches=SimpleNamespace(create=self.batch_create, retrieve=self.batch_retrieve, results=self.batch_results),
        )

    def build(self, params):
        out = self.responder(params)
        if isinstance(out, Exception):
            raise out
        if isinstance(out, SimpleNamespace):
            return out
        if isinstance(out, tuple):
            text, stop, *rest = out
            return message(text, params, stop, rest[0] if rest else None, rest[1] if len(rest) > 1 else None)
        return message(out, params)

    def create(self, **kwargs):
        self.live_calls.append(kwargs)
        params = {k: v for k, v in kwargs.items() if k != "timeout"}
        return self.build(params)

    def batch_create(self, requests):
        bid = f"batch_{len(self.batches_created) + 1}"
        self.batches_created.append(list(requests))
        entries = []
        for r in requests:
            try:
                msg = self.build(r["params"])
                entry = SimpleNamespace(custom_id=r["custom_id"], result=SimpleNamespace(type="succeeded", message=msg))
            except Exception as exc:
                entry = SimpleNamespace(custom_id=r["custom_id"], result=SimpleNamespace(type="errored", error={"message": str(exc)}))
            if self.entry_override:
                entry = self.entry_override(r, entry) or entry
            entries.append(entry)
        self.rng.shuffle(entries)
        self.stored[bid] = entries
        self.polls[bid] = 0
        return SimpleNamespace(id=bid, processing_status="in_progress")

    def batch_retrieve(self, bid):
        self.polls[bid] += 1
        done = self.polls[bid] > self.batch_polls
        return SimpleNamespace(id=bid, processing_status="ended" if done else "in_progress")

    def batch_results(self, bid):
        return iter(self.stored[bid])


class FakeJev:
    def __init__(self, fail=False, usage=None):
        self.calls = []
        self.fail = fail
        self.usage = usage if usage is not None else {"input_tokens": 3000, "output_tokens": 0, "cost": None}

    def post(self, payload):
        from evals.decisions import DecisionsError

        self.calls.append(payload)
        if self.fail:
            raise DecisionsError("server", "boom", 500, 4)
        answers = {}
        for name, q in payload["questions"].items():
            if q["type"] == "choice":
                answers[name] = {"type": "choice", "choice": "yes", "probabilities": {o: (0.8 if o == "yes" else 0.1) for o in q["criteria"]}}
            elif q["type"] == "score":
                n = len(q["criteria"])
                answers[name] = {"type": "score", "probabilities": {str(i): (0.7 if i == n - 1 else 0.3 / max(n - 1, 1)) for i in range(n)}}
            else:
                answers[name] = {"type": "noul", "noul": 0.1}
        return {"body": {"answers": answers}, "attempts": 1, "latency_ms": 120.0, "usage": self.usage}
