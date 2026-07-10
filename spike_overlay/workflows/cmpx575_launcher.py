"""Durable, typed Centaur front-door for cmpx575 fleet launcher shapes."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "cmpx575_launcher"

_TERMINAL_FLEET_STATES = {"done", "failed", "cancelled"}
_POLL_SECONDS = 5
_MAX_POLLS = 600


@dataclass
class Input:
    objective: str
    version: int = 1
    shape: str = "experiment"
    slug: str = ""
    requested_by: str = "centaur"
    source: dict[str, Any] = field(default_factory=dict)
    idempotency_key: str = ""


def _validate(inp: Input) -> None:
    if inp.version != 1:
        raise ValueError("version must be 1")
    if inp.shape not in {
        "experiment",
        "knowledge-map-ingest",
        "oncall-digest",
        "slack-inbox-to-board",
        "quota-scheduler",
    }:
        raise ValueError("shape is not allowlisted")
    if not inp.objective.strip() or len(inp.objective.strip()) > 2000:
        raise ValueError("objective must contain 1-2000 characters")
    if not inp.idempotency_key.strip() or len(inp.idempotency_key) > 512:
        raise ValueError("idempotency_key must contain 1-512 characters")
    for key in ("team_id", "channel_id", "thread_ts"):
        if not isinstance(inp.source.get(key), str) or not inp.source[key].strip():
            raise ValueError(f"source.{key} is required")


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    _validate(inp)
    launch = await ctx.step(
        "launch",
        lambda: ctx.call_tool(
            "experiment_launcher",
            "launch",
            {
                "version": inp.version,
                "shape": inp.shape,
                "objective": inp.objective,
                "slug": inp.slug,
                "requested_by": inp.requested_by,
                "source": inp.source,
                "idempotency_key": inp.idempotency_key,
            },
        ),
        step_kind="tool_call",
    )
    if not isinstance(launch, dict):
        raise RuntimeError("experiment_launcher.launch returned a non-object")
    fleet_job_id = str(launch.get("fleet_job_id") or "")
    launcher_run_id = str(launch.get("launcher_run_id") or "")
    if not fleet_job_id or not launcher_run_id:
        raise RuntimeError("experiment_launcher.launch returned no run or fleet job id")

    ctx.log(
        "cmpx575_launcher_dispatched",
        launcher_run_id=launcher_run_id,
        fleet_job_id=fleet_job_id,
        shape=inp.shape,
    )
    fleet_state = "unknown"
    for attempt in range(_MAX_POLLS):
        status = await ctx.step(
            f"fleet-status-{attempt:04d}",
            lambda: ctx.call_tool(
                "fleet_dispatch",
                "status",
                {"job_id": fleet_job_id},
            ),
            step_kind="tool_call",
        )
        if not isinstance(status, dict):
            raise RuntimeError("fleet_dispatch.status returned a non-object")
        fleet_state = str(status.get("state") or "unknown")
        if fleet_state in _TERMINAL_FLEET_STATES:
            break
        await ctx.sleep(f"fleet-poll-{attempt:04d}", _POLL_SECONDS)
    else:
        fleet_state = "timeout"

    terminal_state = "completed" if fleet_state == "done" else "failed"
    ctx.log(
        "cmpx575_launcher_terminal",
        launcher_run_id=launcher_run_id,
        fleet_job_id=fleet_job_id,
        fleet_state=fleet_state,
        terminal_state=terminal_state,
    )
    return {
        "launcher_run_id": launcher_run_id,
        "fleet_job_id": fleet_job_id,
        "shape": str(launch.get("shape") or inp.shape),
        "worker": str(launch.get("worker") or ""),
        "fleet_state": fleet_state,
        "terminal_state": terminal_state,
    }
