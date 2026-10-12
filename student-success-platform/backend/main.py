"""Smart Campus Analytics API. See README.md for the stable JSON contract."""

from __future__ import annotations

import io
import logging
import math
import os
import uuid
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


INDICATORS = {
    "cgpa": ("CGPA", "Academic", 0.45, 0, 10, False),
    "internal_marks": ("Internal marks %", "Academic", 0.35, 0, 100, False),
    "backlogs": ("Backlogs", "Academic", 0.20, 0, 6, True),
    "attendance": ("Attendance %", "Attendance", 1.00, 0, 100, False),
    "lms_logins_per_week": ("LMS logins / week", "LMS", 0.40, 0, 15, False),
    "assignment_completion": ("Assignment completion %", "LMS", 0.60, 0, 100, False),
    "events": ("Events attended", "Engagement", 0.25, 0, 12, False),
    "clubs": ("Clubs joined", "Engagement", 0.15, 0, 4, False),
    "hackathons": ("Hackathons", "Engagement", 0.30, 0, 5, False),
    "certifications": ("Certifications", "Engagement", 0.30, 0, 8, False),
    "aptitude": ("Aptitude score", "Placement", 0.30, 0, 100, False),
    "coding": ("Coding score", "Placement", 0.40, 0, 100, False),
    "mock_interview": ("Mock interview score", "Placement", 0.30, 0, 100, False),
    "tech_skill": ("Technical skill", "Skills", 0.60, 0, 100, False),
    "soft_skill": ("Soft skill", "Skills", 0.40, 0, 100, False),
    "student_satisfaction": ("Student satisfaction (1-5)", "Feedback", 0.50, 1, 5, False),
    "faculty_feedback": ("Faculty feedback (1-5)", "Feedback", 0.50, 1, 5, False),
}
PILLARS = ["Academic", "Attendance", "LMS", "Engagement", "Placement", "Skills", "Feedback"]
DEFAULT_WEIGHTS = {
    "Academic": 30,
    "Attendance": 15,
    "LMS": 12,
    "Engagement": 8,
    "Placement": 22,
    "Skills": 8,
    "Feedback": 5,
}
SEGMENT_ACTIONS = {
    "Star Performers": "Stretch projects, advanced recruiter exposure, and peer-mentor roles.",
    "Academic Strong, Placement Gap": "Coding bootcamp, aptitude drills, and mock interviews.",
    "Practical Achievers": "Academic tutoring and a backlog plan that build on practical strengths.",
    "Needs Holistic Support": "Assign a mentor and coordinate attendance, academic, and skills support.",
}
PILLAR_ACTIONS = {
    "Academic": "Remedial classes or peer tutoring and a backlog-clearing plan.",
    "Attendance": "Mentor meeting and attendance recovery plan; alert guardian if below 65%.",
    "LMS": "Nudge on pending assignments, LMS onboarding, and weekly check-ins.",
    "Engagement": "Invite to a club, hackathon team, or technical event.",
    "Placement": "Coding and aptitude drills, mock interviews, and placement-cell mentoring.",
    "Skills": "Skill certification track and communication workshop.",
    "Feedback": "Counselling check-in and qualitative feedback on teaching and campus life.",
}
REQUIRED_COLUMNS = ["student_id", "department", "year", *INDICATORS]
NUMERIC_COLUMNS = ["year", *INDICATORS]
SYNTHETIC_DATASET_ID = "synthetic"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_UPLOAD_ROWS = 10_000


@dataclass
class Dataset:
    raw: pd.DataFrame
    scored: pd.DataFrame
    indicator_gaps: pd.DataFrame
    pillar_scores: pd.DataFrame
    trends: pd.DataFrame | None


