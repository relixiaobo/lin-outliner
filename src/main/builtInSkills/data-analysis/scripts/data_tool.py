#!/usr/bin/env python3
"""Portable tabular data profiler for the data-analysis skill."""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import sys
from collections import Counter
from pathlib import Path
from typing import Any

MISSING = {"", "na", "n/a", "null", "none", "nan", "-"}


def is_missing(value: Any) -> bool:
    if value is None:
        return True
    return str(value).strip().lower() in MISSING


def parse_number(value: Any) -> float | None:
    if is_missing(value):
        return None
    text = str(value).strip().replace(",", "")
    try:
        number = float(text)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


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
    numeric = [parse_number(value) for value in present]
    if all(value is not None for value in numeric):
        return "number"
    lowered = {str(value).strip().lower() for value in present}
    if lowered <= {"true", "false", "yes", "no", "0", "1"}:
        return "boolean"
    return "string"


def profile_column(name: str, values: list[Any]) -> dict[str, Any]:
    present = [value for value in values if not is_missing(value)]
    missing_count = len(values) - len(present)
    inferred = infer_type(values)
    result: dict[str, Any] = {
        "name": name,
        "type": inferred,
        "count": len(values),
        "missing_count": missing_count,
        "missing_ratio": round(missing_count / len(values), 6) if values else 0,
        "distinct_count": len({str(value) for value in present}),
    }
    if inferred == "number":
        numbers = [parse_number(value) for value in present]
        numeric_values = [value for value in numbers if value is not None]
        result["numeric"] = {
            "min": min(numeric_values) if numeric_values else None,
            "max": max(numeric_values) if numeric_values else None,
            "mean": statistics.fmean(numeric_values) if numeric_values else None,
            "median": statistics.median(numeric_values) if numeric_values else None,
        }
    else:
        counts = Counter(str(value).strip() for value in present)
        result["top_values"] = [{"value": value, "count": count} for value, count in counts.most_common(10)]
    return result


def profile(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "file": str(path),
        "ok": False,
        "errors": [],
        "warnings": [],
        "format": None,
        "row_count": 0,
        "column_count": 0,
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

    columns = []
    for field in fields:
        columns.append(profile_column(field, [row.get(field) for row in records]))
    result["columns"] = columns
    if any(column["missing_count"] for column in columns):
        result["warnings"].append("missing_values_present")
    result["ok"] = len(result["errors"]) == 0
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Profile CSV, TSV, JSON, or JSONL data.")
    sub = parser.add_subparsers(dest="command", required=True)
    profile_cmd = sub.add_parser("profile", help="Profile a tabular data file.")
    profile_cmd.add_argument("input")
    profile_cmd.add_argument("--out", default="-")
    args = parser.parse_args()

    report = profile(Path(args.input))
    data = json.dumps(report, indent=2, ensure_ascii=False)
    if args.out == "-":
        print(data)
    else:
        Path(args.out).write_text(data + "\n", encoding="utf-8")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
