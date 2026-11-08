"""Pinned upstream demo preparation and isolated Compose lifecycle."""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import signal
import subprocess
import tarfile
import urllib.request
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import yaml

from live_compare_support.config import ROOT, Workload, read_json, resolve, save_json

DEMO_COMMIT = "dedc0178918e260823323b8d95005a8cb924b007"
DEMO_URL = f"https://codeload.github.com/open-telemetry/opentelemetry-demo/tar.gz/{DEMO_COMMIT}"
DEMO_SHA256 = "60bc2420ede659375b54302799fc312443345457a6894b26ba5c2d7acc6895f7"
COLLECTOR = (
    "ghcr.io/open-telemetry/opentelemetry-collector-releases/"
    "opentelemetry-collector-contrib:0.160.0"
)
Command = Callable[[list[str], Path, Mapping[str, str]], str]
Download = Callable[[], bytes]

# Datadog's documented PostgreSQL integration pipeline, independent of migrator
# mappings: docs.datadoghq.com/opentelemetry/integrations/postgres_metrics/
PG_RATES = [
    "postgresql.tup_returned",
    "postgresql.tup_fetched",
    "postgresql.tup_inserted",
    "postgresql.tup_updated",
    "postgresql.tup_deleted",
    "postgresql.operations",
    "postgresql.commits",
    "postgresql.rollbacks",
    "postgresql.blks_hit",
    "postgresql.blks_read",
    "postgresql.temp_files",
    "postgresql.temp.io",
    "postgresql.function.calls",
    "postgresql.index.scans",
    "postgresql.sequential_scans",
    "postgresql.blocks_read",
]


def command(args: list[str], cwd: Path, env: Mapping[str, str]) -> str:
    try:
        process = subprocess.Popen(
            args,
            cwd=cwd,
            env=dict(env),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, _ = process.communicate(timeout=600)
        except BaseException:
            # Docker may launch a Compose plugin subprocess. Terminate the whole
            # group before cleanup, so an orphaned `up` cannot recreate services.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            raise
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, args)
    except (subprocess.SubprocessError, OSError):
        # Compose/collector errors can echo resolved credentials. Do not print
        # captured output; users can inspect their local Docker UI themselves.
        raise RuntimeError(f"{args[0]} command failed; inspect the local Docker status") from None
    return stdout


def download() -> bytes:
    with urllib.request.urlopen(DEMO_URL, timeout=60) as response:
        data: bytes = response.read(64 * 1024 * 1024 + 1)
        return data


def unpack(data: bytes, destination: Path) -> None:
    if hashlib.sha256(data).hexdigest() != DEMO_SHA256:
        raise RuntimeError("upstream archive checksum mismatch")
    destination.mkdir()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        # Do not extract devices, links or paths outside the pinned root.
        for member in archive.getmembers():
            parts = Path(member.name).parts
            if not parts or parts[0] != f"opentelemetry-demo-{DEMO_COMMIT}":
                raise RuntimeError("unexpected upstream archive root")
            if member.issym() or member.islnk() or member.isdev():
                raise RuntimeError("upstream archive links/devices are unsupported")
        archive.extractall(destination, filter="data")