def make_synthetic_data(count: int = 600, seed: int = 7) -> tuple[pd.DataFrame, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    ability = rng.normal(0, 1, count)
    engagement = rng.normal(0, 1, count)
    preparation = 0.25 * ability + rng.normal(0, 1, count)
    noise = lambda scale=1: rng.normal(0, scale, count)
    clip = np.clip
    raw = pd.DataFrame(
        {
            "student_id": [f"S{index:04d}" for index in range(1, count + 1)],
            "student_name": [f"Student {index:04d}" for index in range(1, count + 1)],
            "department": rng.choice(
                ["CSE", "ECE", "EEE", "MECH", "CIVIL", "IT"],
                count,
                p=[0.28, 0.17, 0.12, 0.13, 0.12, 0.18],
            ),
            "year": rng.choice([1, 2, 3, 4], count),
            "cgpa": clip(6.8 + 0.9 * ability + 0.3 * engagement + noise(0.4), 4, 10),
            "internal_marks": clip(62 + 10 * ability + 3 * engagement + noise(6), 20, 100),
            "backlogs": clip(rng.poisson(np.maximum(0.05, 1.1 - 0.8 * ability)), 0, 6),
            "attendance": clip(78 + 8 * engagement + 3 * ability + noise(7), 40, 100),
            "lms_logins_per_week": clip(rng.poisson(np.maximum(0.5, 5 + 3 * engagement)), 0, 15),
            "assignment_completion": clip(70 + 14 * engagement + 4 * ability + noise(10), 0, 100),
            "events": clip(rng.poisson(np.maximum(0.2, 3 + 2 * engagement)), 0, 12),
            "clubs": clip(rng.poisson(np.maximum(0.1, 1 + 0.5 * engagement)), 0, 4),
            "hackathons": clip(rng.poisson(np.maximum(0.1, 1 + 0.8 * engagement + 0.3 * preparation)), 0, 5),
            "certifications": clip(rng.poisson(np.maximum(0.1, 2 + 1.2 * preparation + 0.3 * engagement)), 0, 8),
            "aptitude": clip(55 + 8 * ability + 12 * preparation + noise(8), 10, 100),
            "coding": clip(48 + 5 * ability + 16 * preparation + noise(9), 5, 100),
            "mock_interview": clip(52 + 4 * ability + 10 * preparation + 4 * engagement + noise(8), 10, 100),
            "tech_skill": clip(55 + 5 * ability + 14 * preparation + noise(8), 10, 100),
            "soft_skill": clip(58 + 8 * engagement + 6 * preparation + noise(8), 10, 100),
            "student_satisfaction": clip(3.5 + 0.4 * engagement + noise(0.5), 1, 5),
            "faculty_feedback": clip(3.4 + 0.4 * ability + 0.3 * engagement + noise(0.5), 1, 5),
        }
    ).round(2)

    months = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov"]
    slope = rng.normal(0.4 * engagement, 1.4)
    trend_rows = []
    for month_index, month in enumerate(months):
        trend_rows.append(
            pd.DataFrame(
                {
                    "student_id": raw.student_id,
                    "month": month,
                    "attendance": clip(
                        raw.attendance + slope * (month_index - 2.5) + rng.normal(0, 2, count), 30, 100
                    ),
                    "lms_logins": clip(
                        raw.lms_logins_per_week
                        + 0.3 * slope * (month_index - 2.5)
                        + rng.normal(0, 1, count),
                        0,
                        20,
                    ),
                }
            )
        )
    return raw, pd.concat(trend_rows, ignore_index=True)


def score_data(raw: pd.DataFrame, trends: pd.DataFrame | None = None) -> Dataset:
    weights = pd.Series(DEFAULT_WEIGHTS, dtype=float)
    weights /= weights.sum()
    normalized = pd.DataFrame(index=raw.index)
    for key, (_, _, _, lower, upper, inverted) in INDICATORS.items():
        values = ((raw[key] - lower) / (upper - lower)).clip(0, 1)
        normalized[key] = 1 - values if inverted else values

    pillars = pd.DataFrame(
        {
            pillar: sum(
                INDICATORS[key][2] * normalized[key]
                for key in INDICATORS
                if INDICATORS[key][1] == pillar
            )
            * 100
            for pillar in PILLARS
        },
        index=raw.index,
    )
    gaps = pd.DataFrame(
        {
            key: normalized[key] * INDICATORS[key][2] * weights[INDICATORS[key][1]] * 100
            for key in INDICATORS
        },
        index=raw.index,
    )

    def index_score(pillar_names: list[str]) -> pd.Series:
        pillar_weights = weights[pillar_names]
        return (pillars[pillar_names] * pillar_weights).sum(axis=1) / max(pillar_weights.sum(), 1e-9)

    scored = raw.copy()
    scored["success_score"] = (pillars * weights[PILLARS]).sum(axis=1).round(1)
    scored["academic_index"] = index_score(["Academic", "Attendance", "LMS"]).round(1)
    scored["placement_index"] = index_score(["Placement", "Skills", "Engagement"]).round(1)
    for pillar in PILLARS:
        scored[f"P_{pillar}"] = pillars[pillar].round(1)

    academic_reasons = []
    placement_reasons = []
    for row in scored.itertuples(index=False):
        academic = []
        placement = []
        if row.attendance < 70:
            academic.append(f"attendance {row.attendance:.0f}%")
        if row.cgpa < 5.5:
            academic.append(f"CGPA {row.cgpa:.1f}")
        if row.backlogs >= 3:
            academic.append(f"{int(row.backlogs)} backlogs")
        if row.assignment_completion < 45:
            academic.append(f"assignments {row.assignment_completion:.0f}%")
        if row.academic_index < 45:
            academic.append(f"academic index {row.academic_index:.0f}")
        if row.placement_index < 35:
            placement.append(f"placement index {row.placement_index:.0f}")
        if row.coding < 30:
            placement.append(f"coding {row.coding:.0f}")
        if row.aptitude < 35:
            placement.append(f"aptitude {row.aptitude:.0f}")
        if row.mock_interview < 35:
            placement.append(f"mock interview {row.mock_interview:.0f}")
        academic_reasons.append("; ".join(academic))
        placement_reasons.append("; ".join(placement))

    scored["academic_risk_reasons"] = academic_reasons
    scored["placement_risk_reasons"] = placement_reasons
    scored["academic_risk"] = scored.academic_risk_reasons.ne("")
    scored["placement_risk"] = scored.placement_risk_reasons.ne("")
    both = scored.academic_risk & scored.placement_risk
    either = scored.academic_risk | scored.placement_risk
    scored["risk_level"] = np.where(
        both | (scored.success_score < 40), "High", np.where(either, "Medium", "Low")
    )
    academic_cut = scored.academic_index.median()
    placement_cut = scored.placement_index.median()
    high_academic = scored.academic_index >= academic_cut
    high_placement = scored.placement_index >= placement_cut
    scored["segment"] = np.select(
        [high_academic & high_placement, high_academic & ~high_placement, ~high_academic & high_placement],
        ["Star Performers", "Academic Strong, Placement Gap", "Practical Achievers"],
        default="Needs Holistic Support",
    )
    pillar_gaps = pd.DataFrame(
        {pillar: gaps[[key for key in INDICATORS if INDICATORS[key][1] == pillar]].sum(axis=1) for pillar in PILLARS},
        index=raw.index,
    )
    return Dataset(raw=raw, scored=scored, indicator_gaps=gaps, pillar_scores=pillars, trends=trends)


def json_value(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value) if math.isfinite(float(value)) else None
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if pd.isna(value):
        return None
    return value


def serialize_row(row: pd.Series) -> dict[str, Any]:
    return {str(key): json_value(value) for key, value in row.items()}


def validate_upload(content: bytes) -> pd.DataFrame:
    try:
        raw = pd.read_csv(io.BytesIO(content), dtype={"student_id": "string"})
    except Exception as exc:
        raise HTTPException(status_code=422, detail={"message": "CSV could not be parsed", "issues": [str(exc)]})
    if raw.empty:
        raise HTTPException(status_code=422, detail={"message": "CSV has no student rows", "issues": []})
    if len(raw) > MAX_UPLOAD_ROWS:
        raise HTTPException(
            status_code=422,
            detail={"message": f"CSV exceeds the {MAX_UPLOAD_ROWS}-row limit", "issues": []},
        )

    issues = [f"Missing required column: {column}" for column in REQUIRED_COLUMNS if column not in raw.columns]
    if issues:
        raise HTTPException(status_code=422, detail={"message": "CSV is missing required columns", "issues": issues})

    ids = raw.student_id.astype("string").str.strip()
    if ids.isna().any() or ids.eq("").any():
        issues.append("student_id must be present and non-empty for every row")
    if ids.duplicated().any():
        duplicate_ids = ids[ids.duplicated(keep=False)].dropna().unique().tolist()
        issues.append(f"student_id values must be unique; duplicates: {', '.join(duplicate_ids[:10])}")
    raw["student_id"] = ids

    departments = raw.department.astype("string").str.strip()
    if departments.isna().any() or departments.eq("").any():
        issues.append("department must be present and non-empty for every row")
    raw["department"] = departments
    if "student_name" in raw.columns:
        raw["student_name"] = raw.student_name.fillna("").astype(str).str.strip()
    else:
        raw["student_name"] = ""

    for column in NUMERIC_COLUMNS:
        values = pd.to_numeric(raw[column], errors="coerce")
        invalid = values.isna() | ~np.isfinite(values)
        if invalid.any():
            issues.append(f"{column} must contain finite numeric values (rows: {', '.join(map(str, (raw.index[invalid] + 2).tolist()[:10]))})")
            continue
        raw[column] = values
        if column == "year":
            invalid_year = (values < 1) | (values > 4) | (values % 1 != 0)
            if invalid_year.any():
                issues.append("year must be a whole number from 1 to 4")
        else:
            _, _, _, minimum, maximum, _ = INDICATORS[column]
            outside = (values < minimum) | (values > maximum)
            if outside.any():
                issues.append(f"{column} must be between {minimum} and {maximum}")
            if column in {"backlogs", "lms_logins_per_week", "events", "clubs", "hackathons", "certifications"}:
                if (values % 1 != 0).any():
                    issues.append(f"{column} must contain whole numbers")
    if issues:
        raise HTTPException(status_code=422, detail={"message": "CSV validation failed", "issues": issues})
    raw["year"] = raw.year.astype(int)
    return raw.reset_index(drop=True)


class DatasetStore:
    def __init__(self) -> None:
        raw, trends = make_synthetic_data()
        self._datasets = {SYNTHETIC_DATASET_ID: score_data(raw, trends)}

    def add(self, raw: pd.DataFrame) -> str:
        dataset_id = str(uuid.uuid4())
        self._datasets[dataset_id] = score_data(raw)
        return dataset_id

    def get(self, dataset_id: str | None) -> Dataset:
        key = dataset_id or SYNTHETIC_DATASET_ID
        if key not in self._datasets:
            raise HTTPException(status_code=404, detail=f"Unknown dataset_id: {key}")
        return self._datasets[key]


store = DatasetStore()
app = FastAPI(title="Smart Campus Analytics API", version="1.0.0")
origins = [origin.strip() for origin in os.getenv("FRONTEND_ORIGIN", "*").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.exception_handler(HTTPException)
async def http_error_handler(_, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict):
        error = {"code": "request_error", **detail}
    else:
        error = {"code": "request_error", "message": str(detail)}
    return JSONResponse(status_code=exc.status_code, content={"error": error}, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(_, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"error": {"code": "validation_error", "message": "Request validation failed", "issues": exc.errors()}},
    )


@app.exception_handler(Exception)
async def unexpected_error_handler(_, exc: Exception) -> JSONResponse:
    logging.getLogger(__name__).exception("Unhandled API error", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "internal_error", "message": "An unexpected error occurred"}},
    )


