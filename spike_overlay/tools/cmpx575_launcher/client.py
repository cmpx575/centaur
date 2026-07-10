"""Experiment Launcher for cmpx575 orchestration runs.

The tool generates a run brief/state packet and dispatches a fleet worker to
create the run folder in the hub repo, then execute the brief. It deliberately
uses the already-proven fleet-dispatch gateway instead of trying to write the
repo from the Centaur sandbox.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
from typing import Any
from urllib.parse import quote, urlparse

import httpx

AUTH_RELAY_HOST = "fleet-dispatch-auth-relay.spike-centaur.svc.cluster.local"
DEFAULT_BASE_URL = f"http://{AUTH_RELAY_HOST}:8799"
DEFAULT_REPO_PATH = "/Users/nipunsharma/github.com/cmpx575/nipun-grokbuild-hermes-test"
DEFAULT_TIMEOUT = 1800
_TERMINAL_STATES = {"done", "failed", "cancelled"}


SHAPES: dict[str, dict[str, Any]] = {
    "experiment": {
        "title": "Experiment Launcher",
        "default_worker": "codex",
        "timeout": 2400,
        "goal": "Launch a scoped orchestration experiment with a durable run folder.",
        "steps": [
            "Clarify the experiment objective and success gate from the brief.",
            "Create the run folder, state file, and launch metadata before doing deeper work.",
            "Dispatch or perform the smallest useful first slice, then record evidence.",
            "Write RETURN.md with outcome, verification, learnings, and next gates.",
        ],
    },
    "knowledge-map-ingest": {
        "title": "Knowledge Map Ingest",
        "default_worker": "codex",
        "timeout": 2400,
        "goal": "Turn supplied material into safe knowledge-map proposals or field signals.",
        "steps": [
            "Identify the target map, source material, and whether the input contains secrets or private data.",
            "Secret-scan raw text before proposing storage or embeddings.",
            "Draft an append-only field-signal or map proposal under .cmpx575/knowledge-maps/proposals/.",
            "Keep state-doc promotion human-gated; do not silently rewrite durable maps.",
            "Write a concise map diff and promotion recommendation.",
        ],
    },
    "oncall-digest": {
        "title": "Oncall / Infra Digest",
        "default_worker": "grok",
        "timeout": 1800,
        "goal": "Produce a read-only health digest for Centaur, spikes, fleet, and repo run state.",
        "steps": [
            "Read PROJECTS.md for expected active themes and known gates.",
            "Check live cluster state where available: Centaur namespace, spike namespaces, pods, HTTPRoutes.",
            "Check fleet/job health with available local wrappers or remote commands; label any unavailable checks.",
            "Look for stale or failed run folders and summarize only actionable issues.",
            "Write a digest with severity, evidence, and owner-facing next steps.",
        ],
    },
    "slack-inbox-to-board": {
        "title": "Slack Inbox to Board",
        "default_worker": "codex",
        "timeout": 2400,
        "goal": "Convert Slack/self-DM captures into clarified board items, handoffs, or run briefs.",
        "steps": [
            "Inspect existing .cmpx575/slack-dm artifacts before proposing a new workflow.",
            "Separate archive refresh, thread-reply coverage, and clarification review.",
            "Route each candidate item to PROJECTS.md, a run brief, a handoff, or a discard bucket.",
            "Prefer small-batch clarification questions over dumping a large ambiguous backlog.",
            "Write proposed board/handoff updates without claiming canonical Slack completeness unless live export succeeded.",
        ],
    },
    "quota-scheduler": {
        "title": "Subscription Quota Scheduler",
        "default_worker": "grok",
        "timeout": 1200,
        "goal": "Use subscription usage signals to decide what work to queue, defer, or alert on.",
        "steps": [
            "Run narrow usage checks such as codexbar usage --provider codex --format json when available.",
            "Do not expose cookies, tokens, or provider credentials in logs or Slack.",
            "Compare usage windows with queued low-risk experiments from PROJECTS.md and run folders.",
            "Recommend queue/defer/alert actions with conservative thresholds.",
            "Write a machine-readable queue suggestion that another workflow can consume later.",
        ],
    },
}


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC).replace(microsecond=0)


def _ca_bundle() -> str | None:
    for var in ("REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "SSL_CERT_FILE"):
        val = os.environ.get(var)  # noqa: TID251
        if val and os.path.exists(val):
            return val
    fallback = "/firewall-certs/ca-cert.pem"
    if os.path.exists(fallback):
        return fallback
    return None


def _explicit_proxy() -> str | None:
    """Force the in-cluster fleet relay through iron-proxy for token swap."""
    enabled = os.getenv("FLEET_DISPATCH_FORCE_PROXY", "").strip().lower()  # noqa: TID251
    if enabled not in {"1", "true", "yes", "on"}:
        return None
    return os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY")  # noqa: TID251


def _transport_policy(base_url: str) -> tuple[str | None, bool]:
    """Keep the credential-bearing spike relay off all ambient proxies."""
    if urlparse(base_url).hostname == AUTH_RELAY_HOST:
        return None, False
    proxy = _explicit_proxy()
    return proxy, proxy is None


def _secret(name: str, default: str) -> str:
    try:
        from centaur_sdk import secret as centaur_secret
    except ModuleNotFoundError:
        return os.getenv(name, default)
    return centaur_secret(name, default)


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = value.strip("-")
    return value or "experiment"


def normalize_shape(shape: str) -> str:
    shape = slugify(shape)
    aliases = {
        "7": "experiment",
        "4": "knowledge-map-ingest",
        "5": "oncall-digest",
        "8": "slack-inbox-to-board",
        "10": "quota-scheduler",
        "launcher": "experiment",
        "digest": "oncall-digest",
        "inbox": "slack-inbox-to-board",
        "knowledge": "knowledge-map-ingest",
        "quota": "quota-scheduler",
    }
    shape = aliases.get(shape, shape)
    if shape not in SHAPES:
        allowed = ", ".join(sorted(SHAPES))
        raise ValueError(f"unknown shape {shape!r}; expected one of: {allowed}")
    return shape


def _run_id(shape: str, slug: str, now: dt.datetime) -> str:
    return f"{now:%Y-%m-%d}_{shape}-{slugify(slug)}"


def _brief_markdown(plan: dict[str, Any]) -> str:
    shape_spec = SHAPES[plan["shape"]]
    steps = "\n".join(f"{idx}. {step}" for idx, step in enumerate(shape_spec["steps"], start=1))
    context = plan.get("context", "").strip()
    context_block = context if context else "(none supplied)"
    return f"""# BRIEF - {plan["run_id"]}

