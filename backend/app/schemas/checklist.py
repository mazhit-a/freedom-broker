from typing import Literal

from pydantic import BaseModel, Field, model_validator


class ScaleStep(BaseModel):
    value: int = Field(ge=0)
    descriptor: str = ""


class SectionLabel(BaseModel):
    title: str = ""


class CriterionLabel(BaseModel):
    title: str = ""
    na_condition: str | None = None


class Section(BaseModel):
    id: str = Field(min_length=1)
    title: str = ""
    labels: dict[str, SectionLabel] | None = None


class Criterion(BaseModel):
    id: str = Field(min_length=1)
    title: str = ""
    description: str = ""
    section: str | None = None
    weight: float = Field(default=0, ge=0)
    type: Literal["yes_no", "scale", "flag"]
    na_allowed: bool = False
    na_condition: str | None = None
    scale_steps: list[ScaleStep] = Field(default_factory=list)
    max_step: int | None = None
    labels: dict[str, CriterionLabel] | None = None

    @model_validator(mode="after")
    def check_consistency(self):
        if self.type == "flag":
            if self.weight != 0:
                raise ValueError(f"criterion {self.id}: flag criterion must have weight 0")
            if self.na_allowed:
                raise ValueError(f"criterion {self.id}: flag criterion cannot allow N/A")
        if self.type == "scale":
            values = [s.value for s in self.scale_steps]
            if len(set(values)) != len(values):
                raise ValueError(f"criterion {self.id}: duplicate scale step values")
            if values:
                top = max(values)
                if self.max_step is not None and self.max_step != top:
                    raise ValueError(
                        f"criterion {self.id}: max_step {self.max_step} does not match top scale step {top}"
                    )
                self.max_step = top
        elif self.scale_steps:
            raise ValueError(f"criterion {self.id}: scale_steps only allowed for scale type")
        if self.type == "yes_no" and self.max_step is not None:
            raise ValueError(f"criterion {self.id}: max_step only allowed for scale type")
        return self


class ChecklistConfig(BaseModel):
    name: str = Field(min_length=1)
    sections: list[Section] = Field(default_factory=list)
    criteria: list[Criterion] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_unique(self):
        ids = [c.id for c in self.criteria]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ValueError(f"duplicate criterion ids: {', '.join(dupes)}")
        section_ids = [s.id for s in self.sections]
        if len(set(section_ids)) != len(section_ids):
            raise ValueError("duplicate section ids")
        for c in self.criteria:
            if self.sections and c.section not in section_ids:
                raise ValueError(f"criterion {c.id}: unknown section {c.section!r}")
        return self

    def completeness_errors(self) -> list[str]:
        errors = []
        if not self.criteria:
            errors.append("checklist needs at least 1 criterion")
        for s in self.sections:
            if not s.title.strip():
                errors.append(f"section {s.id}: title is required")
        for c in self.criteria:
            if not c.title.strip():
                errors.append(f"criterion {c.id}: title is required")
            if c.na_allowed and not (c.na_condition and c.na_condition.strip()):
                errors.append(f"criterion {c.id}: na_allowed requires a non-empty na_condition")
            if c.type == "scale":
                if len(c.scale_steps) < 2:
                    errors.append(f"criterion {c.id}: scale type requires at least 2 steps")
                elif any(not st.descriptor.strip() for st in c.scale_steps):
                    errors.append(f"criterion {c.id}: scale step descriptors are required")
                elif (c.max_step or 0) <= 0:
                    errors.append(f"criterion {c.id}: top scale step must be positive")
        return errors

    def weight_sum(self) -> float:
        return round(sum(c.weight for c in self.criteria if c.type != "flag"), 6)

    def warnings(self) -> list[str]:
        total = self.weight_sum()
        if abs(total - 100) > 1e-9:
            return [f"weights sum to {total:g}, not 100"]
        return []


class VersionOut(BaseModel):
    id: int
    checklist_id: int
    version: int
    created_at: str
    is_default: bool
    status: Literal["draft", "saved", "active", "archived"] = "saved"
    config: ChecklistConfig
    warnings: list[str]


class VersionSummary(BaseModel):
    id: int
    version: int
    created_at: str
    is_default: bool
    criteria_count: int
    weight_sum: float
    status: Literal["draft", "saved", "active", "archived"] = "saved"
    applied_count: int = 0
    first_applied_at: str | None = None


class ChecklistOut(BaseModel):
    id: int
    name: str
    default_version_id: int | None
    channels: list[str] = Field(default_factory=list)
    versions: list[VersionSummary]


class DefaultIn(BaseModel):
    version_id: int


class ChannelsIn(BaseModel):
    channels: list[str]