def filtered_data(
    dataset: Dataset,
    departments: list[str] | None,
    years: list[int] | None,
    risks: list[str] | None,
    segments: list[str] | None,
) -> pd.DataFrame:
    data = dataset.scored
    mask = pd.Series(True, index=data.index)
    if departments:
        mask &= data.department.isin(departments)
    if years:
        mask &= data.year.isin(years)
    if risks:
        invalid = set(risks) - {"High", "Medium", "Low"}
        if invalid:
            raise HTTPException(status_code=422, detail=f"Unsupported risk level(s): {', '.join(sorted(invalid))}")
        mask &= data.risk_level.isin(risks)
    if segments:
        invalid = set(segments) - set(SEGMENT_ACTIONS)
        if invalid:
            raise HTTPException(status_code=422, detail=f"Unsupported segment(s): {', '.join(sorted(invalid))}")
        mask &= data.segment.isin(segments)
    return data[mask]


def query_filters(
    department: list[str] | None,
    year: list[int] | None,
    risk: list[str] | None,
    segment: list[str] | None,
) -> tuple[list[str] | None, list[int] | None, list[str] | None, list[str] | None]:
    return department, year, risk, segment


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "smart-campus-analytics-api"}


@app.get("/filters")
def get_filters(dataset_id: str | None = None) -> dict[str, Any]:
    data = store.get(dataset_id).scored
    return {
        "dataset_id": dataset_id or SYNTHETIC_DATASET_ID,
        "departments": sorted(data.department.unique().tolist()),
        "years": sorted(int(value) for value in data.year.unique()),
        "risks": ["High", "Medium", "Low"],
        "segments": list(SEGMENT_ACTIONS),
    }


