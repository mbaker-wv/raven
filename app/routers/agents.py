import json
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas, tools, vuln_report
from ..ai_client import call_ai, call_ai_with_tools
from ..database import get_db
from .reports import build_digest, digest_to_text

router = APIRouter(prefix="/api/agents", tags=["agents"])

MAX_RUN_HISTORY = 3


def _check_run_after(db: Session, run_after_agent_id: int | None, agent_id: int | None) -> None:
    if run_after_agent_id is None:
        return
    if run_after_agent_id == agent_id:
        raise HTTPException(400, "An agent can't run after itself.")
    if not db.get(models.Agent, run_after_agent_id):
        raise HTTPException(400, "The agent selected in 'Runs after' doesn't exist.")


@router.post("", response_model=schemas.AgentOut)
def create_agent(agent: schemas.AgentCreate, db: Session = Depends(get_db)):
    _check_run_after(db, agent.run_after_agent_id, None)
    db_agent = models.Agent(**agent.model_dump())
    db.add(db_agent)
    db.commit()
    db.refresh(db_agent)
    return db_agent


@router.get("", response_model=list[schemas.AgentOut])
def list_agents(db: Session = Depends(get_db)):
    return db.query(models.Agent).order_by(models.Agent.created_at.desc()).all()


@router.get("/{agent_id}", response_model=schemas.AgentOut)
def get_agent(agent_id: int, db: Session = Depends(get_db)):
    agent = db.get(models.Agent, agent_id)
    if not agent:
        raise HTTPException(404, "Agent not found")
    return agent


@router.put("/{agent_id}", response_model=schemas.AgentOut)
def update_agent(agent_id: int, update: schemas.AgentUpdate, db: Session = Depends(get_db)):
    agent = db.get(models.Agent, agent_id)
    if not agent:
        raise HTTPException(404, "Agent not found")
    updates = update.model_dump(exclude_unset=True)
    if "run_after_agent_id" in updates:
        _check_run_after(db, updates["run_after_agent_id"], agent_id)
    for key, value in updates.items():
        setattr(agent, key, value)
    db.commit()
    db.refresh(agent)
    return agent


@router.delete("/{agent_id}", status_code=204)
def delete_agent(agent_id: int, db: Session = Depends(get_db)):
    agent = db.get(models.Agent, agent_id)
    if not agent:
        raise HTTPException(404, "Agent not found")
    db.query(models.AgentRun).filter(models.AgentRun.agent_id == agent_id).delete()
    db.query(models.Agent).filter(models.Agent.run_after_agent_id == agent_id).update({"run_after_agent_id": None})
    db.delete(agent)
    db.commit()


def _trim_run_history(db: Session, agent_id: int) -> None:
    # Tie-break on id, not just created_at — runs created in the same wall-clock second
    # (timestamp resolution, not realistic given LLM latency, but seen under test) would
    # otherwise sort arbitrarily instead of by actual insertion order.
    keep_ids = (
        db.query(models.AgentRun.id)
        .filter(models.AgentRun.agent_id == agent_id)
        .order_by(models.AgentRun.created_at.desc(), models.AgentRun.id.desc())
        .limit(MAX_RUN_HISTORY)
        .subquery()
    )
    deleted = (
        db.query(models.AgentRun)
        .filter(models.AgentRun.agent_id == agent_id, models.AgentRun.id.notin_(db.query(keep_ids.c.id)))
        .delete(synchronize_session=False)
    )
    if deleted:
        db.commit()


