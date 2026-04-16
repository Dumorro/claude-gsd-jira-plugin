#!/usr/bin/env python3
"""
enrich-cards.py — Populate Jira card descriptions from GSD artifacts.

Reads data/jira-mapping.json, extracts content from .planning/ files,
and updates each Jira card with a structured ADF description.

Usage:
  python3 scripts/enrich-cards.py --dry-run   # Preview what would be updated
  python3 scripts/enrich-cards.py             # Execute updates
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from base64 import b64encode

# --- Config ---
PROJECT_ROOT = Path(__file__).parent.parent
MAPPING_PATH = PROJECT_ROOT / "data" / "jira-mapping.json"

JIRA_HOST = os.environ.get("JIRA_HOST", "")
JIRA_USERNAME = os.environ.get("JIRA_USERNAME", "")
JIRA_API_TOKEN = os.environ.get("JIRA_API_TOKEN", "")

DRY_RUN = "--dry-run" in sys.argv


def auth_header():
    creds = b64encode(f"{JIRA_USERNAME}:{JIRA_API_TOKEN}".encode()).decode()
    return f"Basic {creds}"


# --- Auto-detect repos base ---

def find_repos_base():
    """Auto-detect the repos base directory by looking for src/*/.planning/ or .planning/ at root."""
    src_dir = PROJECT_ROOT / "src"
    if src_dir.exists():
        for d in src_dir.iterdir():
            if d.is_dir() and (d / ".planning").exists():
                return src_dir
    # Fallback: .planning/ at project root
    if (PROJECT_ROOT / ".planning").exists():
        return PROJECT_ROOT
    return src_dir


REPOS_BASE = find_repos_base()


# --- Card Type Detection ---

def card_type(card_id):
    """Determine card type by depth: repo/version=Epic, +phase=Feature, +plan=Subtask"""
    parts = card_id.split("/")
    if len(parts) == 2:
        return "epic"
    elif len(parts) == 3:
        return "feature"
    elif len(parts) == 4:
        return "subtask"
    return "unknown"


def parse_card_id(card_id):
    """Parse card ID into components."""
    parts = card_id.split("/")
    result = {"repo": parts[0], "version": parts[1] if len(parts) > 1 else None}
    if len(parts) >= 3:
        result["phase_slug"] = parts[2]
        # Extract phase number from slug like "01-solution-foundation" or "0.1-blueprint"
        m = re.match(r"^(\d+(?:\.\d+)?)", parts[2])
        result["phase_num"] = m.group(1) if m else parts[2]
    if len(parts) >= 4:
        # plan-01 -> 01
        result["plan_id"] = parts[3]
        m = re.match(r"plan-(\d+)", parts[3])
        result["plan_num"] = m.group(1) if m else "01"
    return result


# --- File Resolution ---

def find_planning_root(repo):
    planning = REPOS_BASE / repo / ".planning"
    if planning.exists():
        return planning
    # Fallback: .planning/ at project root
    if (PROJECT_ROOT / ".planning").exists():
        return PROJECT_ROOT / ".planning"
    return planning


def find_roadmap(repo, version):
    """Find the milestone ROADMAP.md file."""
    planning = find_planning_root(repo)
    # Try milestones/{version}-ROADMAP.md
    roadmap = planning / "milestones" / f"{version}-ROADMAP.md"
    if roadmap.exists():
        return roadmap
    # Try ROADMAP.md at root
    roadmap = planning / "ROADMAP.md"
    if roadmap.exists():
        return roadmap
    return None


def find_phase_dir(repo, version, phase_num):
    """Find the phase directory by phase number."""
    planning = find_planning_root(repo)

    # Try milestones/{version}-phases/{NN}-*/
    phases_dir = planning / "milestones" / f"{version}-phases"
    if phases_dir.exists():
        for d in phases_dir.iterdir():
            if d.is_dir() and re.match(rf"^0?{re.escape(phase_num)}-", d.name):
                return d

    # Try phases/{NN}-*/ (flat pattern)
    phases_dir = planning / "phases"
    if phases_dir.exists():
        for d in phases_dir.iterdir():
            if d.is_dir() and re.match(rf"^0?{re.escape(phase_num)}-", d.name):
                return d

    return None