@app.get("/overview")
def overview(
    dataset_id: str | None = None,
    department: list[str] | None = Query(default=None),
    year: list[int] | None = Query(default=None),
    risk: list[str] | None = Query(default=None),
    segment: list[str] | None = Query(default=None),
) -> dict[str, Any]:
    dataset = store.get(dataset_id)
    selected = filtered_data(dataset, *query_filters(department, year, risk, segment))
    count = len(selected)
    return {
        "dataset_id": dataset_id or SYNTHETIC_DATASET_ID,
        "filters": {"department": department or [], "year": year or [], "risk": risk or [], "segment": segment or []},
        "students": count,
        "average_success_score": round(float(selected.success_score.mean()), 1) if count else None,
        "high_risk_rate": round(float(selected.risk_level.eq("High").mean()), 4) if count else None,
        "academic_risk_rate": round(float(selected.academic_risk.mean()), 4) if count else None,
        "placement_risk_rate": round(float(selected.placement_risk.mean()), 4) if count else None,
        "risk_counts": {level: int((selected.risk_level == level).sum()) for level in ["High", "Medium", "Low"]},
        "segment_counts": {
            name: int((filtered_data(dataset, department, year, risk, None).segment == name).sum())
            for name in SEGMENT_ACTIONS
        },
        "department_counts": {str(name): int(value) for name, value in selected.department.value_counts().sort_index().items()},
        "department_stats": [
            {
                "name": str(name),
                "students": int(len(group)),
                "avg_success_score": round(float(group.success_score.mean()), 1),
                "high_risk_count": int(group.risk_level.eq("High").sum()),
            }
            for name, group in selected.groupby("department", sort=True)
        ],
        "distribution": [
            {
                "bucket": label,
                "count": int(((selected.success_score >= lower) & (selected.success_score < upper)).sum())
                if upper < 101
                else int(((selected.success_score >= lower) & (selected.success_score <= upper)).sum()),
            }
            for label, lower, upper in [
                ("0-19", 0, 20), ("20-39", 20, 40), ("40-59", 40, 60),
                ("60-79", 60, 80), ("80-100", 80, 100),
            ]
        ],
        "average_pillars": {
            pillar: round(float(selected[f"P_{pillar}"].mean()), 1) if count else None for pillar in PILLARS
        },
    }