def _execute_agent(db: Session, agent: models.Agent, start: date | None, end: date | None, visited: set[int]) -> models.AgentRun:
    if agent.id in visited:
        raise HTTPException(400, f"Chain cycle detected at agent '{agent.name}'.")
    visited = visited | {agent.id}

    prompt_parts = [agent.system_prompt]

    settings = db.query(models.Settings).first()
    byline = None
    if settings and (settings.profile_name or settings.profile_role):
        byline = (
            f"{settings.profile_name}, {settings.profile_role}"
            if settings.profile_name and settings.profile_role
            else (settings.profile_name or settings.profile_role)
        )
        prompt_parts.append(f"\nUser's name and role, for a byline if the instructions call for one: {byline}")
    if settings and settings.profile_context:
        prompt_parts.append(f"\nContext about the user: {settings.profile_context}")

    if agent.run_after_agent_id:
        upstream = db.get(models.Agent, agent.run_after_agent_id)
        if not upstream:
            raise HTTPException(400, f"Agent '{agent.name}' is chained after a deleted agent.")
        upstream_run = _execute_agent(db, upstream, start, end, visited)
        prompt_parts.append(f"\nOutput from '{upstream.name}':\n{upstream_run.output}")

    ctx_start = ctx_end = None
    vuln_report_data = None
    if agent.context_mode == "digest":
        digest = build_digest(db, start, end)
        ctx_start, ctx_end = date.fromisoformat(digest["start"]), date.fromisoformat(digest["end"])
        prompt_parts.append(f"\n{digest_to_text(digest)}")
    elif agent.context_mode == "vuln_report":
        vuln_report_text, vuln_report_data = vuln_report.build_vuln_context(agent)
        vuln_report_data["prepared_by"] = byline
        vuln_report_data["report_date"] = date.today().isoformat()
        prompt_parts.append(f"\n{vuln_report_text}")
        prompt_parts.append(
            "\nThe report header (prepared by, date, source) and every table above are already shown to the "
            "user separately before your response, in full — don't restate them anywhere in your response, "
            "including as a 'Prepared by' / 'Report date' / 'Source' line further down. Open straight into the "
            "narrative analysis."
        )

    enabled_skills = tools.parse_enabled_skills(agent.enabled_skills)
    use_tools = agent.ai_provider == "claude" and enabled_skills

    if use_tools:
        prompt_parts.append(
            "\nYou have access to tools to create tasks, complete tasks, and log entries in Raven. "
            "Use them when the instructions call for taking action, not just describing what should happen."
        )

    prompt = "\n".join(prompt_parts)

    if use_tools:
        tool_defs = tools.build_tool_definitions(enabled_skills)
        output, tool_call_records = call_ai_with_tools(
            prompt, db, tool_defs, lambda name, args: tools.execute_tool(db, name, args)
        )
    else:
        output = call_ai(prompt, db, provider=agent.ai_provider)
        tool_call_records = []

    run = models.AgentRun(
        agent_id=agent.id,
        output=output,
        tool_calls=json.dumps(tool_call_records) if tool_call_records else None,
        vuln_report_data=json.dumps(vuln_report_data) if vuln_report_data else None,
        context_start=ctx_start,
        context_end=ctx_end,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    _trim_run_history(db, agent.id)
    return run


@router.post("/{agent_id}/run", response_model=schemas.AgentRunOut)
def run_agent(agent_id: int, start: date | None = None, end: date | None = None, db: Session = Depends(get_db)):
    agent = db.get(models.Agent, agent_id)
    if not agent:
        raise HTTPException(404, "Agent not found")
    return _execute_agent(db, agent, start, end, set())


@router.get("/{agent_id}/runs", response_model=list[schemas.AgentRunOut])
def list_agent_runs(agent_id: int, db: Session = Depends(get_db)):
    return (
        db.query(models.AgentRun)
        .filter(models.AgentRun.agent_id == agent_id)
        .order_by(models.AgentRun.created_at.desc())
        .all()
    )


@router.delete("/{agent_id}/runs/{run_id}", status_code=204)
def delete_agent_run(agent_id: int, run_id: int, db: Session = Depends(get_db)):
    run = db.get(models.AgentRun, run_id)
    if not run or run.agent_id != agent_id:
        raise HTTPException(404, "Run not found")
    db.delete(run)
    db.commit()