def find_plan_file(repo, version, phase_num, plan_num):
    """Find PLAN.md file for a specific plan."""
    phase_dir = find_phase_dir(repo, version, phase_num)
    if not phase_dir:
        return None
    # Pattern: {NN}-{PP}-PLAN.md
    for f in phase_dir.glob("*-PLAN.md"):
        m = re.match(rf"^0?{re.escape(phase_num)}-0?{re.escape(plan_num)}-PLAN\.md$", f.name)
        if m:
            return f
    # Fallback: try any plan matching the plan number
    for f in phase_dir.glob(f"*-{plan_num.zfill(2)}-PLAN.md"):
        return f
    return None


# --- Content Extraction ---

def extract_epic_description(repo, version):
    """Extract Epic description from ROADMAP.md and MILESTONES.md."""
    roadmap = find_roadmap(repo, version)
    if not roadmap:
        return None

    content = roadmap.read_text(encoding="utf-8")

    # Extract milestone name from main ROADMAP
    main_roadmap = find_planning_root(repo) / "ROADMAP.md"
    milestone_goal = ""
    if main_roadmap.exists():
        main_content = main_roadmap.read_text(encoding="utf-8")
        # Look for: **v2.0 Onboarding Flow** or similar
        m = re.search(rf"\*\*{re.escape(version)}\s+(.+?)\*\*\s*--\s*Phases?\s*([\d-]+)", main_content)
        if m:
            milestone_goal = m.group(1).strip()

    # Count phases from the milestone ROADMAP
    phases = re.findall(r"\[([x ])\]\s+Phase\s+(\d+(?:\.\d+)?):?\s+(.+?)(?:\s+\(|$)", content)
    total = len(phases)
    done = sum(1 for p in phases if p[0] == "x")
    phase_range = f"Phases {phases[0][1]}--{phases[-1][1]}" if phases else ""

    # Phase list
    phase_list = []
    for checked, num, name in phases:
        status = "done" if checked == "x" else "pending"
        clean_name = re.sub(r"\s*\(\d+/\d+ plans?\).*$", "", name).strip()
        phase_list.append(f"Phase {num}: {clean_name} [{status}]")

    # Try MILESTONES.md for stats
    milestones_file = find_planning_root(repo) / "MILESTONES.md"
    stats_text = ""
    if milestones_file.exists():
        ms_content = milestones_file.read_text(encoding="utf-8")
        # Find section for this version
        section_re = rf"##\s+{re.escape(version)}.*?\n(.*?)(?=\n##\s|\Z)"
        section = re.search(section_re, ms_content, re.DOTALL)
        if section:
            stats_text = section.group(1).strip()[:500]

    return {
        "goal": milestone_goal,
        "phase_range": phase_range,
        "total_phases": total,
        "done_phases": done,
        "phases": phase_list,
        "stats": stats_text,
    }


def extract_feature_description(repo, version, phase_slug):
    """Extract Feature description from milestone ROADMAP phase section."""
    roadmap = find_roadmap(repo, version)
    if not roadmap:
        return None

    content = roadmap.read_text(encoding="utf-8")
    phase_num = re.match(r"^(\d+(?:\.\d+)?)", phase_slug)
    if not phase_num:
        return None
    phase_num = phase_num.group(1)

    # Find phase section: ### Phase N: Name
    section_re = rf"###\s+Phase\s+{re.escape(phase_num)}:?\s+(.+?)(?=\n###\s|\n</details>|\Z)"
    section = re.search(section_re, content, re.DOTALL)

    result = {"phase_num": phase_num, "phase_name": "", "goal": "", "requirements": [],
              "success_criteria": [], "plans": [], "depends_on": ""}

    if not section:
        # Fallback: try to find in the checklist format
        checklist_re = rf"Phase\s+{re.escape(phase_num)}:?\s+(.+?)(?:\s+\(|\s+--)"
        m = re.search(checklist_re, content)
        if m:
            result["phase_name"] = m.group(1).strip()
        return result

    section_text = section.group(0)
    name_match = re.match(r"###\s+Phase\s+\S+:?\s+(.+)", section_text.split("\n")[0])
    if name_match:
        result["phase_name"] = name_match.group(1).strip()

    # Extract Goal
    goal_match = re.search(r"\*\*Goal\*\*:\s*(.+?)(?:\n\n|\n\*\*)", section_text, re.DOTALL)
    if goal_match:
        result["goal"] = goal_match.group(1).strip()

    # Extract Requirements
    req_match = re.search(r"\*\*Requirements?\*\*:\s*(.+?)(?:\n\n|\n\*\*)", section_text, re.DOTALL)
    if req_match:
        reqs = re.findall(r"[A-Z]+-\d+", req_match.group(1))
        result["requirements"] = reqs

    # Extract Success Criteria
    sc_match = re.search(r"\*\*Success Criteria\*\*.*?:\s*\n((?:\s*\d+\..*\n?)+)", section_text)
    if sc_match:
        criteria = [line.strip() for line in sc_match.group(1).strip().split("\n") if line.strip()]
        result["success_criteria"] = criteria[:10]

    # Extract Plans
    plans_match = re.search(r"\*\*Plans?\*\*:\s*\n?((?:\s*-.*\n?)+)", section_text)
    if plans_match:
        plans = [line.strip().lstrip("- ") for line in plans_match.group(1).strip().split("\n") if line.strip()]
        result["plans"] = plans[:10]

    # Extract Dependencies
    dep_match = re.search(r"\*\*Depends?\s+on\*\*:\s*(.+)", section_text)
    if dep_match:
        result["depends_on"] = dep_match.group(1).strip()

    return result