## Who You Are

You are the fleet worker bootstrapping and executing a cmpx575 orchestration run launched from Centaur.

## Objective

{plan["objective"]}

## Shape

- Shape: `{plan["shape"]}` ({shape_spec["title"]})
- Goal: {shape_spec["goal"]}
- Requested by: {plan["requested_by"]}
- Preferred worker: `{plan["worker"]}`
- Timeout seconds: `{plan["timeout"]}`

## Run Contract

1. Work in `{plan["repo_path"]}`.
2. Create `.cmpx575/the-garage/runs/{plan["run_id"]}/` if it does not exist.
3. Write this brief to `BRIEF.md` in that run folder.
4. Write `state.json` immediately with `status:"starting"`, `phase:"bootstrap"`, a one-line note, and UTC `updated_at`.
5. Keep `state.json` current at each milestone.
6. Finish with `RETURN.md`: outcome, verification, what changed, open gates, and next steps.
7. Do not push to origin, expose secrets, or touch unrelated dirty work unless explicitly required by the objective.

## Execution Steps

{steps}

## Context

{context_block}

## Verification Expectations

- Prefer live checks over stale docs when the task concerns runtime state.
- Label any unavailable checks plainly.
- Keep generated artifacts in the run folder or in the repo-native location requested by the objective.
"""


def build_plan(
    *,
    shape: str,
    objective: str,
    slug: str | None = None,
    requested_by: str = "centaur",
    worker: str | None = None,
    timeout: int | None = None,
    repo_path: str = DEFAULT_REPO_PATH,
    context: str = "",
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    shape = normalize_shape(shape)
    shape_spec = SHAPES[shape]
    now = now or utc_now()
    clean_slug = slugify(slug or objective[:60])
    run_id = _run_id(shape, clean_slug, now)
    worker = worker or shape_spec["default_worker"]
    timeout = timeout or int(shape_spec.get("timeout") or DEFAULT_TIMEOUT)
    plan: dict[str, Any] = {
        "run_id": run_id,
        "shape": shape,
        "title": shape_spec["title"],
        "objective": objective.strip(),
        "slug": clean_slug,
        "requested_by": requested_by,
        "worker": worker,
        "timeout": timeout,
        "repo_path": repo_path,
        "context": context,
        "created_at": now.isoformat().replace("+00:00", "Z"),
    }
    plan["brief"] = _brief_markdown(plan)
    plan["state"] = {
        "status": "planned",
        "phase": "generated",
        "note": f"{shape} run generated by experiment-launcher; not yet dispatched.",
        "updated_at": plan["created_at"],
    }
    plan["launch"] = {
        "tool": "experiment-launcher",
        "shape": shape,
        "run_id": run_id,
        "requested_by": requested_by,
        "created_at": plan["created_at"],
    }
    plan["dispatch_prompt"] = _dispatch_prompt(plan)
    return plan


def _dispatch_prompt(plan: dict[str, Any]) -> str:
    state_json = json.dumps(
        {
            "status": "starting",
            "phase": "bootstrap",
            "note": "Run launched by Centaur experiment-launcher.",
            "updated_at": plan["created_at"],
        },
        indent=2,
    )
    launch_json = json.dumps(plan["launch"], indent=2)
    return f"""You are executing a cmpx575 Experiment Launcher run.

