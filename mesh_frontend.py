#!/usr/bin/env python3
"""Small local web server for the Zigbee2MQTT mesh exporter."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import zigbee_mesh as mesh


WEB_ROOT = Path(__file__).resolve().parent / "web"


_serverless_app: "MeshApp | None" = None
_serverless_app_lock = threading.Lock()


class MeshApp:
    def __init__(self, output_dir: str):
        self.output_dir = Path(output_dir).expanduser().resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.jobs: dict[str, dict[str, Any]] = {}

    def snapshot_dir(self, snapshot_id: str) -> Path:
        root = self.output_dir.resolve()
        candidate = (root / snapshot_id).resolve()
        if candidate.parent != root or not candidate.is_dir() or not (candidate / "snapshot.json").is_file():
            raise ValueError("Unknown snapshot")
        return candidate

    def list_snapshots(self) -> list[dict[str, Any]]:
        result = []
        for directory in self.output_dir.iterdir():
            snapshot_file = directory / "snapshot.json"
            if not directory.is_dir() or not snapshot_file.is_file():
                continue
            try:
                snapshot = json.loads(snapshot_file.read_text(encoding="utf-8"))
                networkmap = snapshot.get("networkmap") or {}
                result.append(
                    {
                        "id": directory.name,
                        "label": snapshot.get("label") or directory.name,
                        "captured_at": snapshot.get("captured_at"),
                        "nodes": len(networkmap.get("nodes") or []),
                        "links": len(networkmap.get("links") or []),
                        "network": mesh.network_metadata(snapshot),
                    }
                )
            except (OSError, json.JSONDecodeError):
                continue
        return sorted(result, key=lambda item: item.get("captured_at") or "", reverse=True)

    def import_snapshot(self, payload: dict[str, Any]) -> Path:
        """Import a raw Z2M map, a bridge response, or a previous snapshot."""
        content = payload.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("The imported file is empty")
        try:
            source = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ValueError(f"The imported file is not valid JSON: {exc}") from exc

        snapshot = source if isinstance(source, dict) and "networkmap" in source else None
        if snapshot is not None:
            networkmap = snapshot.get("networkmap")
            bridge_info = mesh.redact(snapshot.get("bridge_info"))
            devices = snapshot.get("devices")
            health = snapshot.get("health")
            bridge_state = snapshot.get("bridge_state")
            source_type = "snapshot"
        else:
            networkmap = source
            bridge_info = None
            devices = None
            health = None
            bridge_state = None
            source_type = "raw map"
            if isinstance(source, dict) and isinstance(source.get("data"), dict):
                response_data = source["data"]
                networkmap = response_data.get("value")
                source_type = "MQTT response"
            if isinstance(networkmap, str):
                try:
                    networkmap = json.loads(networkmap)
                except json.JSONDecodeError as exc:
                    raise ValueError("The file contains Graphviz/PlantUML text; import a raw JSON map instead") from exc

        if not isinstance(networkmap, dict) or not isinstance(networkmap.get("nodes"), list) or not isinstance(networkmap.get("links"), list):
            raise ValueError("Expected a raw Zigbee2MQTT map containing 'nodes' and 'links'")

        captured_at = mesh.now_utc()
        label = str(payload.get("label") or (snapshot or {}).get("label") or f"imported-{mesh.stamp(captured_at)}")
        safe_label = "".join(char if char.isalnum() or char in "-_" else "_" for char in label).strip("_") or "imported"
        directory = self.output_dir / f"{mesh.stamp(captured_at)}-{safe_label}"
        directory.mkdir(parents=True, exist_ok=False)
        imported = {
            "schema": 1,
            "captured_at": captured_at.isoformat(),
            "label": label,
            "mqtt_base_topic": (snapshot or {}).get("mqtt_base_topic", ""),
            "request": (snapshot or {}).get("request", {"type": "raw", "routes": None}),
            "source": source_type,
            "networkmap": networkmap,
            "bridge_info": bridge_info,
            "devices": devices,
            "health": health,
            "bridge_state": bridge_state,
        }
        mesh.json_dump(directory / "snapshot.json", imported)
        mesh.json_dump(directory / "networkmap.raw.json", networkmap)
        mesh.json_dump(directory / "bridge.info.json", bridge_info)
        mesh.json_dump(directory / "bridge.devices.json", devices)
        mesh.json_dump(directory / "bridge.health.json", health)
        (directory / "networkmap.dot").write_text(mesh.networkmap_dot(networkmap), encoding="utf-8")
        return directory

    def start_job(self, kind: str, payload: dict[str, Any]) -> str:
        job_id = uuid.uuid4().hex
        with self.lock:
            self.jobs[job_id] = {"id": job_id, "kind": kind, "status": "queued", "message": "Queued"}
        thread = threading.Thread(target=self.run_job, args=(job_id, kind, payload), daemon=True)
        thread.start()
        return job_id

    def update_job(self, job_id: str, **updates: Any) -> None:
        with self.lock:
            self.jobs[job_id].update(updates)

    def run_job(self, job_id: str, kind: str, payload: dict[str, Any]) -> None:
        self.update_job(job_id, status="running", message="Working")
        try:
            if kind == "snapshot":
                args = SimpleNamespace(
                    host=str(payload.get("host") or "localhost"),
                    port=int(payload.get("port") or 1883),
                    username=payload.get("username") or None,
                    password=payload.get("password") or None,
                    tls=bool(payload.get("tls")),
                    ca_file=payload.get("ca_file") or None,
                    base_topic=str(payload.get("base_topic") or "zigbee2mqtt"),
                    timeout=float(payload.get("timeout") or 180),
                    connect_timeout=float(payload.get("connect_timeout") or 15),
                    include_routes=bool(payload.get("include_routes", False)),
                    output_dir=str(self.output_dir),
                    label=str(payload.get("label") or "frontend-snapshot"),
                )
                directory = mesh.create_snapshot(args)
                self.update_job(
                    job_id,
                    status="done",
                    message="Snapshot complete",
                    snapshot_id=directory.name,
                )
                return

            if kind == "diff":
                before_id = str(payload.get("before") or "")
                after_id = str(payload.get("after") or "")
                before_dir = self.snapshot_dir(before_id)
                after_dir = self.snapshot_dir(after_id)
                args = SimpleNamespace(
                    before=str(before_dir),
                    after=str(after_dir),
                    output=str(after_dir / "diff"),
                    lqi_threshold=int(payload.get("lqi_threshold") or 15),
                )
                mesh.run_diff(args)
                self.update_job(
                    job_id,
                    status="done",
                    message="Comparison complete",
                    before=before_id,
                    after=after_id,
                )
                return

            raise ValueError(f"Unknown job type: {kind}")
        except Exception as exc:  # surface the useful error in the UI
            self.update_job(job_id, status="error", message=str(exc))

    def job(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            if job_id not in self.jobs:
                raise ValueError("Unknown job")
            return dict(self.jobs[job_id])


class Handler(BaseHTTPRequestHandler):
    server_version = "ZigbeeMeshFrontend/1.0"

    @property
    def app(self) -> MeshApp:
        # The local server attaches the application to the HTTPServer instance.
        # Vercel constructs BaseHTTPRequestHandler directly, so there is no
        # local server object carrying ``app`` in that environment.
        attached_app = getattr(self.server, "app", None)
        if attached_app is not None:
            return attached_app
        return serverless_app()

    def log_message(self, format: str, *args: Any) -> None:
        # Keep the terminal useful: only application errors/jobs are printed.
        return

    def send_bytes(self, content: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, value: Any, status: int = 200) -> None:
        self.send_bytes(json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def send_error_json(self, message: str, status: int = 400) -> None:
        self.send_json({"error": message}, status)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/health":
                self.send_json({"ok": True, "output_dir": str(self.app.output_dir)})
                return
            if parsed.path == "/api/snapshots":
                self.send_json({"snapshots": self.app.list_snapshots()})
                return
            if parsed.path.startswith("/api/job/"):
                self.send_json(self.app.job(unquote(parsed.path.removeprefix("/api/job/"))))
                return
            if parsed.path.startswith("/api/snapshot/"):
                snapshot_id = unquote(parsed.path.removeprefix("/api/snapshot/"))
                directory = self.app.snapshot_dir(snapshot_id)
                self.send_json(json.loads((directory / "snapshot.json").read_text(encoding="utf-8")))
                return
            if parsed.path == "/api/diff":
                query = parse_qs(parsed.query)
                before = query.get("before", [""])[0]
                after = query.get("after", [""])[0]
                after_dir = self.app.snapshot_dir(after)
                before_dir = self.app.snapshot_dir(before)
                diff_file = after_dir / "diff" / "diff.json"
                if not diff_file.is_file():
                    self.send_json({"available": False, "before": before, "after": after})
                    return
                diff = json.loads(diff_file.read_text(encoding="utf-8"))
                if diff.get("before", {}).get("label") != json.loads((before_dir / "snapshot.json").read_text(encoding="utf-8")).get("label"):
                    self.send_json({"available": False, "before": before, "after": after})
                    return
                self.send_json({"available": True, "diff": diff})
                return
            if parsed.path == "/api/diff-markdown":
                query = parse_qs(parsed.query)
                after_dir = self.app.snapshot_dir(query.get("after", [""])[0])
                markdown_file = after_dir / "diff" / "diff.md"
                if not markdown_file.is_file():
                    self.send_error_json("Diff report not found", 404)
                    return
                self.send_bytes(markdown_file.read_bytes(), "text/markdown; charset=utf-8")
                return
            self.serve_static(parsed.path)
        except (ValueError, FileNotFoundError, json.JSONDecodeError) as exc:
            self.send_error_json(str(exc), 404)
        except Exception as exc:
            self.send_error_json(str(exc), 500)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            if parsed.path == "/api/snapshot":
                job_id = self.app.start_job("snapshot", payload)
                self.send_json({"job_id": job_id}, 202)
                return
            if parsed.path == "/api/import":
                directory = self.app.import_snapshot(payload)
                self.send_json({"snapshot_id": directory.name}, 201)
                return
            if parsed.path == "/api/diff":
                before = str(payload.get("before") or "")
                after = str(payload.get("after") or "")
                self.app.snapshot_dir(before)
                self.app.snapshot_dir(after)
                job_id = self.app.start_job("diff", payload)
                self.send_json({"job_id": job_id}, 202)
                return
            self.send_error_json("Unknown endpoint", 404)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_error_json(str(exc), 400)
        except Exception as exc:
            self.send_error_json(str(exc), 500)

    def serve_static(self, request_path: str) -> None:
        relative = "index.html" if request_path in ("", "/") else request_path.removeprefix("/")
        candidate = (WEB_ROOT / relative).resolve()
        if WEB_ROOT not in candidate.parents and candidate != WEB_ROOT:
            self.send_error_json("Invalid path", 404)
            return
        if not candidate.is_file():
            self.send_error_json("Not found", 404)
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_bytes(candidate.read_bytes(), content_type)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", default="mesh-snapshots", help="Directory containing mesh snapshots")
    parser.add_argument("--listen", default="127.0.0.1", help="Interface to bind")
    parser.add_argument("--port", type=int, default=8765, help="HTTP port")
    args = parser.parse_args()
    app = MeshApp(args.output_dir)
    server = ThreadingHTTPServer((args.listen, args.port), Handler)
    server.app = app  # type: ignore[attr-defined]
    print(f"Zigbee mesh frontend: http://{args.listen}:{args.port}")
    print(f"Snapshot directory: {app.output_dir}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped")
    finally:
        server.server_close()
    return 0


def serverless_app() -> MeshApp:
    """Return the application used by a Vercel Python function.

    Vercel's deployed filesystem is read-only, while ``/tmp`` is writable but
    ephemeral. Seed that writable directory from the snapshots committed with
    the project so the deployed visualizer can inspect existing maps and can
    accept imports for the lifetime of a warm function instance.
    """
    global _serverless_app
    if _serverless_app is not None:
        return _serverless_app

    with _serverless_app_lock:
        if _serverless_app is not None:
            return _serverless_app

        if os.getenv("VERCEL"):
            output_dir = Path(os.getenv("MESH_OUTPUT_DIR", "/tmp/zigbee-mesh-snapshots"))
            bundled_dir = WEB_ROOT.parent / "mesh-snapshots"
            if not output_dir.exists() and bundled_dir.is_dir():
                shutil.copytree(bundled_dir, output_dir)
        else:
            output_dir = Path(os.getenv("MESH_OUTPUT_DIR", "mesh-snapshots"))

        _serverless_app = MeshApp(str(output_dir))
        return _serverless_app


if __name__ == "__main__":
    raise SystemExit(main())
