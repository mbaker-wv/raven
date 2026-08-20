import csv
from datetime import date, datetime
from pathlib import Path

from fastapi import HTTPException

from . import models

CRITICAL_AGE_THRESHOLD_DAYS = 15
SEVERE_AGE_THRESHOLD_DAYS = 30
TOP_N = 10

# Columns actually read from the export. Anything else (Solution, Proof, OS version, ...)
# is ignored, so a lean custom Nexpose report parses faster than a full one.
COL_IP = "Asset IP Address"
COL_NAME = "Asset Names"
COL_RISK_SCORE = "Asset Risk Score"
COL_EXPLOIT_COUNT = "Exploit Count"
COL_CVE_IDS = "Vulnerability CVE IDs"
COL_TITLE = "Vulnerability Title"
COL_SEVERITY = "Vulnerability Severity Level"
COL_PUBLISHED = "Vulnerability Published Date"

_DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%Y-%m-%dT%H:%M:%S")


def _parse_date(raw: str | None) -> date | None:
    if not raw:
        return None
    raw = raw.strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).date()
    except ValueError:
        pass
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


def _parse_number(raw: str | None) -> float:
    if not raw:
        return 0.0
    try:
        return float(raw.strip().replace(",", ""))
    except ValueError:
        return 0.0


def _classify_severity(raw: str | None) -> tuple[str, str]:
    """Returns (tier, display_label). Nexpose report templates vary — some put a word
    label ('Critical'/'Severe') in this column, others a numeric CVSS score. Handle both,
    using the standard CVSS bands for the numeric case: Critical 9.0-10.0, Severe/High
    7.0-8.9, Moderate 4.0-6.9, Low 0.1-3.9, Informational 0."""
    raw = (raw or "").strip()
    if not raw:
        return "other", "(no severity)"
    try:
        score = float(raw)
    except ValueError:
        lower = raw.lower()
        if lower == "critical":
            return "critical", raw
        if lower in ("severe", "high"):
            return "severe", raw
        return "other", raw
    if score >= 9.0:
        return "critical", f"Critical ({raw})"
    if score >= 7.0:
        return "severe", f"Severe ({raw})"
    if score >= 4.0:
        return "other", f"Moderate ({raw})"
    if score > 0:
        return "other", f"Low ({raw})"
    return "other", f"Informational ({raw})"


_TIER_RANK = {"critical": 2, "severe": 1, "other": 0}


def _resolve_csv_path(configured_path: str) -> Path:
    path = Path(configured_path).expanduser()
    if path.is_dir():
        candidates = [p for p in path.iterdir() if p.suffix.lower() == ".csv"]
        if not candidates:
            raise HTTPException(400, f"No .csv file found in '{path}'.")
        return max(candidates, key=lambda p: p.stat().st_mtime)
    if path.is_file():
        return path
    raise HTTPException(400, f"Vulnerability report path '{configured_path}' doesn't exist.")