def collector_config(workload: Workload, run_id: str) -> dict[str, Any]:
    interval = f"{workload.collection_seconds}s"
    receivers: dict[str, Any] = {
        "otlp": {
            "protocols": {
                "grpc": {"endpoint": "0.0.0.0:4317"},
                "http": {"endpoint": "0.0.0.0:4318"},
            }
        },
        "postgresql": {
            "endpoint": "astronomy-db:5432",
            "username": "monitoring_user",
            "password": "${env:POSTGRES_MONITORING_PASSWORD}",
            "collection_interval": interval,
            "tls": {"insecure": True},
            "metrics": {
                name: {"enabled": True} for name in [*PG_RATES, "postgresql.database.locks"]
            },
        },
        "redis": {
            "endpoint": "valkey-cart:6379",
            "collection_interval": interval,
            "metrics": {"redis.maxmemory": {"enabled": True}},
        },
        "nginx": {"endpoint": "http://image-provider:8081/status", "collection_interval": interval},
        "kafkametrics": {
            "brokers": ["kafka:9092"],
            "scrapers": ["brokers", "topics", "consumers"],
            "collection_interval": interval,
        },
        "hostmetrics": {
            "collection_interval": interval,
            "scrapers": {
                "cpu": {"metrics": {"system.cpu.utilization": {"enabled": True}}},
                "memory": {
                    "metrics": {
                        "system.memory.limit": {"enabled": True},
                        "system.linux.memory.available": {"enabled": True},
                    }
                },
                "load": {},
                "network": {},
                "disk": {},
            },
        },
        "docker_stats": {
            "endpoint": "unix:///var/run/docker.sock",
            "collection_interval": interval,
            "metrics": {"container.state.status": {"enabled": True}},
        },
    }
    chosen = ["otlp", *workload.receivers]
    return {
        "receivers": {k: receivers[k] for k in chosen},
        "processors": {
            "resource/run": {
                "attributes": [
                    {"key": "host.name", "value": run_id, "action": "upsert"},
                    {"key": "datadog.host.name", "value": run_id, "action": "upsert"},
                    {"key": "live_compare.run", "value": run_id, "action": "upsert"},
                    {"key": "service.instance.id", "value": run_id, "action": "insert"},
                ]
            },
            "cumulativetodelta/pg": {"include": {"match_type": "strict", "metrics": PG_RATES}},
            "deltatorate/pg": {"metrics": PG_RATES},
        },
        "exporters": {
            "otlphttp/dash0": {
                "endpoint": "${env:DASH0_OTLP_ENDPOINT}",
                "headers": {
                    "Authorization": "Bearer ${env:DASH0_AUTH_TOKEN}",
                    "Dash0-Dataset": "${env:DASH0_DATASET}",
                },
            },
            "datadog": {
                "api": {"key": "${env:DD_API_KEY}", "site": "${env:DD_SITE}"},
                "metrics": {"resource_attributes_as_tags": True},
                "host_metadata": {"enabled": False},
            },
            "nop": {},
        },
        "service": {
            "pipelines": {
                "metrics/dash0": {
                    "receivers": chosen,
                    "processors": ["resource/run"],
                    "exporters": ["otlphttp/dash0"],
                },
                "metrics/datadog": {
                    "receivers": chosen,
                    "processors": ["resource/run", "cumulativetodelta/pg", "deltatorate/pg"],
                    "exporters": ["datadog"],
                },
                "traces": {"receivers": ["otlp"], "exporters": ["nop"]},
                "logs": {"receivers": ["otlp"], "exporters": ["nop"]},
            }
        },
    }


def isolate(
    compose: dict[str, Any], workload: Workload, runtime: Path, images: dict[str, str]
) -> dict[str, Any]:
    compose.pop("name", None)
    for network in compose.get("networks", {}).values():
        network.pop("name", None)
        network.pop("external", None)
    for volume in compose.get("volumes", {}).values():
        volume.pop("name", None)
        volume.pop("external", None)
    for name, service in compose["services"].items():
        service.pop("build", None)
        service.pop("container_name", None)
        image = service["image"]
        if image not in images:
            raise RuntimeError(f"unpinned upstream image: {name}")
        service["image"] = images[image]
        # Docker Compose interpolates dollars even in normalized JSON. Preserve
        # any upstream literal dollar in commands, healthchecks and environment.
        for port in service.get("ports", []):
            port.update(host_ip="127.0.0.1", published="0")
        for mount in service.get("volumes", []):
            if mount["type"] == "bind":
                mount["read_only"] = True
    collector = compose["services"]["otel-collector"]
    collector["command"] = ["--config=/etc/live-collector.yaml"]
    collector["volumes"] = [
        {
            "type": "bind",
            "source": str(runtime / "collector.yaml"),
            "target": "/etc/live-collector.yaml",
            "read_only": True,
        }
    ]
    if "docker_stats" in workload.receivers:
        collector["volumes"].append(
            {
                "type": "bind",
                "source": os.environ.get("DOCKER_SOCK", "/var/run/docker.sock"),
                "target": "/var/run/docker.sock",
                "read_only": True,
            }
        )
    for key in [
        "DD_API_KEY",
        "DD_SITE",
        "DASH0_OTLP_ENDPOINT",
        "DASH0_AUTH_TOKEN",
        "DASH0_DATASET",
    ]:
        collector["environment"][key] = None  # inherit; never serialize credentials
    generator = compose["services"]["load-generator"]
    generator["environment"].update(
        LOCUST_USERS=str(workload.users),
        # Keep the upstream web-server healthcheck alive; autostart begins load
        # without user interaction, and the UI is bound to localhost only.
        LOCUST_HEADLESS="false",
        LOCUST_AUTOSTART="true",
        LOCUST_SPAWN_RATE=str(workload.spawn_rate),
    )

    # Escape all literal '$' once; None passthrough environment keys stay None.
    def escape(value: Any) -> Any:
        if isinstance(value, str):
            return value.replace("$", "$$")
        if isinstance(value, list):
            return [escape(v) for v in value]
        if isinstance(value, dict):
            return {k: escape(v) for k, v in value.items()}
        return value

    result: dict[str, Any] = escape(compose)
    return result