@app.get("/trends")
def trends(
    dataset_id: str | None = None,
    department: list[str] | None = Query(default=None),
    year: list[int] | None = Query(default=None),
    risk: list[str] | None = Query(default=None),
    segment: list[str] | None = Query(default=None),
) -> dict[str, Any]:
    dataset = store.get(dataset_id)
    selected = filtered_data(dataset, *query_filters(department, year, risk, segment))
    if dataset.trends is None:
        return {
            "dataset_id": dataset_id or SYNTHETIC_DATASET_ID,
            "available": False,
            "message": "Uploaded CSV files do not contain monthly history; trends are available for synthetic data only.",
            "items": [],
        }
    trend_rows = dataset.trends[dataset.trends.student_id.isin(selected.student_id)].merge(
        selected[["student_id", "risk_level"]], on="student_id", how="inner"
    )
    grouped = trend_rows.groupby("month", sort=False)[["attendance", "lms_logins"]].mean().reset_index()
    items = [
        {
            "month": row.month,
            "attendance": round(float(row.attendance), 1),
            "lms_logins": round(float(row.lms_logins), 1),
        }
        for row in grouped.itertuples(index=False)
    ]
    return {"dataset_id": dataset_id or SYNTHETIC_DATASET_ID, "available": True, "items": items}


