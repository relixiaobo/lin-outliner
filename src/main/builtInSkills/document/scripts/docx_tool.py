#!/usr/bin/env python3
"""Portable DOCX inspection helper for the document skill."""

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
W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
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
        if node.tag == f"{W_NS}t" and node.text:
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


def paragraph_style(paragraph: ET.Element) -> str | None:
    p_pr = paragraph.find(f"{W_NS}pPr")
    if p_pr is None:
        return None
    p_style = p_pr.find(f"{W_NS}pStyle")
    if p_style is None:
        return None
    return p_style.attrib.get(f"{W_NS}val")


def inspect_docx(path: Path) -> dict:
    result = {
        "file": str(path),
        "ok": False,
        "errors": [],
        "warnings": [],
        "paragraph_count": 0,
        "heading_count": 0,
        "table_count": 0,
        "media_count": 0,
        "comment_count": 0,
        "tracked_change_count": 0,
        "hyperlink_count": 0,
        "text_chars": 0,
        "placeholder_hits": [],
        "external_relationships": [],
        "missing_relationship_targets": [],
    }

    if not path.exists():
        result["errors"].append("file_not_found")
        return result
    if path.suffix.lower() != ".docx":
        result["errors"].append("not_docx")
        return result

    try:
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
            required = ["[Content_Types].xml", "word/document.xml"]
            for name in required:
                if name not in names:
                    result["errors"].append(f"missing:{name}")
            if result["errors"]:
                return result

            result["media_count"] = len([name for name in names if name.startswith("word/media/")])
            doc = read_xml(zf, "word/document.xml")
            text = text_from_xml(doc)
            result["text_chars"] = len(text)
            hits = sorted(set(match.group(0).lower() for match in PLACEHOLDER_RE.finditer(text)))
            result["placeholder_hits"] = hits

            if doc is not None:
                paragraphs = list(doc.iter(f"{W_NS}p"))
                result["paragraph_count"] = len(paragraphs)
                result["heading_count"] = sum(1 for p in paragraphs if (paragraph_style(p) or "").lower().startswith("heading"))
                result["table_count"] = len(list(doc.iter(f"{W_NS}tbl")))
                result["tracked_change_count"] = len(list(doc.iter(f"{W_NS}ins"))) + len(list(doc.iter(f"{W_NS}del")))
                result["hyperlink_count"] = len(list(doc.iter(f"{W_NS}hyperlink")))

            comments = read_xml(zf, "word/comments.xml")
            if comments is not None:
                result["comment_count"] = len(list(comments.iter(f"{W_NS}comment")))

            rels = rels_for(zf, "word/_rels/document.xml.rels")
            for rid, rel in rels.items():
                target = rel.get("target", "")
                if rel.get("mode") == "External":
                    result["external_relationships"].append({"rid": rid, "target": target})
                    continue
                resolved = normalized_target("word/document.xml", target)
                if resolved not in names:
                    result["missing_relationship_targets"].append({"from": "word/document.xml", "rid": rid, "target": target})

            if result["placeholder_hits"]:
                result["warnings"].append("placeholder_text_found")
            if result["missing_relationship_targets"]:
                result["warnings"].append("missing_relationship_targets")
            if result["tracked_change_count"]:
                result["warnings"].append("tracked_changes_present")
            result["ok"] = len(result["errors"]) == 0 and len(result["missing_relationship_targets"]) == 0
            return result
    except zipfile.BadZipFile:
        result["errors"].append("bad_zip")
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect a DOCX package.")
    sub = parser.add_subparsers(dest="command", required=True)
    inspect_cmd = sub.add_parser("inspect", help="Inspect DOCX package structure.")
    inspect_cmd.add_argument("docx")
    inspect_cmd.add_argument("--out", default="-")
    args = parser.parse_args()

    report = inspect_docx(Path(args.docx))
    data = json.dumps(report, indent=2, ensure_ascii=False)
    if args.out == "-":
        print(data)
    else:
        Path(args.out).write_text(data + "\n", encoding="utf-8")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