Repository path: {plan["repo_path"]}
Run id: {plan["run_id"]}
Run directory: {plan["repo_path"]}/.cmpx575/the-garage/runs/{plan["run_id"]}

First perform this bootstrap exactly:

1. cd {plan["repo_path"]}
2. mkdir -p .cmpx575/the-garage/runs/{plan["run_id"]}
3. Write BRIEF.md in that run directory with the exact brief below.
4. Write state.json in that run directory with:

```json
{state_json}
```

5. Write launch.json in that run directory with:

```json
{launch_json}
```

Then execute the brief. Keep state.json current. Before finishing, write RETURN.md in the run directory.
If blocked, still write RETURN.md and set state.json to needs_input or blocked with the specific blocker.

--- BEGIN BRIEF.md ---
{plan["brief"]}
--- END BRIEF.md ---
"""


class ExperimentLauncherClient:
    """Client that dispatches generated experiment plans to the fleet gateway."""

    def __init__(
        self,
        url: str | None = None,
        auth_token: str | None = None,
        timeout: float = 30.0,
    ):
        self._url = url
        self._auth_token = auth_token
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def base_url(self) -> str:
        url = (self._url or os.getenv("FLEET_DISPATCH_URL", DEFAULT_BASE_URL)).rstrip("/")  # noqa: TID251
        if url and not url.startswith(("http://", "https://")):
            url = f"https://{url}"
        return url

    def _auth_headers(self) -> dict[str, str]:
        token = self._auth_token or _secret("FLEET_DISPATCH_TOKEN", "FLEET_DISPATCH_TOKEN")
        return {"Authorization": f"Bearer {token}"}

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            base_url = self.base_url
            proxy, trust_env = _transport_policy(base_url)
            self._client = httpx.Client(
                base_url=base_url,
                headers=self._auth_headers(),
                timeout=self.timeout,
                follow_redirects=True,
                verify=_ca_bundle() or True,
                proxy=proxy,
                trust_env=trust_env,
            )
        return self._client

    def dispatch(self, plan: dict[str, Any]) -> dict[str, Any]:
        resp = self.client.post(
            "/dispatch",
            json={
                "worker": plan["worker"],
                "prompt": plan["dispatch_prompt"],
                "timeout": plan["timeout"],
            },
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"fleet-dispatch API error ({resp.status_code}): {resp.text}")
        data = resp.json()
        return {
            "dispatched": True,
            "job_id": data.get("job_id"),
            "run_id": plan["run_id"],
            "shape": plan["shape"],
            "worker": plan["worker"],
            "timeout": plan["timeout"],
            "gateway_response": data,
        }

    def status(self, job_id: str) -> dict[str, str]:
        """Return only the fleet lifecycle state, never the worker result."""
        clean_job_id = job_id.strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", clean_job_id):
            raise ValueError("job_id contains unsupported characters")
        resp = self.client.get(f"/jobs/{quote(clean_job_id, safe='')}")
        if resp.status_code >= 400:
            raise RuntimeError(f"fleet-dispatch API error ({resp.status_code}): {resp.text}")
        data = resp.json()
        if not isinstance(data, dict):
            raise RuntimeError("fleet-dispatch status returned a non-object")
        return {"state": str(data.get("state") or "unknown")}

    def launch(
        self,
        version: int,
        shape: str,
        objective: str,
        slug: str = "",
        requested_by: str = "centaur",
        source: dict[str, Any] | None = None,
        idempotency_key: str = "",
    ) -> dict[str, Any]:
        """Launch one normalized, typed request from a trusted workflow.

        The caller cannot supply a command, repository path, worker, timeout,
        or rendered brief. Those stay fixed by the selected launcher shape.
        """
        if version != 1:
            raise ValueError("version must be 1")
        clean_objective = objective.strip()
        if not clean_objective or len(clean_objective) > 2000:
            raise ValueError("objective must contain 1-2000 characters")
        clean_shape = normalize_shape(shape)
        if slug and not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", slug):
            raise ValueError("slug must contain 1-63 lowercase letters, digits, or hyphens")
        clean_requester = requested_by.strip()
        if not clean_requester or len(clean_requester) > 128:
            raise ValueError("requested_by must contain 1-128 characters")
        if not idempotency_key.strip() or len(idempotency_key) > 512:
            raise ValueError("idempotency_key must contain 1-512 characters")
        if source is not None and not isinstance(source, dict):
            raise ValueError("source must be an object")

        plan = build_plan(
            shape=clean_shape,
            objective=clean_objective,
            slug=slug or None,
            requested_by=clean_requester,
        )
        dispatched = self.dispatch(plan)
        return {
            "launched": True,
            "launcher_run_id": dispatched["run_id"],
            "fleet_job_id": dispatched.get("job_id"),
            "shape": dispatched["shape"],
            "worker": dispatched["worker"],
            "timeout": dispatched["timeout"],
            "idempotency_key": idempotency_key,
        }

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "ExperimentLauncherClient":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def _client() -> ExperimentLauncherClient:
    return ExperimentLauncherClient()
