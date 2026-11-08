from backend.app.services.evaluator import build_system_prompt

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
    text = build_system_prompt(cfg)
    if OLD_RANGE_RULE not in text:
        raise ValueError("range rule not found in the production system prompt")
    return text.replace(OLD_RANGE_RULE, NEW_RANGE_RULE)


def with_marks_note(system_text: str) -> str:
    return system_text + "\n\n" + MARKS_NOTE
