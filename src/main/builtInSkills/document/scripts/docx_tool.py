#!/usr/bin/env python3
"""Portable DOCX inspection helper for the document skill."""

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
MANUAL_BULLET_RE = re.compile(r"^\s*(?:[-*•‣◦▪]|\d+[.)])\s+")
REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def read_xml(zf: zipfile.ZipFile, name: str) -> Optional[ET.Element]:
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


def paragraph_text(paragraph: ET.Element) -> str:
    parts = []
    for text in paragraph.iter(f"{W_NS}t"):
        if text.text:
            parts.append(text.text)
    return "".join(parts)


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


def paragraph_style(paragraph: ET.Element) -> Optional[str]:
    p_pr = paragraph.find(f"{W_NS}pPr")
    if p_pr is None:
        return None
    p_style = p_pr.find(f"{W_NS}pStyle")
    if p_style is None:
        return None
    return p_style.attrib.get(f"{W_NS}val")


def heading_level(style: Optional[str]) -> Optional[int]:
    if not style:
        return None
    match = re.search(r"heading\s*([1-6])$", style, re.I)
    if not match:
        match = re.search(r"heading([1-6])$", style, re.I)
    return int(match.group(1)) if match else None


def count_xml_part(zf: zipfile.ZipFile, part: str, tag: str) -> int:
    root = read_xml(zf, part)
    return len(list(root.iter(tag))) if root is not None else 0


def inspect_docx(path: Path) -> dict:
    result = {
        "file": str(path),
        "ok": False,
        "errors": [],
        "warnings": [],
        "paragraph_count": 0,
        "heading_count": 0,
        "heading_level_counts": {},
        "heading_sequence_issues": [],
        "section_count": 0,
        "table_count": 0,
        "tables_without_grid_count": 0,
        "media_count": 0,
        "header_count": 0,
        "footer_count": 0,
        "footnote_count": 0,
        "endnote_count": 0,
        "style_count": 0,
        "numbering_definition_count": 0,
        "comment_count": 0,
        "comment_reference_count": 0,
        "missing_comment_references": [],
        "tracked_change_count": 0,
        "hyperlink_count": 0,
        "manual_bullet_count": 0,
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
            result["header_count"] = len([name for name in names if name.startswith("word/header") and name.endswith(".xml")])
            result["footer_count"] = len([name for name in names if name.startswith("word/footer") and name.endswith(".xml")])
            result["footnote_count"] = count_xml_part(zf, "word/footnotes.xml", f"{W_NS}footnote")
            result["endnote_count"] = count_xml_part(zf, "word/endnotes.xml", f"{W_NS}endnote")
            result["style_count"] = count_xml_part(zf, "word/styles.xml", f"{W_NS}style")
            result["numbering_definition_count"] = count_xml_part(zf, "word/numbering.xml", f"{W_NS}num")
            doc = read_xml(zf, "word/document.xml")
            text = text_from_xml(doc)
            result["text_chars"] = len(text)
            hits = sorted(set(match.group(0).lower() for match in PLACEHOLDER_RE.finditer(text)))
            result["placeholder_hits"] = hits

            if doc is not None:
                paragraphs = list(doc.iter(f"{W_NS}p"))
                result["paragraph_count"] = len(paragraphs)
                heading_levels = []
                for paragraph in paragraphs:
                    style = paragraph_style(paragraph)
                    level = heading_level(style)
                    if level is not None:
                        heading_levels.append(level)
                    if MANUAL_BULLET_RE.match(paragraph_text(paragraph)):
                        result["manual_bullet_count"] += 1
                result["heading_count"] = len(heading_levels)
                level_counts = {}
                previous = 0
                for index, level in enumerate(heading_levels, start=1):
                    level_counts[str(level)] = level_counts.get(str(level), 0) + 1
                    if level > previous + 1:
                        result["heading_sequence_issues"].append({"heading_index": index, "level": level, "previous_level": previous})
                    previous = level
                result["heading_level_counts"] = level_counts
                result["section_count"] = len(list(doc.iter(f"{W_NS}sectPr")))
                tables = list(doc.iter(f"{W_NS}tbl"))
                result["table_count"] = len(tables)
                result["tables_without_grid_count"] = sum(1 for table in tables if table.find(f"{W_NS}tblGrid") is None)
                result["tracked_change_count"] = len(list(doc.iter(f"{W_NS}ins"))) + len(list(doc.iter(f"{W_NS}del")))
                result["hyperlink_count"] = len(list(doc.iter(f"{W_NS}hyperlink")))
                comment_refs = []
                for tag_name in ("commentRangeStart", "commentReference"):
                    for node in doc.iter(f"{W_NS}{tag_name}"):
                        comment_id = node.attrib.get(f"{W_NS}id")
                        if comment_id is not None:
                            comment_refs.append(comment_id)
                result["comment_reference_count"] = len(set(comment_refs))

            comments = read_xml(zf, "word/comments.xml")
            comment_ids = set()
            if comments is not None:
                for comment in comments.iter(f"{W_NS}comment"):
                    comment_id = comment.attrib.get(f"{W_NS}id")
                    if comment_id is not None:
                        comment_ids.add(comment_id)
                result["comment_count"] = len(comment_ids)
            if doc is not None:
                referenced = set()
                for tag_name in ("commentRangeStart", "commentReference"):
                    for node in doc.iter(f"{W_NS}{tag_name}"):
                        comment_id = node.attrib.get(f"{W_NS}id")
                        if comment_id is not None:
                            referenced.add(comment_id)
                result["missing_comment_references"] = sorted(referenced - comment_ids)

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
            if result["missing_comment_references"]:
                result["warnings"].append("missing_comment_references")
            if result["tracked_change_count"]:
                result["warnings"].append("tracked_changes_present")
            if result["manual_bullet_count"]:
                result["warnings"].append("manual_bullets_found")
            if result["heading_sequence_issues"]:
                result["warnings"].append("heading_level_jump_found")
            if result["tables_without_grid_count"]:
                result["warnings"].append("tables_without_grid_found")
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
