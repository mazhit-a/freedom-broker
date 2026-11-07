import json
import sys

from backend.app.services.evaluator import build_schema, build_system_prompt
from backend.app.services.checklist import load_seed_config
from backend.app.services.llm_client import LLMClient, LLMError


def main() -> int:
    client = LLMClient()
    cfg = load_seed_config()
    system_text = build_system_prompt(cfg)
    messages = [
        {
            "role": "user",
            "content": "Conversation metadata: channel=agent chat, language=RU, messages=2\n\nTranscript:\n"
            "[#0 | 00:01 | client] Здравствуйте\n[#1 | 00:10 | operator] Здравствуйте, меня зовут Анна\n\nEvaluate every criterion now.",
        }
    ]
    report = {"model": client.model, "effort": client.settings.llm_effort, "provider": client.settings.llm_provider}
    for label in ("first", "second"):
        try:
            res = client.complete(system_text, messages, build_schema(cfg))
        except LLMError as exc:
            report[label] = {"error": str(exc)[:500]}
            break
        try:
            json.loads(res.text)
            valid_json = True
        except ValueError:
            valid_json = False
        report[label] = {
            "structured": res.structured,
            "valid_json": valid_json,
            "stop_reason": res.stop_reason,
            "input": res.input_tokens,
            "output": res.output_tokens,
            "cache_read": res.cache_read_tokens,
            "cache_write": res.cache_write_tokens,
            "latency_ms": res.latency_ms,
            "cost": res.cost,
        }
    report["structured_fallback_reason"] = client.structured_fallback_reason
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if "error" not in report.get("first", {}) else 1


if __name__ == "__main__":
    sys.exit(main())