def parse_vuln_report(configured_path: str) -> dict:
    """Streams the Nexpose export and computes the counts/rollups needed for the
    vuln_report context mode. Never loads the file into memory at once, and only reads
    the 8 columns this feature actually uses."""
    if not configured_path:
        raise HTTPException(400, "This agent's context mode is 'Vulnerability report' but no report path is set.")

    resolved_path = _resolve_csv_path(configured_path)

    total_open = 0
    critical_open = 0
    critical_open_over_15d = 0
    severe_open = 0
    severe_open_over_30d = 0
    skipped_rows = 0
    today = date.today()

    # asset_label -> {"risk_score", "finding_count", "critical_count"}
    assets: dict[str, dict] = {}
    # vuln title -> {"finding_count", "assets": set(), "example_cve", "max_severity_tier", "max_severity_label"}
    titles: dict[str, dict] = {}
    # vuln title -> finding_count, tracked separately per tier so leadership sees what's
    # actually driving each severity bucket, not just its raw size.
    critical_title_counts: dict[str, int] = {}
    severe_title_counts: dict[str, int] = {}

    try:
        with open(resolved_path, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            missing = [c for c in (COL_SEVERITY, COL_PUBLISHED) if c not in (reader.fieldnames or [])]
            if missing:
                raise HTTPException(
                    400,
                    f"'{resolved_path.name}' is missing expected column(s): {', '.join(missing)}. "
                    "Check the custom report includes the agreed-on columns.",
                )
            for row in reader:
                total_open += 1
                tier, severity_label = _classify_severity(row.get(COL_SEVERITY))
                title = (row.get(COL_TITLE) or "").strip() or "(untitled finding)"
                published = _parse_date(row.get(COL_PUBLISHED))
                age_days = (today - published).days if published else None

                if age_days is None:
                    skipped_rows += 1
                elif tier == "critical":
                    critical_open += 1
                    critical_title_counts[title] = critical_title_counts.get(title, 0) + 1
                    if age_days > CRITICAL_AGE_THRESHOLD_DAYS:
                        critical_open_over_15d += 1
                elif tier == "severe":
                    severe_open += 1
                    severe_title_counts[title] = severe_title_counts.get(title, 0) + 1
                    if age_days > SEVERE_AGE_THRESHOLD_DAYS:
                        severe_open_over_30d += 1

                name = (row.get(COL_NAME) or "").strip()
                ip = (row.get(COL_IP) or "").strip()
                asset_label = name or ip or "(unknown asset)"
                asset = assets.setdefault(asset_label, {"risk_score": 0.0, "finding_count": 0, "critical_count": 0, "severe_count": 0})
                asset["risk_score"] = max(asset["risk_score"], _parse_number(row.get(COL_RISK_SCORE)))
                asset["finding_count"] += 1
                if tier == "critical":
                    asset["critical_count"] += 1
                elif tier == "severe":
                    asset["severe_count"] += 1

                entry = titles.setdefault(
                    title,
                    {
                        "finding_count": 0,
                        "assets": set(),
                        "example_cve": (row.get(COL_CVE_IDS) or "").strip(),
                        "max_severity_tier": tier,
                        "max_severity_label": severity_label,
                    },
                )
                entry["finding_count"] += 1
                entry["assets"].add(asset_label)
                if _TIER_RANK[tier] > _TIER_RANK[entry["max_severity_tier"]]:
                    entry["max_severity_tier"] = tier
                    entry["max_severity_label"] = severity_label
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(400, f"Couldn't read '{resolved_path}': {exc}") from exc

    # Ranked by critical findings first, then severe, then risk score as a tiebreaker —
    # Nexpose's Asset Risk Score alone doesn't reliably track finding concentration (it can
    # weight asset business-criticality too), so it's not a safe sole ranking signal.
    top_assets = sorted(
        ({"label": label, **data} for label, data in assets.items()),
        key=lambda a: (a["critical_count"], a["severe_count"], a["risk_score"]),
        reverse=True,
    )[:TOP_N]

    top_vuln_titles = sorted(
        (
            {
                "title": title,
                "finding_count": data["finding_count"],
                "asset_count": len(data["assets"]),
                "example_cve": data["example_cve"],
                "max_severity": data["max_severity_label"],
            }
            for title, data in titles.items()
        ),
        key=lambda t: t["asset_count"],
        reverse=True,
    )[:TOP_N]

    top_critical_titles = _top_title_breakdown(critical_title_counts, critical_open)
    top_severe_titles = _top_title_breakdown(severe_title_counts, severe_open)

    file_modified = datetime.fromtimestamp(resolved_path.stat().st_mtime).date().isoformat()

    return {
        "source_path": str(resolved_path),
        "file_modified": file_modified,
        "total_open": total_open,
        "critical_open": critical_open,
        "critical_open_over_15d": critical_open_over_15d,
        "severe_open": severe_open,
        "severe_open_over_30d": severe_open_over_30d,
        "skipped_rows": skipped_rows,
        "top_assets": top_assets,
        "top_vuln_titles": top_vuln_titles,
        "top_critical_titles": top_critical_titles,
        "top_severe_titles": top_severe_titles,
    }


def _top_title_breakdown(counts: dict[str, int], tier_total: int, n: int = 5) -> list[dict]:
    """Top n vulnerability titles within a severity tier, by finding count, so leadership
    sees what's actually driving a number like '30,922 open Critical' instead of just the total."""
    top = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:n]
    return [{"title": title, "finding_count": count, "pct_of_tier": _pct(count, tier_total)} for title, count in top]


def _pct(numerator: int, denominator: int) -> float:
    return round((numerator / denominator) * 100, 1) if denominator else 0.0


