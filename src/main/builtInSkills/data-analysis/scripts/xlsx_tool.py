#!/usr/bin/env python3
"""Portable XLSX workbook inspection helper for the data-analysis skill."""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from typing import Optional
from xml.etree import ElementTree as ET

PLACEHOLDER_RE = re.compile(r"\b(lorem|ipsum|todo|placeholder|sample|dummy|xxxx)\b", re.I)
FORMULA_ERROR_RE = re.compile(r"^#(?:REF!|DIV/0!|VALUE!|N/A|NAME\?|NUM!|NULL!)$", re.I)
REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
S_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def read_xml(zf: zipfile.ZipFile, name: str) -> Optional[ET.Element]:
    try:
        return ET.fromstring(zf.read(name))
    except Exception:
        return None


def rels_for(zf: zipfile.ZipFile, rels_name: str) -> dict[str, dict[str, str]]:
    root = read_xml(zf, rels_name)
    if root is None:
        return {}
    rels = {}
    for rel in root.findall(f"{REL_NS}Relationship"):
        rid = rel.attrib.get("Id")
        if rid:
            rels[rid] = {
                "type": rel.attrib.get("Type", ""),
                "target": rel.attrib.get("Target", ""),
                "mode": rel.attrib.get("TargetMode", ""),
            }
    return rels


def normalized_target(source_part: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target))


def relationship_kind(rel_type: str) -> str:
    return rel_type.rstrip("/").rsplit("/", 1)[-1] if rel_type else ""


def shared_strings(zf: zipfile.ZipFile) -> list[str]:
    root = read_xml(zf, "xl/sharedStrings.xml")
    if root is None:
        return []
    values = []
    for si in root.findall(f"{S_NS}si"):
        parts = []
        for text in si.iter(f"{S_NS}t"):
            if text.text:
                parts.append(text.text)
        values.append("".join(parts))
    return values


def inspect_sheet(zf: zipfile.ZipFile, names: set[str], sheet_name: str, sheet_part: str, shared: list[str]) -> dict:
    report = {
        "name": sheet_name,
        "part": sheet_part,
        "dimension": None,
        "row_count": 0,
        "hidden_row_count": 0,
        "hidden_column_count": 0,
        "cell_count": 0,
        "formula_count": 0,
        "formula_error_count": 0,
        "formula_error_cells": [],
        "merged_cell_count": 0,
        "table_count": 0,
        "drawing_count": 0,
        "data_validation_count": 0,
        "conditional_format_count": 0,
        "placeholder_hits": [],
        "missing_relationship_targets": [],
    }
    if sheet_part not in names:
        report["missing_relationship_targets"].append({"from": "xl/workbook.xml", "target": sheet_part})
        return report

    root = read_xml(zf, sheet_part)
    if root is None:
        return report
    dimension = root.find(f"{S_NS}dimension")
    if dimension is not None:
        report["dimension"] = dimension.attrib.get("ref")
    rows = list(root.iter(f"{S_NS}row"))
    cells = list(root.iter(f"{S_NS}c"))
    report["row_count"] = len(rows)
    report["hidden_row_count"] = sum(1 for row in rows if row.attrib.get("hidden") == "1")
    report["hidden_column_count"] = len([col for col in root.iter(f"{S_NS}col") if col.attrib.get("hidden") == "1"])
    report["cell_count"] = len(cells)
    report["formula_count"] = len(list(root.iter(f"{S_NS}f")))
    report["merged_cell_count"] = len(list(root.iter(f"{S_NS}mergeCell")))
    report["table_count"] = len(list(root.iter(f"{S_NS}tablePart")))
    report["data_validation_count"] = len(list(root.iter(f"{S_NS}dataValidation")))
    report["conditional_format_count"] = len(list(root.iter(f"{S_NS}conditionalFormatting")))

    text_values = []
    for cell in cells:
        value = cell.find(f"{S_NS}v")
        if value is None or value.text is None:
            continue
        if cell.attrib.get("t") == "e" or FORMULA_ERROR_RE.match(value.text.strip()):
            report["formula_error_count"] += 1
            if len(report["formula_error_cells"]) < 25:
                report["formula_error_cells"].append({"cell": cell.attrib.get("r", ""), "value": value.text.strip()})
        if cell.attrib.get("t") == "s":
            try:
                text_values.append(shared[int(value.text)])
            except Exception:
                continue
        else:
            text_values.append(value.text)
    hits = sorted(set(match.group(0).lower() for match in PLACEHOLDER_RE.finditer("\n".join(text_values))))
    report["placeholder_hits"] = hits

    rels_name = str(Path(sheet_part).parent / "_rels" / f"{Path(sheet_part).name}.rels")
    for rel_id, rel in rels_for(zf, rels_name).items():
        if relationship_kind(rel.get("type", "")) == "drawing":
            report["drawing_count"] += 1
        if rel.get("mode") == "External":
            continue
        target = rel.get("target", "")
        resolved = normalized_target(sheet_part, target)
        if resolved not in names:
            report["missing_relationship_targets"].append({"from": sheet_part, "rid": rel_id, "target": target})
    return report