@app.get("/students")
def list_students(
    dataset_id: str | None = None,
    q: str | None = None,
    department: list[str] | None = Query(default=None),
    year: list[int] | None = Query(default=None),
    risk: list[str] | None = Query(default=None),
    segment: list[str] | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
) -> dict[str, Any]:
    dataset = store.get(dataset_id)
    selected = filtered_data(dataset, *query_filters(department, year, risk, segment))
    if q and q.strip():
        needle = q.strip().casefold()
        mask = selected.student_id.astype(str).str.casefold().str.contains(needle, regex=False)
        mask |= selected.student_name.astype(str).str.casefold().str.contains(needle, regex=False)
        mask |= selected.department.astype(str).str.casefold().str.contains(needle, regex=False)
        selected = selected[mask]
    selected = selected.sort_values(["success_score", "student_id"], ascending=[True, True])
    start = (page - 1) * page_size
    fields = [
        "student_id", "student_name", "department", "year", "success_score", "academic_index",
        "placement_index", "risk_level", "academic_risk", "placement_risk", "segment",
        "academic_risk_reasons", "placement_risk_reasons",
    ]
    return {
        "dataset_id": dataset_id or SYNTHETIC_DATASET_ID,
        "items": [serialize_row(row) for _, row in selected.iloc[start : start + page_size][fields].iterrows()],
        "total": len(selected),
        "page": page,
        "page_size": page_size,
    }


def student_profile(dataset: Dataset, student_id: str) -> dict[str, Any]:
    matches = dataset.scored[dataset.scored.student_id.astype(str) == student_id]
    if matches.empty:
        raise HTTPException(status_code=404, detail=f"Student not found: {student_id}")
    index = matches.index[0]
    row = dataset.scored.loc[index]
    cohort = dataset.scored
    indicator_means = dataset.indicator_gaps.mean()
    indicators = []
    for key, (label, pillar, share, minimum, maximum, inverted) in INDICATORS.items():
        norm_value = (float(row[key]) - minimum) / (maximum - minimum)
        if inverted:
            norm_value = 1 - norm_value
        effective_weight = share * DEFAULT_WEIGHTS[pillar] / sum(DEFAULT_WEIGHTS.values()) * 100
        contribution = float(dataset.indicator_gaps.loc[index, key])
        indicators.append(
            {
                "key": key,
                "label": label,
                "pillar": pillar,
                "value": json_value(row[key]),
                "normalized": round(float(np.clip(norm_value, 0, 1)), 4),
                "effective_weight_percent": round(effective_weight, 3),
                "score_contribution": round(contribution, 3),
                "cohort_average_contribution": round(float(indicator_means[key]), 3),
                "cohort_gap_points": round(contribution - float(indicator_means[key]), 3),
            }
        )
    pillar_details = []
    for pillar in PILLARS:
        pillar_contribution = float(dataset.pillar_scores.loc[index, pillar]) * DEFAULT_WEIGHTS[pillar] / 100
        cohort_pillar = float(cohort[f"P_{pillar}"].mean())
        pillar_details.append(
            {
                "name": pillar,
                "score": json_value(row[f"P_{pillar}"]),
                "cohort_average": round(cohort_pillar, 1),
                "cohort_gap_points": round(pillar_contribution - cohort_pillar * DEFAULT_WEIGHTS[pillar] / 100, 3),
                "suggested_intervention": PILLAR_ACTIONS[pillar],
            }
        )
    weakest = sorted(pillar_details, key=lambda item: item["cohort_gap_points"])[:2]
    academic_reasons = row.academic_risk_reasons
    placement_reasons = row.placement_risk_reasons
    reasons = []
    if academic_reasons:
        reasons.append({"type": "academic", "text": academic_reasons})
    if placement_reasons:
        reasons.append({"type": "placement", "text": placement_reasons})
    if not reasons and row.success_score < 40:
        reasons.append({"type": "score", "text": "Success Score is below 40."})
    sorted_indicators = sorted(indicators, key=lambda item: item["cohort_gap_points"])
    actions = [
        {
            "pillar": item["name"],
            "cohort_gap_points": item["cohort_gap_points"],
            "action": item["suggested_intervention"],
        }
        for item in weakest
    ]
    actions.append({"pillar": "Segment", "cohort_gap_points": None, "action": SEGMENT_ACTIONS[row.segment]})
    return {
        "student": {
            key: json_value(row[key])
            for key in ["student_id", "student_name", "department", "year", "success_score", "academic_index", "placement_index", "risk_level", "segment"]
        },
        "score": {
            "value": json_value(row.success_score),
            "scale": [0, 100],
            "cohort_average": round(float(cohort.success_score.mean()), 1),
            "cohort_gap_points": round(float(row.success_score - cohort.success_score.mean()), 1),
            "formula": "Normalized indicators are share-weighted within pillars; pillar scores use weights 30/15/12/8/22/8/5. Backlogs are inverted.",
        },
        "risks": {
            "level": row.risk_level,
            "academic": {"flagged": bool(row.academic_risk), "reasons": academic_reasons},
            "placement": {"flagged": bool(row.placement_risk), "reasons": placement_reasons},
            "reasons": reasons,
        },
        "cohort_cuts": {
            "academic_index_median": round(float(cohort.academic_index.median()), 1),
            "placement_index_median": round(float(cohort.placement_index.median()), 1),
        },
        "pillars": pillar_details,
        "indicators": indicators,
        "top_drags": sorted_indicators[:5],
        "top_strengths": list(reversed(sorted_indicators[-5:])),
        "suggested_interventions": actions,
    }