def extract_subtask_description(repo, version, phase_num, plan_num):
    """Extract Subtask description from PLAN.md."""
    plan_file = find_plan_file(repo, version, phase_num, plan_num)
    if not plan_file:
        return None

    content = plan_file.read_text(encoding="utf-8")

    result = {"objective": "", "requirements": [], "truths": [], "files": [], "wave": ""}

    # Parse YAML frontmatter
    fm_match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if fm_match:
        fm = fm_match.group(1)

        # Wave
        wave_m = re.search(r"^wave:\s*(\S+)", fm, re.MULTILINE)
        if wave_m:
            result["wave"] = wave_m.group(1)

        # Requirements
        reqs = re.findall(r"^\s+-\s+([A-Z]+-\d+)", fm, re.MULTILINE)
        result["requirements"] = reqs

        # Must-have truths
        in_truths = False
        for line in fm.split("\n"):
            if "truths:" in line:
                in_truths = True
                continue
            if in_truths:
                m = re.match(r'\s+-\s+"(.+)"', line)
                if m:
                    result["truths"].append(m.group(1))
                elif not line.startswith(" ") and line.strip():
                    in_truths = False

        # Files modified (first 15)
        in_files = False
        for line in fm.split("\n"):
            if "files_modified:" in line:
                in_files = True
                continue
            if in_files:
                m = re.match(r"\s+-\s+(.+)", line)
                if m:
                    result["files"].append(m.group(1).strip())
                elif not line.startswith(" ") and line.strip():
                    in_files = False
        result["files"] = result["files"][:15]

    # Extract objective from <objective> tag
    obj_match = re.search(r"<objective>\s*([\s\S]*?)\s*</objective>", content)
    if obj_match:
        result["objective"] = obj_match.group(1).strip().split("\n")[0]

    return result


# --- ADF Builder ---

def adf_text(text):
    return {"type": "text", "text": text}


def adf_heading(text, level=2):
    return {
        "type": "heading",
        "attrs": {"level": level},
        "content": [adf_text(text)],
    }


def adf_paragraph(text):
    return {
        "type": "paragraph",
        "content": [adf_text(text)],
    }


def adf_bullet_list(items):
    return {
        "type": "bulletList",
        "content": [
            {
                "type": "listItem",
                "content": [adf_paragraph(item)],
            }
            for item in items
            if item
        ],
    }


def adf_doc(blocks):
    """Build ADF document, filtering empty blocks."""
    return {
        "type": "doc",
        "version": 1,
        "content": [b for b in blocks if b],
    }


def build_epic_adf(data):
    if not data:
        return None
    blocks = []
    if data.get("goal"):
        blocks.append(adf_heading("Goal"))
        blocks.append(adf_paragraph(data["goal"]))
    if data.get("phase_range"):
        blocks.append(adf_heading("Phases"))
        blocks.append(adf_paragraph(f"{data['phase_range']} -- {data['done_phases']}/{data['total_phases']} complete"))
    if data.get("phases"):
        blocks.append(adf_bullet_list(data["phases"]))
    if data.get("stats"):
        blocks.append(adf_heading("Stats"))
        blocks.append(adf_paragraph(data["stats"][:300]))
    return adf_doc(blocks) if blocks else None


