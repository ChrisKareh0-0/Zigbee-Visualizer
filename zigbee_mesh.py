#!/usr/bin/env python3
"""Capture and compare Zigbee2MQTT mesh snapshots.

The utility uses Zigbee2MQTT's MQTT request/response API.  A snapshot contains
the raw network map, bridge information, device metadata, and a Graphviz DOT
representation.  The diff command compares snapshots by IEEE address and
reports topology, LQI, route, device, and network-identity changes.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import statistics
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Lock
from typing import Any

try:
    import paho.mqtt.client as mqtt
except ImportError as exc:  # pragma: no cover - exercised by the CLI
    raise SystemExit(
        "Missing dependency: install it with 'python -m pip install -r requirements.txt'"
    ) from exc


DEFAULT_BASE_TOPIC = "zigbee2mqtt"
DEFAULT_OUTPUT_DIR = "mesh-snapshots"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def stamp(value: datetime | None = None) -> str:
    return (value or now_utc()).strftime("%Y%m%dT%H%M%SZ")


def json_dump(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def redact(value: Any) -> Any:
    """Remove secrets from bridge/info before persisting it."""
    secret_names = {
        "network_key",
        "password",
        "key",
        "cert",
        "ca",
        "ssl_key",
        "ssl_cert",
    }
    if isinstance(value, dict):
        return {
            key: "[redacted]" if key.lower() in secret_names else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def parse_json(payload: bytes) -> Any:
    return json.loads(payload.decode("utf-8"))


def paho_client(client_id: str) -> mqtt.Client:
    """Create a client compatible with paho-mqtt 1.x and 2.x."""
    try:
        return mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
    except AttributeError:
        return mqtt.Client(client_id=client_id)


def configure_tls(client: mqtt.Client, ca_file: str | None) -> None:
    if ca_file:
        client.tls_set(ca_certs=ca_file)
    else:
        client.tls_set()


class MqttCapture:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.client = paho_client(f"zigbee-mesh-export-{uuid.uuid4().hex[:10]}")
        self.connected = Event()
        self.connection_error: str | None = None
        self.response = Event()
        self.response_payload: dict[str, Any] | None = None
        self.messages: dict[str, Any] = {}
        self.messages_lock = Lock()

        if args.username:
            self.client.username_pw_set(args.username, args.password)
        if args.tls:
            configure_tls(self.client, args.ca_file)

        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message

    @property
    def base(self) -> str:
        return self.args.base_topic.strip("/")

    def on_connect(self, client: mqtt.Client, userdata: Any, flags: Any, reason_code: Any, properties: Any = None) -> None:
        code = getattr(reason_code, "value", reason_code)
        if code not in (0, "0", None):
            self.connection_error = f"MQTT connection failed: {reason_code}"
            return
        self.connected.set()

    def on_message(self, client: mqtt.Client, userdata: Any, message: mqtt.MQTTMessage) -> None:
        try:
            payload = parse_json(message.payload)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return

        with self.messages_lock:
            self.messages[message.topic] = payload

        response_topic = f"{self.base}/bridge/response/networkmap"
        if message.topic != response_topic or not isinstance(payload, dict):
            return

        transaction = payload.get("transaction")
        if self.expected_transaction and transaction not in (None, self.expected_transaction):
            return
        self.response_payload = payload
        self.response.set()

    expected_transaction: str | None = None

    def connect(self) -> None:
        try:
            self.client.connect(self.args.host, self.args.port, keepalive=60)
        except Exception as exc:  # paho raises several broker/socket exceptions
            raise RuntimeError(f"Could not connect to MQTT at {self.args.host}:{self.args.port}: {exc}") from exc
        self.client.loop_start()
        if not self.connected.wait(self.args.connect_timeout):
            detail = f": {self.connection_error}" if self.connection_error else ""
            raise RuntimeError(f"Timed out connecting to MQTT{detail}")

    def subscribe(self, topic: str) -> None:
        result, _ = self.client.subscribe(topic)
        if result != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(f"Could not subscribe to {topic!r}: MQTT result {result}")

    def collect_retained(self) -> None:
        topics = (
            f"{self.base}/bridge/info",
            f"{self.base}/bridge/devices",
            f"{self.base}/bridge/health",
            f"{self.base}/bridge/state",
        )
        for topic in topics:
            self.subscribe(topic)
        # Retained messages normally arrive immediately.  This also gives the
        # bridge a short opportunity to publish a non-retained health message.
        time.sleep(0.75)

    def request_networkmap(self) -> dict[str, Any]:
        response_topic = f"{self.base}/bridge/response/networkmap"
        self.subscribe(response_topic)
        self.expected_transaction = f"mesh-{uuid.uuid4().hex}"
        include_routes = bool(getattr(self.args, "include_routes", True))
        request = {
            "type": "raw",
            "routes": include_routes,
            "transaction": self.expected_transaction,
        }
        topic = f"{self.base}/bridge/request/networkmap"
        info = self.client.publish(topic, json.dumps(request), qos=0)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(f"Could not publish network-map request: MQTT result {info.rc}")

        if not self.response.wait(self.args.timeout):
            raise RuntimeError(
                f"Timed out waiting for {response_topic}; the network-map scan can take up to a few minutes"
            )
        if not self.response_payload:
            raise RuntimeError("Zigbee2MQTT returned an empty network-map response")
        if self.response_payload.get("status") == "error":
            raise RuntimeError(self.response_payload.get("error", "Zigbee2MQTT network-map request failed"))
        if self.response_payload.get("status") != "ok":
            raise RuntimeError(f"Unexpected network-map response: {self.response_payload}")
        data = self.response_payload.get("data", {})
        value = data.get("value") if isinstance(data, dict) else None
        if not isinstance(value, dict):
            raise RuntimeError("The raw network-map response did not contain data.value")
        return value

    def capture(self) -> tuple[dict[str, Any], dict[str, Any]]:
        self.connect()
        try:
            self.collect_retained()
            networkmap = self.request_networkmap()
            with self.messages_lock:
                messages = copy.deepcopy(self.messages)
            return networkmap, messages
        finally:
            self.client.loop_stop()
            self.client.disconnect()


def dot_escape(value: Any) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def networkmap_dot(networkmap: dict[str, Any]) -> str:
    nodes = networkmap.get("nodes") or []
    links = networkmap.get("links") or []
    lines = [
        "digraph zigbee_mesh {",
        '  graph [overlap=false, splines=true, rankdir=LR, bgcolor="white"];',
        '  node [fontname="Arial", fontsize=9, style="filled"];',
        '  edge [fontname="Arial", fontsize=8, color="#777777"];',
    ]
    for node in nodes:
        ieee = node.get("ieeeAddr") or node.get("ieee_address")
        if not ieee:
            continue
        kind = str(node.get("type", "Unknown"))
        shape = "box"
        style = "filled"
        fill = "#f4cccc"
        if kind.lower() == "coordinator":
            shape, fill = "box", "#b6d7a8"
        elif kind.lower() == "router":
            shape, fill = "box", "#cfe2f3"
        else:
            shape, style, fill = "box", "filled,dashed", "#fff2cc"
        label = f"{node.get('friendlyName', ieee)}\\n{kind}\\n{ieee}"
        lines.append(
            f'  "{dot_escape(ieee)}" [label="{dot_escape(label)}", shape={shape}, style="{style}", fillcolor="{fill}"];'
        )

    for link in links:
        source = link.get("sourceIeeeAddr") or (link.get("source") or {}).get("ieeeAddr")
        target = link.get("targetIeeeAddr") or (link.get("target") or {}).get("ieeeAddr")
        if not source or not target:
            continue
        lqi = link.get("linkquality", link.get("lqi", "?"))
        relationship = link.get("relationship", "?")
        routes = link.get("routes") or []
        route_text = f", routes={len(routes)}" if routes else ""
        lines.append(
            f'  "{dot_escape(source)}" -> "{dot_escape(target)}" '
            f'[label="LQI {dot_escape(lqi)} (rel {dot_escape(relationship)}{dot_escape(route_text)})"];'
        )
    lines.append("}")
    return "\n".join(lines) + "\n"


def message_value(messages: dict[str, Any], base: str, suffix: str) -> Any:
    return messages.get(f"{base.strip('/')}/{suffix}")


def create_snapshot(args: argparse.Namespace) -> Path:
    output_root = Path(args.output_dir).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    captured_at = now_utc()
    label = args.label or "snapshot"
    safe_label = "".join(char if char.isalnum() or char in "-_" else "_" for char in label).strip("_") or "snapshot"
    directory = output_root / f"{stamp(captured_at)}-{safe_label}"
    directory.mkdir()

    capture = MqttCapture(args)
    networkmap, messages = capture.capture()
    base = args.base_topic
    info = redact(message_value(messages, base, "bridge/info"))
    devices = message_value(messages, base, "bridge/devices")
    health = message_value(messages, base, "bridge/health")
    state = message_value(messages, base, "bridge/state")

    request = {"type": "raw", "routes": bool(getattr(args, "include_routes", True))}
    snapshot = {
        "schema": 1,
        "captured_at": captured_at.isoformat(),
        "label": label,
        "mqtt_base_topic": base,
        "request": request,
        "networkmap": networkmap,
        "bridge_info": info,
        "devices": devices,
        "health": health,
        "bridge_state": state,
    }
    json_dump(directory / "snapshot.json", snapshot)
    json_dump(directory / "networkmap.raw.json", networkmap)
    json_dump(directory / "bridge.info.json", info)
    json_dump(directory / "bridge.devices.json", devices)
    json_dump(directory / "bridge.health.json", health)
    (directory / "networkmap.dot").write_text(networkmap_dot(networkmap), encoding="utf-8")

    print(f"Snapshot written to {directory}")
    print(f"Nodes: {len(networkmap.get('nodes') or [])}; links: {len(networkmap.get('links') or [])}")
    return directory


def load_snapshot(path: str | Path) -> dict[str, Any]:
    candidate = Path(path).expanduser().resolve()
    if candidate.is_dir():
        candidate = candidate / "snapshot.json"
    if not candidate.is_file():
        raise FileNotFoundError(f"Snapshot not found: {candidate}")
    data = json.loads(candidate.read_text(encoding="utf-8"))
    if "networkmap" not in data:
        # Accept a raw networkmap file as a convenience.
        data = {"schema": 1, "networkmap": data}
    return data


def node_id(node: dict[str, Any]) -> str:
    return str(node.get("ieeeAddr") or node.get("ieee_address") or "").lower()


def link_id(link: dict[str, Any]) -> tuple[str, str]:
    source = link.get("sourceIeeeAddr") or (link.get("source") or {}).get("ieeeAddr") or ""
    target = link.get("targetIeeeAddr") or (link.get("target") or {}).get("ieeeAddr") or ""
    return str(source).lower(), str(target).lower()


def route_signature(link: dict[str, Any]) -> list[tuple[Any, Any, Any]]:
    routes = link.get("routes") or []
    return sorted(
        (
            route.get("destinationAddress"),
            route.get("status"),
            route.get("nextHop"),
        )
        for route in routes
        if isinstance(route, dict)
    )


def short_node(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "ieee": node_id(node),
        "friendly_name": node.get("friendlyName"),
        "type": node.get("type"),
        "network_address": node.get("networkAddress"),
        "model_id": node.get("modelID") or (node.get("definition") or {}).get("model"),
        "failed": node.get("failed") or [],
        "last_seen": node.get("lastSeen"),
    }


def short_link(link: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": link_id(link)[0],
        "target": link_id(link)[1],
        "lqi": link.get("linkquality", link.get("lqi")),
        "depth": link.get("depth"),
        "relationship": link.get("relationship"),
        "routes": link.get("routes") or [],
    }


def changed_fields(old: dict[str, Any], new: dict[str, Any], fields: list[str]) -> dict[str, dict[str, Any]]:
    changes = {}
    for field in fields:
        if old.get(field) != new.get(field):
            changes[field] = {"before": old.get(field), "after": new.get(field)}
    return changes


def network_metadata(snapshot: dict[str, Any]) -> dict[str, Any]:
    info = snapshot.get("bridge_info") or {}
    network = info.get("network") or {}
    coordinator = info.get("coordinator") or {}
    config = info.get("config") or {}
    advanced = config.get("advanced") or {}
    serial = config.get("serial") or {}
    return {
        "channel": network.get("channel", advanced.get("channel")),
        "pan_id": network.get("pan_id", advanced.get("pan_id")),
        "extended_pan_id": network.get("extended_pan_id", advanced.get("ext_pan_id")),
        "coordinator_ieee": network.get("coordinator_ieee") or coordinator.get("ieee_address"),
        "coordinator_type": coordinator.get("type"),
        "adapter": serial.get("adapter"),
        "z2m_version": info.get("version"),
        "zigbee_herdsman_version": info.get("zigbee_herdsman"),
    }


def device_index(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    devices = snapshot.get("devices") or []
    return {
        str(device.get("ieee_address", "")).lower(): device
        for device in devices
        if isinstance(device, dict) and device.get("ieee_address")
    }


def compare(before: dict[str, Any], after: dict[str, Any], lqi_threshold: int) -> dict[str, Any]:
    before_map = before.get("networkmap") or {}
    after_map = after.get("networkmap") or {}
    before_nodes = {node_id(item): item for item in before_map.get("nodes", []) if node_id(item)}
    after_nodes = {node_id(item): item for item in after_map.get("nodes", []) if node_id(item)}
    before_links = {link_id(item): item for item in before_map.get("links", []) if all(link_id(item))}
    after_links = {link_id(item): item for item in after_map.get("links", []) if all(link_id(item))}

    added_nodes = sorted(set(after_nodes) - set(before_nodes))
    removed_nodes = sorted(set(before_nodes) - set(after_nodes))
    node_changes = []
    node_fields = ["friendlyName", "type", "networkAddress", "modelID", "failed", "lastSeen"]
    for ieee in sorted(set(before_nodes) & set(after_nodes)):
        changes = changed_fields(before_nodes[ieee], after_nodes[ieee], node_fields)
        if changes:
            node_changes.append({"ieee": ieee, "changes": changes})

    added_links = [short_link(after_links[key]) for key in sorted(set(after_links) - set(before_links))]
    removed_links = [short_link(before_links[key]) for key in sorted(set(before_links) - set(after_links))]
    changed_links = []
    degraded_links = []
    route_changes = []
    for key in sorted(set(before_links) & set(after_links)):
        old = short_link(before_links[key])
        new = short_link(after_links[key])
        old_lqi = old.get("lqi")
        new_lqi = new.get("lqi")
        lqi_delta = None
        if isinstance(old_lqi, (int, float)) and isinstance(new_lqi, (int, float)):
            lqi_delta = new_lqi - old_lqi
        link_changes = {}
        if old_lqi != new_lqi:
            link_changes["lqi"] = {"before": old_lqi, "after": new_lqi, "delta": lqi_delta}
        for field in ("depth", "relationship"):
            if old.get(field) != new.get(field):
                link_changes[field] = {"before": old.get(field), "after": new.get(field)}
        old_routes = route_signature(before_links[key])
        new_routes = route_signature(after_links[key])
        if old_routes != new_routes:
            route_changes.append({"source": key[0], "target": key[1], "before": old_routes, "after": new_routes})
            link_changes["routes"] = {"before": old_routes, "after": new_routes}
        if link_changes:
            item = {"source": key[0], "target": key[1], "changes": link_changes}
            changed_links.append(item)
            if lqi_delta is not None and lqi_delta <= -abs(lqi_threshold):
                degraded_links.append(item)

    before_devices = device_index(before)
    after_devices = device_index(after)
    device_changes = []
    device_fields = [
        "friendly_name",
        "type",
        "power_source",
        "model_id",
        "software_build_id",
        "interview_state",
        "interview_completed",
        "disabled",
    ]
    for ieee in sorted(set(before_devices) & set(after_devices)):
        fields = changed_fields(before_devices[ieee], after_devices[ieee], device_fields)
        if fields:
            device_changes.append({"ieee": ieee, "changes": fields})

    network_changes = changed_fields(network_metadata(before), network_metadata(after), list(network_metadata(before)))
    before_lqis = [item.get("linkquality", item.get("lqi")) for item in before_map.get("links", [])]
    after_lqis = [item.get("linkquality", item.get("lqi")) for item in after_map.get("links", [])]
    before_lqis = [value for value in before_lqis if isinstance(value, (int, float))]
    after_lqis = [value for value in after_lqis if isinstance(value, (int, float))]

    return {
        "schema": 1,
        "before": {"label": before.get("label"), "captured_at": before.get("captured_at")},
        "after": {"label": after.get("label"), "captured_at": after.get("captured_at")},
        "thresholds": {"lqi_degradation": lqi_threshold},
        "summary": {
            "before_nodes": len(before_nodes),
            "after_nodes": len(after_nodes),
            "added_nodes": len(added_nodes),
            "removed_nodes": len(removed_nodes),
            "before_links": len(before_links),
            "after_links": len(after_links),
            "added_links": len(added_links),
            "removed_links": len(removed_links),
            "changed_links": len(changed_links),
            "degraded_links": len(degraded_links),
            "route_changes": len(route_changes),
            "network_changes": len(network_changes),
        },
        "network": {
            "before": network_metadata(before),
            "after": network_metadata(after),
            "changes": network_changes,
        },
        "nodes": {
            "added": [short_node(after_nodes[key]) for key in added_nodes],
            "removed": [short_node(before_nodes[key]) for key in removed_nodes],
            "changed": node_changes,
        },
        "links": {
            "added": added_links,
            "removed": removed_links,
            "changed": changed_links,
            "degraded": degraded_links,
            "route_changes": route_changes,
        },
        "devices": {"changed": device_changes},
        "lqi_statistics": {
            "before": lqi_stats(before_lqis),
            "after": lqi_stats(after_lqis),
        },
    }


def lqi_stats(values: list[int | float]) -> dict[str, Any]:
    if not values:
        return {"count": 0}
    ordered = sorted(values)
    return {
        "count": len(values),
        "min": min(values),
        "max": max(values),
        "mean": round(statistics.mean(values), 1),
        "median": statistics.median(values),
        "p10": ordered[max(0, round((len(ordered) - 1) * 0.10))],
    }


def fmt(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, (dict, list)):
        return "`" + json.dumps(value, ensure_ascii=False, sort_keys=True) + "`"
    return str(value)


def markdown_diff(diff: dict[str, Any]) -> str:
    summary = diff["summary"]
    lines = [
        "# Zigbee mesh diff",
        "",
        f"Before: **{diff['before'].get('label') or 'unknown'}** ({diff['before'].get('captured_at') or 'unknown'})  ",
        f"After: **{diff['after'].get('label') or 'unknown'}** ({diff['after'].get('captured_at') or 'unknown'})",
        "",
        "## Summary",
        "",
        f"- Nodes: {summary['before_nodes']} → {summary['after_nodes']} "
        f"(added {summary['added_nodes']}, removed {summary['removed_nodes']})",
        f"- Directed links: {summary['before_links']} → {summary['after_links']} "
        f"(added {summary['added_links']}, removed {summary['removed_links']})",
        f"- Changed links: {summary['changed_links']}; degraded by ≥{diff['thresholds']['lqi_degradation']} LQI: {summary['degraded_links']}",
        f"- Active-route changes: {summary['route_changes']}",
        f"- Network metadata changes: {summary['network_changes']}",
        "",
    ]

    if diff["network"]["changes"]:
        lines += ["## Network identity and runtime changes", ""]
        for key, change in diff["network"]["changes"].items():
            lines.append(f"- `{key}`: {fmt(change['before'])} → {fmt(change['after'])}")
        lines.append("")

    for title, key, label in (
        ("Added nodes", "added", "nodes"),
        ("Removed nodes", "removed", "nodes"),
    ):
        values = diff["nodes"][key]
        if values:
            lines += [f"## {title}", ""]
            for item in values:
                lines.append(
                    f"- `{item['ieee']}` — {item.get('friendly_name') or 'unnamed'} "
                    f"({item.get('type') or 'unknown'}, short address {item.get('network_address')})"
                )
            lines.append("")

    if diff["nodes"]["changed"]:
        lines += ["## Node changes", ""]
        for item in diff["nodes"]["changed"]:
            lines.append(f"- `{item['ieee']}`")
            for field, change in item["changes"].items():
                lines.append(f"  - `{field}`: {fmt(change['before'])} → {fmt(change['after'])}")
        lines.append("")

    for title, key in (("Removed links", "removed"), ("Added links", "added"), ("Degraded links", "degraded")):
        values = diff["links"][key]
        if values:
            lines += [f"## {title}", ""]
            for item in values:
                if key == "degraded":
                    changes = item["changes"]
                    lqi = changes.get("lqi", {})
                    lines.append(f"- `{item['source']}` → `{item['target']}`: LQI {lqi.get('before')} → {lqi.get('after')} (Δ {lqi.get('delta')})")
                else:
                    lines.append(
                        f"- `{item['source']}` → `{item['target']}`: LQI {item.get('lqi')}, "
                        f"relationship {item.get('relationship')}, routes {len(item.get('routes') or [])}"
                    )
            lines.append("")

    if diff["links"]["changed"]:
        lines += ["## Other link and route changes", ""]
        for item in diff["links"]["changed"]:
            lines.append(f"- `{item['source']}` → `{item['target']}`")
            for field, change in item["changes"].items():
                lines.append(f"  - `{field}`: {fmt(change['before'])} → {fmt(change['after'])}")
        lines.append("")

    if diff["devices"]["changed"]:
        lines += ["## Device metadata changes", ""]
        for item in diff["devices"]["changed"]:
            lines.append(f"- `{item['ieee']}`")
            for field, change in item["changes"].items():
                lines.append(f"  - `{field}`: {fmt(change['before'])} → {fmt(change['after'])}")
        lines.append("")

    lines += [
        "## LQI statistics",
        "",
        f"- Before: {fmt(diff['lqi_statistics']['before'])}",
        f"- After: {fmt(diff['lqi_statistics']['after'])}",
        "",
        "## Interpretation notes",
        "",
        "- IEEE addresses identify devices; short network addresses can change after a restart and are not device replacements.",
        "- Links are directional and LQI is a measurement from the scan, not a permanent radio-quality property.",
        "- A scan asks devices for neighbor information and can temporarily reduce responsiveness; avoid running it too frequently.",
        "- Compare snapshots taken under similar conditions. Battery devices may be asleep, so a missing edge can be a measurement gap rather than a permanent topology change.",
        "",
    ]
    return "\n".join(lines)


def run_diff(args: argparse.Namespace) -> Path:
    before = load_snapshot(args.before)
    after = load_snapshot(args.after)
    diff = compare(before, after, args.lqi_threshold)
    if args.output:
        output = Path(args.output).expanduser().resolve()
    else:
        after_path = Path(args.after).expanduser().resolve()
        after_dir = after_path if after_path.is_dir() else after_path.parent
        output = after_dir / "diff"
    if output.suffix.lower() == ".json":
        output.parent.mkdir(parents=True, exist_ok=True)
        json_dump(output, diff)
        markdown_path = output.with_suffix(".md")
    else:
        output.mkdir(parents=True, exist_ok=True)
        json_path = output / "diff.json"
        markdown_path = output / "diff.md"
        json_dump(json_path, diff)
    markdown_path.write_text(markdown_diff(diff), encoding="utf-8")
    print(f"Diff written to {markdown_path.parent}")
    print(json.dumps(diff["summary"], indent=2))
    return markdown_path


def add_connection_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--host", default=os.getenv("MQTT_HOST", "localhost"), help="MQTT broker host")
    parser.add_argument("--port", type=int, default=int(os.getenv("MQTT_PORT", "1883")), help="MQTT broker port")
    parser.add_argument("--username", default=os.getenv("MQTT_USERNAME"), help="MQTT username")
    parser.add_argument("--password", default=os.getenv("MQTT_PASSWORD"), help="MQTT password")
    parser.add_argument("--tls", action="store_true", help="Use TLS for the MQTT connection")
    parser.add_argument("--ca-file", help="CA bundle for TLS; system defaults are used when omitted")
    parser.add_argument("--base-topic", default=os.getenv("Z2M_BASE_TOPIC", DEFAULT_BASE_TOPIC), help="Zigbee2MQTT MQTT base topic")
    parser.add_argument("--timeout", type=float, default=180, help="Network-map response timeout in seconds")
    parser.add_argument("--connect-timeout", type=float, default=15, help="MQTT connection timeout in seconds")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    snapshot = subparsers.add_parser("snapshot", help="Capture one mesh snapshot")
    add_connection_arguments(snapshot)
    snapshot.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR, help="Directory containing snapshots")
    snapshot.add_argument("--label", help="Human-readable label, e.g. before-outage")
    snapshot.add_argument("--no-routes", dest="include_routes", action="store_false", default=True, help="Skip active-route discovery for a faster scan")
    snapshot.set_defaults(func=create_snapshot)

    watch = subparsers.add_parser("watch", help="Capture snapshots repeatedly")
    add_connection_arguments(watch)
    watch.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR, help="Directory containing snapshots")
    watch.add_argument("--interval", type=float, default=900, help="Seconds between scans; default is 15 minutes")
    watch.add_argument("--label", default="scheduled", help="Label prefix for snapshots")
    watch.add_argument("--no-routes", dest="include_routes", action="store_false", default=True, help="Skip active-route discovery for faster scans")
    watch.set_defaults(func=watch_snapshots)

    diff = subparsers.add_parser("diff", help="Compare two snapshots")
    diff.add_argument("before", help="Earlier snapshot directory or snapshot.json")
    diff.add_argument("after", help="Later snapshot directory or snapshot.json")
    diff.add_argument("--output", help="Output directory or .json path; defaults to the after snapshot's diff directory")
    diff.add_argument("--lqi-threshold", type=int, default=15, help="Flag LQI decreases at or above this value")
    diff.set_defaults(func=run_diff)
    return parser


def watch_snapshots(args: argparse.Namespace) -> None:
    print(f"Watching every {args.interval:g} seconds; press Ctrl+C to stop")
    count = 0
    while True:
        count += 1
        args.label = f"{args.label}-{count:04d}"
        try:
            create_snapshot(args)
        except Exception as exc:
            print(f"Snapshot failed: {exc}", file=sys.stderr)
        args.label = args.label.rsplit("-", 1)[0]
        time.sleep(max(1, args.interval))


def main() -> int:
    args = build_parser().parse_args()
    try:
        args.func(args)
    except KeyboardInterrupt:
        print("Stopped")
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