def inspect_xlsx(path: Path) -> dict:
    result = {
        "file": str(path),
        "ok": False,
        "errors": [],
        "warnings": [],
        "sheets": [],
        "sheet_count": 0,
        "formula_count": 0,
        "formula_error_count": 0,
        "shared_string_count": 0,
        "defined_name_count": 0,
        "table_count": 0,
        "chart_count": 0,
        "pivot_table_count": 0,
        "hidden_sheets": [],
        "calculation_mode": None,
        "external_relationships": [],
        "placeholder_hits": [],
        "missing_relationship_targets": [],
    }
    if not path.exists():
        result["errors"].append("file_not_found")
        return result
    if path.suffix.lower() != ".xlsx":
        result["errors"].append("not_xlsx")
        return result

    try:
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
            required = ["[Content_Types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"]
            for name in required:
                if name not in names:
                    result["errors"].append(f"missing:{name}")
            if result["errors"]:
                return result

            workbook = read_xml(zf, "xl/workbook.xml")
            workbook_rels = rels_for(zf, "xl/_rels/workbook.xml.rels")
            shared = shared_strings(zf)
            result["shared_string_count"] = len(shared)
            result["table_count"] = len([name for name in names if name.startswith("xl/tables/") and name.endswith(".xml")])
            result["chart_count"] = len([name for name in names if name.startswith("xl/charts/") and name.endswith(".xml")])
            result["pivot_table_count"] = len([name for name in names if name.startswith("xl/pivotTables/") and name.endswith(".xml")])
            sheet_refs = []
            if workbook is not None:
                result["defined_name_count"] = len(list(workbook.iter(f"{S_NS}definedName")))
                calc_pr = workbook.find(f"{S_NS}calcPr")
                if calc_pr is not None:
                    result["calculation_mode"] = calc_pr.attrib.get("calcMode")
                for sheet in workbook.iter(f"{S_NS}sheet"):
                    rid = sheet.attrib.get(f"{R_NS}id")
                    name = sheet.attrib.get("name", f"sheet-{len(sheet_refs) + 1}")
                    state = sheet.attrib.get("state", "visible")
                    if state != "visible":
                        result["hidden_sheets"].append({"name": name, "state": state})
                    rel = workbook_rels.get(rid or "", {})
                    target = rel.get("target", "")
                    part = normalized_target("xl/workbook.xml", target) if target else ""
                    sheet_refs.append((name, part))

            for sheet_name, sheet_part in sheet_refs:
                sheet_report = inspect_sheet(zf, names, sheet_name, sheet_part, shared)
                result["sheets"].append(sheet_report)
                result["formula_count"] += sheet_report["formula_count"]
                result["formula_error_count"] += sheet_report["formula_error_count"]
                for hit in sheet_report["placeholder_hits"]:
                    result["placeholder_hits"].append({"sheet": sheet_name, "text": hit})
                result["missing_relationship_targets"].extend(sheet_report["missing_relationship_targets"])

            for rid, rel in workbook_rels.items():
                target = rel.get("target", "")
                if rel.get("mode") == "External":
                    result["external_relationships"].append({"rid": rid, "target": target})
                    continue
                resolved = normalized_target("xl/workbook.xml", target)
                if resolved not in names:
                    result["missing_relationship_targets"].append({"from": "xl/workbook.xml", "rid": rid, "target": target})

            result["sheet_count"] = len(result["sheets"])
            if result["placeholder_hits"]:
                result["warnings"].append("placeholder_text_found")
            if result["missing_relationship_targets"]:
                result["warnings"].append("missing_relationship_targets")
            if result["external_relationships"]:
                result["warnings"].append("external_relationships_present")
            if result["formula_count"]:
                result["warnings"].append("formulas_present_not_recalculated")
            if result["formula_error_count"]:
                result["warnings"].append("formula_errors_found")
            if result["hidden_sheets"]:
                result["warnings"].append("hidden_sheets_present")
            if result["calculation_mode"] == "manual":
                result["warnings"].append("manual_calculation_mode")
            result["ok"] = len(result["errors"]) == 0 and len(result["missing_relationship_targets"]) == 0
            return result
    except zipfile.BadZipFile:
        result["errors"].append("bad_zip")
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect an XLSX workbook.")
    sub = parser.add_subparsers(dest="command", required=True)
    inspect_cmd = sub.add_parser("inspect", help="Inspect workbook package structure.")
    inspect_cmd.add_argument("xlsx")
    inspect_cmd.add_argument("--out", default="-")
    args = parser.parse_args()

    report = inspect_xlsx(Path(args.xlsx))
    data = json.dumps(report, indent=2, ensure_ascii=False)
    if args.out == "-":
        print(data)
    else:
        Path(args.out).write_text(data + "\n", encoding="utf-8")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
