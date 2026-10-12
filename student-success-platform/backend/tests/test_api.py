from __future__ import annotations

import io

import pandas as pd
from fastapi.testclient import TestClient

from backend.main import app, make_synthetic_data, score_data


client = TestClient(app)


def csv_bytes(frame: pd.DataFrame) -> bytes:
    return frame.to_csv(index=False).encode("utf-8")


def test_health_filters_and_overview_contract():
    health = client.get("/health")
    filters = client.get("/filters")
    overview = client.get("/overview")

    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert filters.json()["dataset_id"] == "synthetic"
    assert len(filters.json()["departments"]) == 6
    assert overview.json()["students"] == 600
    assert set(overview.json()["risk_counts"]) == {"High", "Medium", "Low"}
    assert sum(item["count"] for item in overview.json()["distribution"]) == 600
    assert sum(item["students"] for item in overview.json()["department_stats"]) == 600
    assert sum(overview.json()["segment_counts"].values()) == 600


def test_filters_search_and_profile_explain_score():
    students = client.get("/students", params={"department": "CSE", "year": 1, "page_size": 5})
    assert students.status_code == 200
    assert len(students.json()["items"]) <= 5
    assert all(item["department"] == "CSE" and item["year"] == 1 for item in students.json()["items"])

    student_id = students.json()["items"][0]["student_id"]
    searched = client.get("/students", params={"q": student_id})
    assert searched.json()["total"] >= 1

    profile = client.get(f"/students/{student_id}").json()
    assert profile["student"]["student_id"] == student_id
    assert len(profile["indicators"]) == 17
    assert len(profile["top_drags"]) == 5
    assert len(profile["suggested_interventions"]) == 3
    assert "formula" in profile["score"]
    assert all("cohort_gap_points" in item for item in profile["indicators"])


def test_synthetic_trends_are_available():
    response = client.get("/trends")
    assert response.status_code == 200
    assert response.json()["available"] is True
    assert len(response.json()["items"]) > 0
    assert {"month", "attendance", "lms_logins"} <= set(response.json()["items"][0])


def test_source_score_weights_backlogs_and_risk_thresholds():
    raw, _ = make_synthetic_data(count=1)
    raw.loc[:, "student_id"] = "BOUNDARY"
    for column in ["cgpa", "internal_marks", "backlogs", "attendance", "lms_logins_per_week", "assignment_completion",
                   "events", "clubs", "hackathons", "certifications", "aptitude", "coding", "mock_interview",
                   "tech_skill", "soft_skill"]:
        raw.loc[:, column] = 0
    raw.loc[:, "student_satisfaction"] = 1
    raw.loc[:, "faculty_feedback"] = 1

    scored = score_data(raw).scored.iloc[0]

    assert scored.success_score == 6.0
    assert scored.academic_index == 10.5
    assert scored.risk_level == "High"
    assert bool(scored.academic_risk)
    assert bool(scored.placement_risk)
    assert "attendance 0%" in scored.academic_risk_reasons


def test_upload_is_validated_isolated_and_does_not_replace_default():
    raw, _ = make_synthetic_data(count=2)
    raw["student_id"] = ["UPLOAD-1", "UPLOAD-2"]
    before = client.get("/overview").json()

    uploaded = client.post(
        "/datasets", files={"file": ("cohort.csv", csv_bytes(raw), "text/csv")}
    )
    assert uploaded.status_code == 200
    dataset_id = uploaded.json()["dataset_id"]
    assert dataset_id != "synthetic"
    assert uploaded.json()["rows"] == 2
    assert client.get("/overview", params={"dataset_id": dataset_id}).json()["students"] == 2
    assert client.get("/students/UPLOAD-1", params={"dataset_id": dataset_id}).status_code == 200
    assert client.get("/overview").json()["students"] == before["students"] == 600

    trends = client.get("/trends", params={"dataset_id": dataset_id}).json()
    assert trends["available"] is False
    assert trends["items"] == []


def test_upload_reports_missing_and_invalid_values():
    missing = client.post(
        "/datasets", files={"file": ("missing.csv", b"student_id,department,year\nA,CSE,1\n", "text/csv")}
    )
    assert missing.status_code == 422
    assert missing.json()["error"]["code"] == "request_error"
    assert any("Missing required column" in issue for issue in missing.json()["error"]["issues"])

    raw, _ = make_synthetic_data(count=1)
    raw["student_id"] = "INVALID"
    raw["attendance"] = 101
    invalid = client.post(
        "/datasets", files={"file": ("invalid.csv", csv_bytes(raw), "text/csv")}
    )
    assert invalid.status_code == 422
    assert any("attendance must be between" in issue for issue in invalid.json()["error"]["issues"])


def test_unknown_dataset_and_student_return_contract_errors():
    dataset_error = client.get("/overview", params={"dataset_id": "missing"})
    student_error = client.get("/students/no-such-student")
    assert dataset_error.status_code == 404
    assert dataset_error.json()["error"]["message"] == "Unknown dataset_id: missing"
    assert student_error.status_code == 404
    assert "Student not found" in student_error.json()["error"]["message"]


def test_intervention_uses_rules_without_secret(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    response = client.post("/students/S0001/intervention")
    assert response.status_code == 200
    assert response.json()["source"] == "rules"
    assert response.json()["plan"]