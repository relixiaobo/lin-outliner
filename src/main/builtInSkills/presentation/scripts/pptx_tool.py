#!/usr/bin/env python3
"""Portable PPTX inspection helper for the presentation skill."""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

PLACEHOLDER_RE = re.compile(r"\b(lorem|ipsum|todo|placeholder|sample|dummy|xxxx)\b", re.I)
REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
P_NS = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def read_xml(zf: zipfile.ZipFile, name: str) -> ET.Element | None:
    try:
        return ET.fromstring(zf.read(name))
    except Exception:
        return None


def text_from_xml(root: ET.Element | None) -> str:
    if root is None:
        return ""
    parts = []
    for node in root.iter():
        if node.tag == f"{A_NS}t" and node.text:
            parts.append(node.text)
    return "\n".join(parts)


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
    base = Path(source_part).parent
    return str((base / target).as_posix())


def inspect_pptx(path: Path) -> dict:
    result = {
        "file": str(path),
        "ok": False,
        "errors": [],
        "warnings": [],
        "slides": [],
        "media_count": 0,
        "chart_count": 0,
        "placeholder_hits": [],
        "missing_relationship_targets": [],
    }

    if not path.exists():
        result["errors"].append("file_not_found")
        return result
    if path.suffix.lower() != ".pptx":
        result["errors"].append("not_pptx")
        return result

    try:
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
            result["media_count"] = len([name for name in names if name.startswith("ppt/media/")])
            result["chart_count"] = len([name for name in names if name.startswith("ppt/charts/")])

            required = ["[Content_Types].xml", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"]
            for name in required:
                if name not in names:
                    result["errors"].append(f"missing:{name}")
            if result["errors"]:
                return result

            pres = read_xml(zf, "ppt/presentation.xml")
            pres_rels = rels_for(zf, "ppt/_rels/presentation.xml.rels")

            slide_ids = []
            if pres is not None:
                for sld_id in pres.iter(f"{P_NS}sldId"):
                    rid = sld_id.attrib.get(f"{R_NS}id")
                    if rid:
                        slide_ids.append(rid)

            for index, rid in enumerate(slide_ids, start=1):
                rel = pres_rels.get(rid, {})
                target = rel.get("target", "")
                slide_part = normalized_target("ppt/presentation.xml", target) if target else ""
                slide_report = {
                    "index": index,
                    "rid": rid,
                    "part": slide_part,
                    "text_chars": 0,
                    "placeholder_hits": [],
                    "relationship_count": 0,
                }
                if not slide_part or slide_part not in names:
                    result["missing_relationship_targets"].append({"from": "ppt/presentation.xml", "rid": rid, "target": target})
                    result["slides"].append(slide_report)
                    continue

                slide_root = read_xml(zf, slide_part)
                text = text_from_xml(slide_root)
                slide_report["text_chars"] = len(text)
                hits = sorted(set(match.group(0).lower() for match in PLACEHOLDER_RE.finditer(text)))
                slide_report["placeholder_hits"] = hits
                for hit in hits:
                    result["placeholder_hits"].append({"slide": index, "text": hit})

                rels_name = str(Path(slide_part).parent / "_rels" / f"{Path(slide_part).name}.rels")
                slide_rels = rels_for(zf, rels_name)
                slide_report["relationship_count"] = len(slide_rels)
                for rel_id, slide_rel in slide_rels.items():
                    if slide_rel.get("mode") == "External":
                        continue
                    rel_target = slide_rel.get("target", "")
                    resolved = normalized_target(slide_part, rel_target)
                    if resolved not in names:
                        result["missing_relationship_targets"].append({"from": slide_part, "rid": rel_id, "target": rel_target})

                result["slides"].append(slide_report)

            if not result["slides"]:
                result["warnings"].append("no_slides_found")
            if result["placeholder_hits"]:
                result["warnings"].append("placeholder_text_found")
            if result["missing_relationship_targets"]:
                result["warnings"].append("missing_relationship_targets")
            result["ok"] = len(result["errors"]) == 0 and len(result["missing_relationship_targets"]) == 0
            return result
    except zipfile.BadZipFile:
        result["errors"].append("bad_zip")
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect a PPTX package.")
    sub = parser.add_subparsers(dest="command", required=True)
    inspect_cmd = sub.add_parser("inspect", help="Inspect PPTX package structure.")
    inspect_cmd.add_argument("pptx")
    inspect_cmd.add_argument("--out", default="-")
    args = parser.parse_args()

    report = inspect_pptx(Path(args.pptx))
    data = json.dumps(report, indent=2, ensure_ascii=False)
    if args.out == "-":
        print(data)
    else:
        Path(args.out).write_text(data + "\n", encoding="utf-8")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
