"""Validated contracts for optional writing checks; malformed results never mean pass."""

from typing import Literal

from pydantic import BaseModel, Field


class ReviewResult(BaseModel):
    score: int = Field(ge=0, le=100, strict=True)
    issues: list[str] = Field(max_length=100)
    verdict: Literal["pass", "revise"]


class ReferenceSafetyResult(BaseModel):
    ok: bool = Field(strict=True)
    issues: list[str] = Field(max_length=100)


class RiskResult(BaseModel):
    level: Literal["low", "medium", "high"]
    issues: list[str] = Field(max_length=100)