def _format_report_text(result: dict, previous: dict | None) -> str:
    critical_pct = _pct(result["critical_open_over_15d"], result["critical_open"])
    severe_pct = _pct(result["severe_open_over_30d"], result["severe_open"])

    lines = [
        f"Vulnerability report status (parsed from {result['source_path']}):",
        f"- Critical: {result['critical_open']} open, {result['critical_open_over_15d']} open more than {CRITICAL_AGE_THRESHOLD_DAYS} days ({critical_pct}%)",
        f"- Severe: {result['severe_open']} open, {result['severe_open_over_30d']} open more than {SEVERE_AGE_THRESHOLD_DAYS} days ({severe_pct}%)",
        f"- Total open findings: {result['total_open']}",
    ]
    if previous:
        delta = result["total_open"] - previous["total_open"]
        sign = "+" if delta >= 0 else ""
        lines.append(
            f"- Backlog vs previous report ({Path(previous['source_path']).name}, {previous['file_modified']}): {sign}{delta} "
            f"(was {previous['total_open']}, critical was {previous['critical_open']}, severe was {previous['severe_open']})"
        )
    else:
        lines.append("- No previous report file given, so no backlog trend to compare against.")
    if result["skipped_rows"]:
        lines.append(
            f"- {result['skipped_rows']} row(s) skipped from the age calculations: missing or unparseable "
            f"'{COL_PUBLISHED}'."
        )

    if result["top_critical_titles"]:
        header_word = "finding" if result["critical_open"] == 1 else "findings"
        lines.append(f"\nWhat's driving the Critical backlog ({result['critical_open']} open {header_word}):")
        for i, t in enumerate(result["top_critical_titles"], 1):
            finding_word = "finding" if t["finding_count"] == 1 else "findings"
            lines.append(f"{i}. \"{t['title']}\" — {t['finding_count']} {finding_word} ({t['pct_of_tier']}% of all open Critical findings)")

    if result["top_severe_titles"]:
        header_word = "finding" if result["severe_open"] == 1 else "findings"
        lines.append(f"\nWhat's driving the Severe backlog ({result['severe_open']} open {header_word}):")
        for i, t in enumerate(result["top_severe_titles"], 1):
            finding_word = "finding" if t["finding_count"] == 1 else "findings"
            lines.append(f"{i}. \"{t['title']}\" — {t['finding_count']} {finding_word} ({t['pct_of_tier']}% of all open Severe findings)")

    if result["top_assets"]:
        lines.append("\nSystems to prioritize (ranked by critical findings, then severe, then risk score):")
        for i, a in enumerate(result["top_assets"], 1):
            finding_word = "finding" if a["finding_count"] == 1 else "findings"
            lines.append(
                f"{i}. {a['label']} — {a['critical_count']} critical, {a['severe_count']} severe, {a['finding_count']} open {finding_word} "
                f"total (risk score {a['risk_score']:g})"
            )

    if result["top_vuln_titles"]:
        lines.append("\nVulnerabilities affecting the most systems (fixing one closes the most findings at once):")
        for i, t in enumerate(result["top_vuln_titles"], 1):
            finding_word = "finding" if t["finding_count"] == 1 else "findings"
            system_word = "system" if t["asset_count"] == 1 else "systems"
            lines.append(
                f"{i}. \"{t['title']}\" ({t['example_cve'] or 'no CVE listed'}) — {t['finding_count']} {finding_word} across "
                f"{t['asset_count']} {system_word}, max severity {t['max_severity']}"
            )

    return "\n".join(lines)


def _build_table_data(result: dict, previous: dict | None) -> dict:
    """Structured payload for the UI to render as real tables — deterministic, so it's
    accurate regardless of how the agent's own narrative chooses to summarize it."""
    backlog = None
    if previous:
        backlog = {
            "previous_source": Path(previous["source_path"]).name,
            "previous_modified": previous["file_modified"],
            "previous_total": previous["total_open"],
            "previous_critical": previous["critical_open"],
            "previous_severe": previous["severe_open"],
            "delta_total": result["total_open"] - previous["total_open"],
            "delta_critical": result["critical_open"] - previous["critical_open"],
            "delta_severe": result["severe_open"] - previous["severe_open"],
        }
    return {
        "source_path": result["source_path"],
        "file_modified": result["file_modified"],
        "total_open": result["total_open"],
        "critical_open": result["critical_open"],
        "critical_open_over_15d": result["critical_open_over_15d"],
        "critical_pct": _pct(result["critical_open_over_15d"], result["critical_open"]),
        "severe_open": result["severe_open"],
        "severe_open_over_30d": result["severe_open_over_30d"],
        "severe_pct": _pct(result["severe_open_over_30d"], result["severe_open"]),
        "skipped_rows": result["skipped_rows"],
        "backlog": backlog,
        "top_critical_titles": result["top_critical_titles"],
        "top_severe_titles": result["top_severe_titles"],
        "top_assets": result["top_assets"],
    }


def build_vuln_context(agent: models.Agent) -> tuple[str, dict]:
    """Parses the agent's current report (and its optional previous report for a backlog
    diff) and returns (prompt_text, table_data): prompt_text is appended to the agent's
    prompt, table_data is stored on the run for the UI to render as real tables."""
    result = parse_vuln_report(agent.vuln_report_path)
    previous = parse_vuln_report(agent.vuln_report_previous_path) if agent.vuln_report_previous_path else None

    text = _format_report_text(result, previous)
    table_data = _build_table_data(result, previous)
    return text, table_data
