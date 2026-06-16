#!/usr/bin/env python3
"""Portable tabular data profiler and validator for the data-analysis skill."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

MISSING = {"", "na", "n/a", "null", "none", "nan", "-"}
DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y", "%Y-%m-%d %H:%M:%S")
GROUPED_NUMBER_RE = re.compile(r"^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$")


def is_missing(value: Any) -> bool:
    if value is None:
        return True
    return str(value).strip().lower() in MISSING


def normalize_value(value: Any) -> str:
    if is_missing(value):
        return ""
    return str(value).strip()


def parse_number(value: Any) -> Optional[float]:
    if is_missing(value):
        return None
    text = str(value).strip()
    if "," in text and not GROUPED_NUMBER_RE.match(text):
        return None
    text = text.replace(",", "")
    try:
        number = float(text)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def parse_boolean(value: Any) -> Optional[bool]:
    if is_missing(value):
        return None
    text = str(value).strip().lower()
    if text in {"true", "yes"}:
        return True
    if text in {"false", "no"}:
        return False
    return None


def parse_date(value: Any) -> Optional[datetime]:
    if is_missing(value):
        return None
    text = str(value).strip()
    if text.isdigit():
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=None)
    except ValueError:
        pass
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def classify_value(value: Any) -> str:
    if is_missing(value):
        return "missing"
    if parse_boolean(value) is not None:
        return "boolean"
    if parse_number(value) is not None:
        return "number"
    if parse_date(value) is not None:
        return "date"
    return "string"


def load_records(path: Path) -> tuple[list[dict[str, Any]], list[str], str]:
    suffix = path.suffix.lower()
    if suffix in {".csv", ".tsv"}:
        delimiter = "\t" if suffix == ".tsv" else ","
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle, delimiter=delimiter)
            records = [dict(row) for row in reader]
            return records, list(reader.fieldnames or []), suffix.lstrip(".")
    if suffix == ".jsonl":
        records = []
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    value = json.loads(line)
                    if isinstance(value, dict):
                        records.append(value)
        return records, sorted({key for row in records for key in row.keys()}), "jsonl"
    if suffix == ".json":
        value = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(value, list):
            records = [row for row in value if isinstance(row, dict)]
        elif isinstance(value, dict):
            rows = value.get("rows") or value.get("data") or value.get("records")
            records = [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else [value]
        else:
            records = []
        return records, sorted({key for row in records for key in row.keys()}), "json"
    raise ValueError(f"unsupported_format:{suffix or 'none'}")


def infer_type(values: list[Any]) -> str:
    present = [value for value in values if not is_missing(value)]
    if not present:
        return "empty"
    classes = [classify_value(value) for value in present]
    if all(value == "boolean" for value in classes):
        return "boolean"
    if all(value == "number" for value in classes):
        return "number"
    if all(value == "date" for value in classes):
        return "date"
    return "string"


def percentile(values: list[float], p: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * p
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return ordered[int(index)]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


def profile_column(name: str, values: list[Any]) -> dict[str, Any]:
    present = [value for value in values if not is_missing(value)]
    missing_count = len(values) - len(present)
    inferred = infer_type(values)
    distinct_values = {normalize_value(value) for value in present}
    type_counts = Counter(classify_value(value) for value in values)
    result: dict[str, Any] = {
        "name": name,
        "type": inferred,
        "count": len(values),
        "present_count": len(present),
        "missing_count": missing_count,
        "missing_ratio": round(missing_count / len(values), 6) if values else 0,
        "distinct_count": len(distinct_values),
        "type_counts": dict(sorted(type_counts.items())),
        "quality_flags": [],
    }

    if inferred == "number":
        numeric_values = [value for value in (parse_number(value) for value in present) if value is not None]
        q1 = percentile(numeric_values, 0.25)
        q3 = percentile(numeric_values, 0.75)
        outlier_count = 0
        if q1 is not None and q3 is not None:
            iqr = q3 - q1
            lower = q1 - 1.5 * iqr
            upper = q3 + 1.5 * iqr
            outlier_count = sum(1 for value in numeric_values if value < lower or value > upper)
        result["numeric"] = {
            "min": min(numeric_values) if numeric_values else None,
            "max": max(numeric_values) if numeric_values else None,
            "mean": statistics.fmean(numeric_values) if numeric_values else None,
            "median": statistics.median(numeric_values) if numeric_values else None,
            "p25": q1,
            "p75": q3,
            "stdev": statistics.stdev(numeric_values) if len(numeric_values) > 1 else None,
            "outlier_count_iqr": outlier_count,
        }
        if outlier_count:
            result["quality_flags"].append("outliers_iqr")
    elif inferred == "date":
        date_values = [value for value in (parse_date(value) for value in present) if value is not None]
        result["date"] = {
            "min": min(date_values).isoformat() if date_values else None,
            "max": max(date_values).isoformat() if date_values else None,
        }
    else:
        counts = Counter(normalize_value(value) for value in present)
        result["top_values"] = [{"value": value, "count": count} for value, count in counts.most_common(10)]

    if missing_count == len(values) and values:
        result["quality_flags"].append("all_missing")
    elif result["missing_ratio"] >= 0.4:
        result["quality_flags"].append("high_missing")
    if present and len(distinct_values) == 1:
        result["quality_flags"].append("constant")
    if present and len(distinct_values) == len(present):
        result["quality_flags"].append("unique_values")
    if present and len(distinct_values) / len(present) >= 0.95:
        result["quality_flags"].append("mostly_unique")
    if name.strip().lower() in {"id", "key"} or name.strip().lower().endswith(("_id", " id", "_key", " key")):
        result["quality_flags"].append("identifier_name")
    if inferred == "string":
        non_missing_classes = Counter(classify_value(value) for value in present)
        if len([key for key in non_missing_classes if key != "string"]) > 0:
            result["quality_flags"].append("mixed_parseable_values")
    return result


def duplicate_row_count(records: list[dict[str, Any]], fields: list[str]) -> int:
    counts = Counter(json.dumps([normalize_value(row.get(field)) for field in fields], ensure_ascii=False) for row in records)
    return sum(count - 1 for count in counts.values() if count > 1)


def suggested_contract(columns: list[dict[str, Any]], row_count: int) -> dict[str, Any]:
    fields = []
    for column in columns:
        field: dict[str, Any] = {
            "name": column["name"],
            "type": column["type"],
            "required": column["missing_count"] == 0,
        }
        if row_count > 0 and column["missing_count"] == 0 and column["distinct_count"] == row_count:
            field["unique"] = True
        fields.append(field)
    return {"fields": fields, "rowCountMin": 1 if row_count else 0}


def profile(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "file": str(path),
        "ok": False,
        "errors": [],
        "warnings": [],
        "format": None,
        "row_count": 0,
        "column_count": 0,
        "duplicate_row_count": 0,
        "candidate_key_columns": [],
        "quality": {},
        "suggested_contract": {},
        "columns": [],
    }
    if not path.exists():
        result["errors"].append("file_not_found")
        return result
    try:
        records, fields, fmt = load_records(path)
    except Exception as error:
        result["errors"].append(str(error))
        return result

    result["format"] = fmt
    result["row_count"] = len(records)
    result["column_count"] = len(fields)
    if not records:
        result["warnings"].append("no_records_found")
    if not fields:
        result["warnings"].append("no_columns_found")

    columns = [profile_column(field, [row.get(field) for row in records]) for field in fields]
    result["columns"] = columns
    result["duplicate_row_count"] = duplicate_row_count(records, fields) if records and fields else 0
    result["candidate_key_columns"] = [
        column["name"]
        for column in columns
        if result["row_count"] > 0 and column["missing_count"] == 0 and column["distinct_count"] == result["row_count"]
    ]
    result["quality"] = {
        "empty_columns": [column["name"] for column in columns if "all_missing" in column["quality_flags"]],
        "high_missing_columns": [column["name"] for column in columns if "high_missing" in column["quality_flags"]],
        "constant_columns": [column["name"] for column in columns if "constant" in column["quality_flags"]],
        "outlier_columns": [column["name"] for column in columns if "outliers_iqr" in column["quality_flags"]],
        "likely_identifier_columns": [
            column["name"]
            for column in columns
            if "identifier_name" in column["quality_flags"] or column["name"] in result["candidate_key_columns"]
        ],
    }
    result["suggested_contract"] = suggested_contract(columns, result["row_count"])

    if any(column["missing_count"] for column in columns):
        result["warnings"].append("missing_values_present")
    if result["duplicate_row_count"]:
        result["warnings"].append("duplicate_rows_present")
    if result["quality"]["empty_columns"]:
        result["warnings"].append("empty_columns_present")
    if result["quality"]["high_missing_columns"]:
        result["warnings"].append("high_missing_columns_present")
    if result["quality"]["constant_columns"]:
        result["warnings"].append("constant_columns_present")
    result["ok"] = len(result["errors"]) == 0
    return result


def check(status: str, name: str, details: dict[str, Any]) -> dict[str, Any]:
    return {"name": name, "status": status, "details": details}


def contract_int(value: Any, name: str, result: dict[str, Any]) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        result["checks"].append(check("failed", name, {"error": "invalid_integer", "value": value}))
        return None
    if isinstance(value, float) and not value.is_integer():
        result["checks"].append(check("failed", name, {"error": "invalid_integer", "value": value}))
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        result["checks"].append(check("failed", name, {"error": "invalid_integer", "value": value}))
        return None


def values_for(records: list[dict[str, Any]], field: str) -> list[Any]:
    return [row.get(field) for row in records]


def range_violations(values: list[Any], expected_type: str, min_value: Any, max_value: Any) -> int:
    violations = 0
    for value in values:
        if is_missing(value):
            continue
        parsed: Any
        lower: Any
        upper: Any
        if expected_type == "date":
            parsed = parse_date(value)
            lower = parse_date(min_value) if min_value is not None else None
            upper = parse_date(max_value) if max_value is not None else None
        else:
            parsed = parse_number(value)
            lower = parse_number(min_value) if min_value is not None else None
            upper = parse_number(max_value) if max_value is not None else None
        if parsed is None:
            violations += 1
            continue
        if lower is not None and parsed < lower:
            violations += 1
        if upper is not None and parsed > upper:
            violations += 1
    return violations


def validate(path: Path, contract_path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "file": str(path),
        "contract": str(contract_path),
        "ok": False,
        "errors": [],
        "warnings": [],
        "checks": [],
    }
    if not contract_path.exists():
        result["errors"].append("contract_not_found")
        return result
    try:
        records, fields, _fmt = load_records(path)
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
    except Exception as error:
        result["errors"].append(str(error))
        return result
    if not isinstance(contract, dict):
        result["errors"].append("contract_not_object")
        return result

    profile_report = profile(path)
    columns = {column["name"]: column for column in profile_report.get("columns", [])}
    field_set = set(fields)

    row_min = contract_int(contract.get("rowCountMin"), "rowCountMin", result)
    row_max = contract_int(contract.get("rowCountMax"), "rowCountMax", result)
    if row_min is not None:
        status = "passed" if len(records) >= row_min else "failed"
        result["checks"].append(check(status, "rowCountMin", {"actual": len(records), "expected": row_min}))
    if row_max is not None:
        status = "passed" if len(records) <= row_max else "failed"
        result["checks"].append(check(status, "rowCountMax", {"actual": len(records), "expected": row_max}))

    for field_contract in contract.get("fields", []):
        name = field_contract.get("name")
        if not name:
            result["checks"].append(check("failed", "fieldName", {"error": "missing_field_name"}))
            continue
        if name not in field_set:
            result["checks"].append(check("failed", f"field:{name}:exists", {"available": fields}))
            continue

        column = columns.get(name, {})
        values = values_for(records, name)
        if field_contract.get("required"):
            missing_count = column.get("missing_count", 0)
            status = "passed" if missing_count == 0 else "failed"
            result["checks"].append(check(status, f"field:{name}:required", {"missing_count": missing_count}))

        expected_type = field_contract.get("type")
        if expected_type:
            actual_type = column.get("type")
            status = "passed" if actual_type == expected_type else "failed"
            result["checks"].append(check(status, f"field:{name}:type", {"actual": actual_type, "expected": expected_type}))

        if field_contract.get("unique"):
            present = [normalize_value(value) for value in values if not is_missing(value)]
            duplicate_count = len(present) - len(set(present))
            status = "passed" if duplicate_count == 0 else "failed"
            result["checks"].append(check(status, f"field:{name}:unique", {"duplicate_count": duplicate_count}))

        allowed_values = field_contract.get("allowedValues", field_contract.get("allowed_values"))
        if allowed_values is not None:
            allowed = {str(value) for value in allowed_values}
            invalid = sorted({normalize_value(value) for value in values if not is_missing(value) and normalize_value(value) not in allowed})
            status = "passed" if not invalid else "failed"
            result["checks"].append(check(status, f"field:{name}:allowedValues", {"invalid_values": invalid[:20], "invalid_count": len(invalid)}))

        if "min" in field_contract or "max" in field_contract:
            expected_for_range = expected_type or column.get("type") or "number"
            violations = range_violations(values, expected_for_range, field_contract.get("min"), field_contract.get("max"))
            status = "passed" if violations == 0 else "failed"
            result["checks"].append(check(status, f"field:{name}:range", {"violation_count": violations}))

    for unique_key in contract.get("uniqueKeys", []):
        missing = [field for field in unique_key if field not in field_set]
        if missing:
            result["checks"].append(check("failed", f"uniqueKey:{','.join(unique_key)}", {"missing_fields": missing}))
            continue
        keys = [tuple(normalize_value(row.get(field)) for field in unique_key) for row in records]
        duplicate_count = len(keys) - len(set(keys))
        status = "passed" if duplicate_count == 0 else "failed"
        result["checks"].append(check(status, f"uniqueKey:{','.join(unique_key)}", {"duplicate_count": duplicate_count}))

    failed = [item for item in result["checks"] if item["status"] == "failed"]
    result["errors"] = [item["name"] for item in failed]
    result["ok"] = len(result["errors"]) == 0
    return result


def write_report(report: dict[str, Any], out: str) -> None:
    data = json.dumps(report, indent=2, ensure_ascii=False)
    if out == "-":
        print(data)
    else:
        Path(out).write_text(data + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Profile or validate CSV, TSV, JSON, or JSONL data.")
    sub = parser.add_subparsers(dest="command", required=True)
    profile_cmd = sub.add_parser("profile", help="Profile a tabular data file.")
    profile_cmd.add_argument("input")
    profile_cmd.add_argument("--out", default="-")
    validate_cmd = sub.add_parser("validate", help="Validate a tabular data file against a portable JSON contract.")
    validate_cmd.add_argument("input")
    validate_cmd.add_argument("--contract", required=True)
    validate_cmd.add_argument("--out", default="-")
    args = parser.parse_args()

    if args.command == "profile":
        report = profile(Path(args.input))
    else:
        report = validate(Path(args.input), Path(args.contract))
    write_report(report, args.out)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