class Environment:
    def __init__(
        self,
        runtime: Path,
        workload: Workload,
        profile: Path,
        run_id: str,
        env: Mapping[str, str],
        execute: Command = command,
        fetch: Download = download,
    ) -> None:
        self.runtime, self.workload, self.profile = runtime, workload, profile
        self.run_id, self.env, self.execute, self.fetch = run_id, env, execute, fetch

    def prepare(self) -> None:
        self.runtime.mkdir(parents=True, exist_ok=True)
        dest = self.runtime / "upstream"
        root = dest / f"opentelemetry-demo-{DEMO_COMMIT}"
        # Always recreate only our extracted source; runtime inputs are pinned.
        if dest.exists():
            shutil.rmtree(dest)
        unpack(self.fetch(), dest)
        if self.workload.feature_flags:
            flags = read_json(resolve(self.profile, self.workload.feature_flags))
            save_json(root / "src/flagd/demo.flagd.json", flags)
        # Only Docker process settings are inherited while rendering upstream
        # Compose. Shell variables must not silently change workload parameters.
        local_env = {
            k: v
            for k, v in self.env.items()
            if k in {"PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "TMPDIR"}
        }
        local_env.update(DEMO_VERSION="3.1.0", COLLECTOR_CONTRIB_IMAGE=COLLECTOR)
        text = self.execute(
            [
                "docker",
                "compose",
                "--env-file",
                str(root / ".env"),
                "-f",
                str(root / "compose.yaml"),
                "-f",
                str(root / "compose.full.yaml"),
                "config",
                "--format",
                "json",
            ],
            root,
            local_env,
        )
        compose = isolate(
            json.loads(text),
            self.workload,
            self.runtime,
            read_json(ROOT / "scripts/live/images.lock.json"),
        )
        save_json(self.runtime / "compose.json", compose)
        (self.runtime / "collector.yaml").write_text(
            yaml.safe_dump(collector_config(self.workload, self.run_id), sort_keys=False)
        )

    def compose(self, *args: str) -> str:
        return self.execute(
            [
                "docker",
                "compose",
                "-p",
                self.run_id,
                "-f",
                str(self.runtime / "compose.json"),
                *args,
            ],
            self.runtime,
            self.env,
        )

    def start(self) -> None:
        self.compose("up", "--detach", "--no-build", "--wait", "--wait-timeout", "300")
        for sql in self.workload.seed_sql:
            path = resolve(self.profile, sql)
            # Use a temporary container copy; seeds never touch a remote database.
            self.compose("cp", str(path), "astronomy-db:/tmp/live-seed.sql")
            self.compose(
                "exec",
                "-T",
                "astronomy-db",
                "psql",
                "-U",
                "postgres",
                "-d",
                "astronomy_db",
                "-v",
                "ON_ERROR_STOP=1",
                "-f",
                "/tmp/live-seed.sql",
            )

    def stop(self) -> None:
        if (self.runtime / "compose.json").exists():
            self.compose("down", "--volumes", "--remove-orphans")

    def healthy(self) -> bool:
        if not (self.runtime / "compose.json").exists():
            return False
        # Compose emits one JSON object per service, including stopped containers.
        rows = [
            json.loads(line)
            for line in self.compose("ps", "--all", "--format", "json").splitlines()
            if line.strip()
        ]
        expected = set(read_json(self.runtime / "compose.json")["services"])
        return {row.get("Service") for row in rows} == expected and all(
            row.get("State") == "running" and row.get("Health", "") in ("", "healthy")
            for row in rows
        )
