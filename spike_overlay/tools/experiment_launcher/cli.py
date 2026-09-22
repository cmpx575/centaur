"""CLI for launching cmpx575 orchestration experiments."""

from __future__ import annotations

from dotenv import load_dotenv

load_dotenv()

import json
from pathlib import Path
from typing import Annotated

import typer

from .client import DEFAULT_REPO_PATH, SHAPES, build_plan

app = typer.Typer(
    name="experiment-launcher",
    help="Generate and launch cmpx575 orchestration run briefs through fleet-dispatch.",
)


def _read_context(context: str | None, context_file: Path | None) -> str:
    parts: list[str] = []
    if context:
        parts.append(context)
    if context_file:
        parts.append(context_file.read_text())
    return "\n\n".join(part.strip() for part in parts if part.strip())


def _plan_from_options(
    shape: str,
    objective: str,
    slug: str | None,
    requested_by: str,
    worker: str | None,
    timeout: int | None,
    repo_path: str,
    context: str | None,
    context_file: Path | None,
) -> dict:
    return build_plan(
        shape=shape,
        objective=objective,
        slug=slug,
        requested_by=requested_by,
        worker=worker,
        timeout=timeout,
        repo_path=repo_path,
        context=_read_context(context, context_file),
    )


@app.callback()
def main() -> None:
    """experiment-launcher CLI."""


@app.command("shapes")
def shapes() -> None:
    """Print available experiment shapes."""
    payload = {
        name: {
            "title": spec["title"],
            "goal": spec["goal"],
            "default_worker": spec["default_worker"],
            "timeout": spec["timeout"],
        }
        for name, spec in SHAPES.items()
    }
    print(json.dumps(payload, indent=2))


@app.command("plan")
def plan(
    shape: Annotated[str, typer.Argument(help="Experiment shape, e.g. experiment or oncall-digest.")],
    objective: Annotated[str, typer.Argument(help="Concrete objective for the run.")],
    slug: Annotated[str | None, typer.Option("--slug", help="Short run slug.")] = None,
    requested_by: Annotated[str, typer.Option("--requested-by", help="Requester label.")] = "centaur",
    worker: Annotated[str | None, typer.Option("--worker", help="Override worker.")] = None,
    timeout: Annotated[int | None, typer.Option("--timeout", help="Worker timeout seconds.")] = None,
    repo_path: Annotated[str, typer.Option("--repo-path", help="Hub repo path on the fleet host.")] = DEFAULT_REPO_PATH,
    context: Annotated[str | None, typer.Option("--context", help="Additional context text.")] = None,
    context_file: Annotated[
        Path | None,
        typer.Option("--context-file", exists=True, dir_okay=False, readable=True, help="Additional context file."),
    ] = None,
) -> None:
    """Generate a launch plan as JSON without dispatching it."""
    print(
        json.dumps(
            _plan_from_options(
                shape,
                objective,
                slug,
                requested_by,
                worker,
                timeout,
                repo_path,
                context,
                context_file,
            ),
            indent=2,
        )
    )


@app.command("render-brief")
def render_brief(
    shape: Annotated[str, typer.Argument(help="Experiment shape.")],
    objective: Annotated[str, typer.Argument(help="Concrete objective for the run.")],
    slug: Annotated[str | None, typer.Option("--slug", help="Short run slug.")] = None,
    requested_by: Annotated[str, typer.Option("--requested-by", help="Requester label.")] = "centaur",
    worker: Annotated[str | None, typer.Option("--worker", help="Override worker.")] = None,
    timeout: Annotated[int | None, typer.Option("--timeout", help="Worker timeout seconds.")] = None,
    repo_path: Annotated[str, typer.Option("--repo-path", help="Hub repo path on the fleet host.")] = DEFAULT_REPO_PATH,
    context: Annotated[str | None, typer.Option("--context", help="Additional context text.")] = None,
    context_file: Annotated[
        Path | None,
        typer.Option("--context-file", exists=True, dir_okay=False, readable=True, help="Additional context file."),
    ] = None,
) -> None:
    """Render only the generated BRIEF.md."""
    launch_plan = _plan_from_options(
        shape,
        objective,
        slug,
        requested_by,
        worker,
        timeout,
        repo_path,
        context,
        context_file,
    )
    print(launch_plan["brief"])


@app.command("launch")
def launch(
    shape: Annotated[str, typer.Argument(help="Experiment shape.")],
    objective: Annotated[str, typer.Argument(help="Concrete objective for the run.")],
    slug: Annotated[str | None, typer.Option("--slug", help="Short run slug.")] = None,
    requested_by: Annotated[str, typer.Option("--requested-by", help="Requester label.")] = "centaur",
    worker: Annotated[str | None, typer.Option("--worker", help="Override worker.")] = None,
    timeout: Annotated[int | None, typer.Option("--timeout", help="Worker timeout seconds.")] = None,
    repo_path: Annotated[str, typer.Option("--repo-path", help="Hub repo path on the fleet host.")] = DEFAULT_REPO_PATH,
    context: Annotated[str | None, typer.Option("--context", help="Additional context text.")] = None,
    context_file: Annotated[
        Path | None,
        typer.Option("--context-file", exists=True, dir_okay=False, readable=True, help="Additional context file."),
    ] = None,
) -> None:
    """Generate a launch plan and dispatch it to the fleet."""
    from .client import _client

    launch_plan = _plan_from_options(
        shape,
        objective,
        slug,
        requested_by,
        worker,
        timeout,
        repo_path,
        context,
        context_file,
    )
    print(json.dumps(_client().dispatch(launch_plan), indent=2))


if __name__ == "__main__":
    app()
