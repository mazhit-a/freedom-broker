from dataclasses import dataclass


@dataclass(frozen=True)
class ModelPrice:
    input: float
    output: float
    cache_read: float = 0.0
    cache_write: float = 0.0


PRICES: dict[str, ModelPrice] = {
    "claude-opus-5-5": ModelPrice(4.0, 20.0, 0.2, 5.0),
    "claude-sonnet-5-5": ModelPrice(2.0, 10.0, 0.2, 2.5),
    "claude-haiku-4-5": ModelPrice(1.0, 5.0, 0.1, 1.25),
    "claude-haiku-5-5": ModelPrice(0.10, 0.50, 0.01, 0.125),
    "gpt-6.1-sol": ModelPrice(2.0, 10.0, 0.1, 2.5),
    "typesafe/jev-1.14": ModelPrice(0.042, 0.0, 0.0, 0.0),
}

BATCH_DISCOUNT = 0.5


class UnknownModel(KeyError):
    pass


def price_for(model: str) -> ModelPrice:
    if model in PRICES:
        return PRICES[model]
    matches = [key for key in PRICES if model.startswith(key)]
    if not matches:
        raise UnknownModel(model)
    return PRICES[max(matches, key=len)]


def cost(
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    batch: bool = False,
) -> float:
    p = price_for(model)
    total = (
        input_tokens * p.input
        + output_tokens * p.output
        + cache_read_tokens * p.cache_read
        + cache_write_tokens * p.cache_write
    ) / 1_000_000
    if batch:
        total *= BATCH_DISCOUNT
    return round(total, 6)


def call_cost(call: dict, batch: bool = False) -> float | None:
    try:
        return cost(
            str(call.get("model", "")),
            int(call.get("input_tokens") or 0),
            int(call.get("output_tokens") or 0),
            int(call.get("cache_read_tokens") or 0),
            int(call.get("cache_write_tokens") or 0),
            batch=batch,
        )
    except UnknownModel:
        return None
