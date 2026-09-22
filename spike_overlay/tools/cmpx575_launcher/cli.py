"""CLI for the typed cmpx575 launcher adapter."""

from __future__ import annotations

from dotenv import load_dotenv

load_dotenv()

import json
from typing import Annotated

import typer

from .client import _client

app = typer.Typer(
    name="cmpx575-launcher",
    help="Launch normalized cmpx575 orchestration shapes through the fleet gateway.",
)


@app.callback()
def main() -> None:
    """cmpx575 typed launcher."""


@app.command("launch")
def launch(
    objective: Annotated[str, typer.Argument(help="Concrete objective for the run.")],
    slug: Annotated[str, typer.Option("--slug", help="Short run slug.")] = "",
    requested_by: Annotated[
        str, typer.Option("--requested-by", help="Requester label.")
    ] = "centaur",
    idempotency_key: Annotated[
        str, typer.Option("--idempotency-key", help="Stable caller idempotency key.")
    ] = "cli",
) -> None:
    """Launch the fixed General-experiment shape."""
    result = _client().launch(
        version=1,
        shape="experiment",
        objective=objective,
        slug=slug,
        requested_by=requested_by,
        source={},
        idempotency_key=idempotency_key,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    app()