@app.get("/students/{student_id}")
def get_student(student_id: str, dataset_id: str | None = None) -> dict[str, Any]:
    return {"dataset_id": dataset_id or SYNTHETIC_DATASET_ID, **student_profile(store.get(dataset_id), student_id)}


def rule_based_plan(profile: dict[str, Any]) -> str:
    student = profile["student"]
    risks = profile["risks"]
    causes = [reason["text"] for reason in risks["reasons"]] or ["No threshold-based risk flag is active."]
    actions = profile["suggested_interventions"][:2]
    return "\n".join(
        [
            f"{student['student_id']} has a Success Score of {student['success_score']:.1f}/100 ({student['risk_level']} risk).",
            "Reasons: " + "; ".join(causes),
            "Next steps: " + " ".join(item["action"] for item in actions),
            "Segment action: " + profile["suggested_interventions"][-1]["action"],
        ]
    )


@app.post("/students/{student_id}/intervention")
def intervention(student_id: str, dataset_id: str | None = None) -> dict[str, str]:
    profile = student_profile(store.get(dataset_id), student_id)
    fallback = rule_based_plan(profile)
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        return {"student_id": student_id, "source": "rules", "plan": fallback}
    try:
        from groq import Groq

        response = Groq(api_key=api_key).chat.completions.create(
            model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
            messages=[
                {
                    "role": "system",
                    "content": "Write a concise, kind, practical student intervention plan using only the supplied score and risk facts. Do not diagnose or invent circumstances.",
                },
                {"role": "user", "content": fallback},
            ],
            temperature=0.3,
            max_tokens=500,
        )
        plan = response.choices[0].message.content.strip()
        return {"student_id": student_id, "source": "groq", "plan": plan or fallback}
    except Exception:
        return {"student_id": student_id, "source": "rules", "plan": fallback}


@app.post("/datasets")
async def upload_dataset(file: UploadFile = File(...)) -> dict[str, Any]:
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=415, detail="Upload a .csv file")
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    await file.close()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"CSV exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB upload limit")
    raw = validate_upload(content)
    dataset_id = store.add(raw)
    return {
        "dataset_id": dataset_id,
        "rows": len(raw),
        "departments": sorted(raw.department.unique().tolist()),
        "years": sorted(int(value) for value in raw.year.unique()),
        "trends_available": False,
    }