def build_feature_adf(data):
    if not data:
        return None
    blocks = []
    if data.get("goal"):
        blocks.append(adf_heading("Goal"))
        blocks.append(adf_paragraph(data["goal"]))
    if data.get("requirements"):
        blocks.append(adf_heading("Requirements"))
        blocks.append(adf_bullet_list(data["requirements"]))
    if data.get("success_criteria"):
        blocks.append(adf_heading("Success Criteria"))
        blocks.append(adf_bullet_list(data["success_criteria"]))
    if data.get("plans"):
        blocks.append(adf_heading("Plans"))
        blocks.append(adf_bullet_list(data["plans"]))
    if data.get("depends_on"):
        blocks.append(adf_heading("Dependencies"))
        blocks.append(adf_paragraph(data["depends_on"]))
    return adf_doc(blocks) if blocks else None


def build_subtask_adf(data):
    if not data:
        return None
    blocks = []
    if data.get("objective"):
        blocks.append(adf_heading("Objective"))
        blocks.append(adf_paragraph(data["objective"]))
    if data.get("requirements"):
        blocks.append(adf_heading("Requirements"))
        blocks.append(adf_bullet_list(data["requirements"]))
    if data.get("truths"):
        blocks.append(adf_heading("Must-Haves"))
        blocks.append(adf_bullet_list(data["truths"]))
    if data.get("files"):
        blocks.append(adf_heading("Files Modified"))
        blocks.append(adf_bullet_list(data["files"]))
    if data.get("wave"):
        blocks.append(adf_paragraph(f"Wave: {data['wave']}"))
    return adf_doc(blocks) if blocks else None


# --- Jira API ---

def update_issue_description(jira_key, adf_description):
    """PUT /rest/api/3/issue/{key} with description field."""
    url = f"{JIRA_HOST}/rest/api/3/issue/{jira_key}"
    payload = json.dumps({"fields": {"description": adf_description}}).encode("utf-8")

    req = urllib.request.Request(url, data=payload, method="PUT")
    req.add_header("Authorization", auth_header())
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:200]
        return f"ERROR {e.code}: {body}"


# --- Main ---

def main():
    if not JIRA_HOST or not JIRA_USERNAME or not JIRA_API_TOKEN:
        print("ERROR: Set JIRA_HOST, JIRA_USERNAME, JIRA_API_TOKEN env vars")
        sys.exit(1)

    mapping = json.loads(MAPPING_PATH.read_text(encoding="utf-8"))
    print(f"Loaded {len(mapping)} cards from jira-mapping.json")
    if DRY_RUN:
        print("=== DRY RUN MODE ===\n")

    stats = {"epic": 0, "feature": 0, "subtask": 0, "skipped": 0, "errors": 0}

    for card_id, jira_key in sorted(mapping.items()):
        ctype = card_type(card_id)
        parsed = parse_card_id(card_id)
        adf = None

        if ctype == "epic":
            data = extract_epic_description(parsed["repo"], parsed["version"])
            adf = build_epic_adf(data)
        elif ctype == "feature":
            data = extract_feature_description(parsed["repo"], parsed["version"], parsed["phase_slug"])
            adf = build_feature_adf(data)
        elif ctype == "subtask":
            data = extract_subtask_description(parsed["repo"], parsed["version"],
                                                parsed["phase_num"], parsed["plan_num"])
            adf = build_subtask_adf(data)

        if not adf or not adf.get("content"):
            stats["skipped"] += 1
            if DRY_RUN:
                print(f"  SKIP {jira_key} ({ctype}) {card_id} -- no content found")
            continue

        content_count = len(adf["content"])

        if DRY_RUN:
            print(f"  UPDATE {jira_key} ({ctype}) {card_id} -- {content_count} ADF blocks")
            stats[ctype] += 1
            continue

        # Execute update
        result = update_issue_description(jira_key, adf)
        if result == 204:
            stats[ctype] += 1
            print(f"  OK {jira_key} ({ctype}) {card_id}")
        else:
            stats["errors"] += 1
            print(f"  FAIL {jira_key} ({ctype}) {card_id}: {result}")

        time.sleep(0.2)  # Rate limit

    print(f"\n{'DRY RUN ' if DRY_RUN else ''}Summary:")
    print(f"  Epics updated: {stats['epic']}")
    print(f"  Features updated: {stats['feature']}")
    print(f"  Subtasks updated: {stats['subtask']}")
    print(f"  Skipped (no content): {stats['skipped']}")
    print(f"  Errors: {stats['errors']}")
    print(f"  Total: {stats['epic'] + stats['feature'] + stats['subtask'] + stats['skipped']}")


if __name__ == "__main__":
    main()
