OLD_RANGE_RULE = "When the answer is no for a yes_no criterion (a missed action), you MUST give checked_range with the from and to message indexes where the action was expected; you may also cite evidence."
NEW_RANGE_RULE = (
    "When the answer is no for a yes_no criterion you MUST give checked_range with the from and to message indexes you examined "
    "to conclude that the action was missing, late or done wrong (where the action was expected, or the span of the client's problem "
    "that the operator should have addressed). This applies to every yes_no criterion without exception, including criteria about "
    "tone, politeness or empathy; you may also cite evidence."
)
MARKS_NOTE = (
    "Some transcript lines end with a bracketed note of the form [пауза N с до следующего сообщения], which the system added to show "
    "a long gap in seconds before the next message. It is not part of the message text: never include it in a quote."
)


def build_system_prompt_v2(cfg) -> str:
    from backend.app.services.evaluator import build_system_prompt

    text = build_system_prompt(cfg)
    if OLD_RANGE_RULE not in text:
        raise ValueError("range rule not found in the production system prompt")
    return text.replace(OLD_RANGE_RULE, NEW_RANGE_RULE)


def with_marks_note(system_text: str) -> str:
    return system_text + "\n\n" + MARKS_NOTE


TIEBREAK_RULE = (
    "For scale criteria choose the highest step whose descriptor fully holds for the whole conversation. Choose a lower step only "
    "when you can point to a specific observable event in the transcript (a message index, or a gap between timestamps) that the "
    "lower step's descriptor describes; do not lower the step on general impressions."
)


def v2_rules() -> list[str]:
    from backend.app.services.evaluator import RULES

    return [NEW_RANGE_RULE if r == OLD_RANGE_RULE else r for r in RULES]


def build_system_prompt_tiebreak(cfg) -> str:
    from backend.app.services.evaluator import OUTPUT_FORMAT, render_criterion

    rules = v2_rules()
    rules = rules[:-1] + [TIEBREAK_RULE] + rules[-1:]
    titles = {s.id: s.title for s in cfg.sections}
    parts = [
        "\n".join(f"{i}. {r}" for i, r in enumerate(rules, 1)),
        f"Checklist: {cfg.name}",
        "\n\n".join(render_criterion(c, titles) for c in cfg.criteria),
        OUTPUT_FORMAT,
    ]
    return "\n\n".join(parts)


def build_system_prompt_xml(cfg) -> str:
    import html

    from backend.app.services.evaluator import OUTPUT_FORMAT, render_criterion

    titles = {s.id: s.title for s in cfg.sections}
    rules_text = "\n".join(f"{i}. {r}" for i, r in enumerate(v2_rules(), 1))
    criteria = "\n".join(f'<criterion id="{c.id}">\n{render_criterion(c, titles)}\n</criterion>' for c in cfg.criteria)
    name = html.escape(cfg.name, quote=True)
    return f"<rules>\n{rules_text}\n</rules>\n\n<checklist name=\"{name}\">\n{criteria}\n</checklist>\n\n<output_format>\n{OUTPUT_FORMAT}\n</output_format>"


def build_user_prompt_xml(conv: dict, messages: list[dict]) -> str:
    from backend.app.services.evaluator import transcript_lines

    head = f"channel={conv.get('channel')}, language={conv.get('language')}, messages={len(messages)}"
    return (
        f"<conversation_metadata>{head}</conversation_metadata>\n\n<transcript>\n"
        + "\n".join(transcript_lines(messages))
        + "\n</transcript>\n\n<task>Evaluate every criterion now.</task>"
    )


def build_system_prompt_v1(cfg) -> str:
    from backend.app.services.evaluator import build_system_prompt

    return build_system_prompt(cfg)


def build_user_prompt_v1(conv: dict, messages: list[dict]) -> str:
    from backend.app.services.evaluator import build_user_prompt

    return build_user_prompt(conv, messages)


PROMPTS = {
    "v1": (build_system_prompt_v1, build_user_prompt_v1),
    "v2": (build_system_prompt_v2, build_user_prompt_v1),
    "v3_tiebreak": (build_system_prompt_tiebreak, build_user_prompt_v1),
    "v3_xml": (build_system_prompt_xml, build_user_prompt_xml),
}


def build_system_prompt_xml_tiebreak(cfg) -> str:
    import html

    from backend.app.services.evaluator import OUTPUT_FORMAT, render_criterion

    titles = {s.id: s.title for s in cfg.sections}
    rules = v2_rules()
    rules = rules[:-1] + [TIEBREAK_RULE] + rules[-1:]
    rules_text = "\n".join(f"{i}. {r}" for i, r in enumerate(rules, 1))
    criteria = "\n".join(f'<criterion id="{c.id}">\n{render_criterion(c, titles)}\n</criterion>' for c in cfg.criteria)
    name = html.escape(cfg.name, quote=True)
    return f"<rules>\n{rules_text}\n</rules>\n\n<checklist name=\"{name}\">\n{criteria}\n</checklist>\n\n<output_format>\n{OUTPUT_FORMAT}\n</output_format>"


PROMPTS["v4_xml_tiebreak"] = (build_system_prompt_xml_tiebreak, build_user_prompt_xml)
