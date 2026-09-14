const state = {
  snapshots: [], selectedId: null, diff: null, jobPoll: null,
  currentMap: null, diffMap: null, activeInspectorMap: null, inspectorMode: "current",
  currentCy: null, diffCy: null, inspectorCy: null, mapLayout: "hierarchy", mapLinkMode: "backbone", mapLabelMode: "all", mapMinLqi: 0,
  mapView: { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 },
};

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[char]));
const formatDate = (value) => value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
const shortId = (value) => value ? `${value.slice(0, 8)}…${value.slice(-5)}` : "—";
const datedLabel = (prefix = "networkmap") => prefix + "-" + new Date().toISOString().replace("T", "-").replace(/:/g, "-").replace(".", "-");

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function toast(message, error = false) {
  const element = $("toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 5500);
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) { button.dataset.oldLabel = button.textContent; button.textContent = label; }
  else if (button.dataset.oldLabel) button.textContent = button.dataset.oldLabel;
}

async function loadSnapshots() {
  const data = await api("/api/snapshots");
  state.snapshots = data.snapshots || [];
  $("snapshotCount").textContent = state.snapshots.length;
  renderSelects();
  renderRows();
  if (state.snapshots.length && !state.selectedId) selectSnapshot(state.snapshots[0].id);
}

function renderSelects() {
  const before = $("beforeSelect");
  const after = $("afterSelect");
  const previousBefore = before.value;
  const previousAfter = after.value;
  const options = state.snapshots.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)} · ${escapeHtml(formatDate(item.captured_at))}</option>`).join("");
  before.innerHTML = `<option value="">Select snapshot</option>${options}`;
  after.innerHTML = `<option value="">Select snapshot</option>${options}`;
  if (state.snapshots.some((item) => item.id === previousBefore)) before.value = previousBefore;
  if (state.snapshots.some((item) => item.id === previousAfter)) after.value = previousAfter;
  if (!before.value && state.snapshots.length > 1) before.value = state.snapshots[state.snapshots.length - 1].id;
  if (!after.value && state.snapshots.length) after.value = state.snapshots[0].id;
}

function renderRows() {
  const body = $("snapshotRows");
  if (!state.snapshots.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty">No snapshots yet. Capture the first baseline from the panel.</td></tr>`;
    return;
  }
  body.innerHTML = state.snapshots.map((item) => `<tr class="${item.id === state.selectedId ? "selected-row" : ""}">
    <td class="row-date">${escapeHtml(formatDate(item.captured_at))}</td>
    <td><span class="row-label">${escapeHtml(item.label)}</span><br><span class="muted small">${escapeHtml(item.id)}</span></td>
    <td>${item.nodes}</td><td>${item.links}</td><td>${escapeHtml(item.network?.channel ?? "—")}</td>
    <td><button class="tiny-button" data-open="${escapeHtml(item.id)}">Inspect</button></td>
  </tr>`).join("");
  body.querySelectorAll("[data-open]").forEach((button) => button.addEventListener("click", () => selectSnapshot(button.dataset.open)));
}

async function selectSnapshot(id) {
  state.selectedId = id;
  renderRows();
  try {
    const data = await api(`/api/snapshot/${encodeURIComponent(id)}`);
    renderMap(data, state.snapshots.find((item) => item.id === id));
  } catch (error) { toast(error.message, true); }
}

function lqiColor(lqi) {
  const value = Math.max(0, Math.min(255, Number(lqi) || 0));
  const hue = Math.round((value / 255) * 105);
  return `hsl(${hue}, 68%, 57%)`;
}

function layoutNodes(nodes) {
  // Use a responsive grid instead of a fixed 6-column layout. Large meshes
  // used to place rows below the 600px SVG viewBox, which clipped the map.
  const coordinator = nodes.filter((node) => String(node.type).toLowerCase() === "coordinator");
  const routers = nodes.filter((node) => String(node.type).toLowerCase() === "router");
  const endDevices = nodes.filter((node) => !coordinator.includes(node) && !routers.includes(node));
  const positions = {};
  const marginX = 100;
  const cellWidth = 132;
  const cellHeight = 112;
  const rowGap = 58;
  let width = 1400;
  let y = 82;

  const placeGrid = (items) => {
    if (!items.length) return;
    const columns = Math.max(1, Math.min(12, Math.ceil(Math.sqrt(items.length))));
    const rows = Math.ceil(items.length / columns);
    width = Math.max(width, (columns - 1) * cellWidth + marginX * 2);
    const startX = (width - (columns - 1) * cellWidth) / 2;
    items.forEach((node, index) => {
      const row = Math.floor(index / columns);
      const col = index % columns;
      positions[node.ieeeAddr] = { x: startX + col * cellWidth, y: y + row * cellHeight };
    });
    y += rows * cellHeight + rowGap;
  };

  if (coordinator[0]) {
    positions[coordinator[0].ieeeAddr] = { x: width / 2, y };
    y += 125;
  }
  placeGrid(routers);
  placeGrid(endDevices);
  nodes.forEach((node, index) => {
    if (!positions[node.ieeeAddr]) positions[node.ieeeAddr] = { x: marginX + (index % 10) * cellWidth, y: y + Math.floor(index / 10) * cellHeight };
  });
  return { positions, width, height: Math.max(700, y + 90) };
}

function displayName(node) {
  const name = node.friendlyName || node.ieeeAddr || "Unknown";
  return name;
}

function mapLinkKey(source, target) {
  return `${String(source || "").toLowerCase()}|${String(target || "").toLowerCase()}`;
}

function mapNodeColor(node, status = "stable") {
  if (status === "added") return "#72e0bc";
  if (status === "removed") return "#ef7772";
  if (status === "changed") return "#f3be69";
  const kind = String(node.type || "").toLowerCase();
  return kind === "coordinator" ? "#72e0bc" : kind === "router" ? "#84b9ee" : "#f3be69";
}

function graphAddress(value, fallback = "unknown") {
  return String(value || fallback).trim();
}

function graphNodeId(address) {
  return `node-${String(address).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function graphNodeKind(node) {
  const kind = String(node?.type || "unknown").toLowerCase();
  return kind === "coordinator" ? "coordinator" : kind === "router" ? "router" : "end-device";
}

function graphLabel(value) {
  return String(value || "Unknown");
}

function graphVisibleLabel(node, labelMode = state.mapLabelMode) {
  const kind = graphNodeKind(node);
  const raw = node.friendlyName || node.ieeeAddr || "Unknown";
  if (labelMode === "all") return graphLabel(raw);
  return kind === "coordinator" ? "Coordinator" : "";
}

function uniqueMeshLinks(links) {
  const connections = new Map();
  (links || []).forEach((link) => {
    const source = graphAddress(link.sourceIeeeAddr || link.source || link.from, "");
    const target = graphAddress(link.targetIeeeAddr || link.target || link.to, "");
    if (!source || !target || source.toLowerCase() === target.toLowerCase()) return;
    const sourceKey = source.toLowerCase();
    const targetKey = target.toLowerCase();
    const [first, second] = [sourceKey, targetKey].sort();
    const key = `${first}|${second}`;
    const lqiValue = Number(link.linkquality ?? link.lqi ?? link.LQI ?? 0);
    const lqi = Number.isFinite(lqiValue) ? Math.max(0, Math.min(255, lqiValue)) : 0;
    const current = connections.get(key);
    if (!current) {
      connections.set(key, {
        sourceIeeeAddr: source,
        targetIeeeAddr: target,
        lqi,
        minLqi: lqi,
        maxLqi: lqi,
        directionCount: 1,
      });
      return;
    }
    current.minLqi = Math.min(current.minLqi, lqi);
    current.maxLqi = Math.max(current.maxLqi, lqi);
    current.lqi = Math.round((current.minLqi + current.maxLqi) / 2);
    current.directionCount += 1;
  });
  return [...connections.values()];
}

function backboneMeshLinks(nodes, links, options = {}) {
  const connections = uniqueMeshLinks(links);
  if (options.linkMode === "all") return connections;
  const addresses = new Set((nodes || []).map((node, index) => graphAddress(node.ieeeAddr || node.id, `unknown-${index + 1}`).toLowerCase()));
  const parent = new Map([...addresses].map((address) => [address, address]));
  const find = (address) => {
    let current = address;
    while (parent.get(current) !== current) { parent.set(current, parent.get(parent.get(current))); current = parent.get(current); }
    return current;
  };
  const union = (left, right) => {
    const rootLeft = find(left), rootRight = find(right);
    if (rootLeft === rootRight) return false;
    parent.set(rootRight, rootLeft);
    return true;
  };
  const selected = [];
  [...connections].sort((left, right) => right.lqi - left.lqi).forEach((link) => {
    const source = link.sourceIeeeAddr.toLowerCase();
    const target = link.targetIeeeAddr.toLowerCase();
    if (parent.has(source) && parent.has(target) && union(source, target)) selected.push(link);
  });
  const changed = new Set((options.highlightLinks || []).map((link) => mapLinkKey(link.sourceIeeeAddr, link.targetIeeeAddr)));
  connections.forEach((link) => {
    const key = mapLinkKey(link.sourceIeeeAddr, link.targetIeeeAddr);
    const reverse = mapLinkKey(link.targetIeeeAddr, link.sourceIeeeAddr);
    if ((changed.has(key) || changed.has(reverse)) && !selected.some((item) => mapLinkKey(item.sourceIeeeAddr, item.targetIeeeAddr) === key || mapLinkKey(item.sourceIeeeAddr, item.targetIeeeAddr) === reverse)) selected.push(link);
  });
  return selected;
}

function graphModel(nodes, links, options = {}) {
  const nodeMap = new Map();
  (nodes || []).forEach((node, index) => {
    const address = graphAddress(node.ieeeAddr || node.id, `unknown-${index + 1}`);
    nodeMap.set(address.toLowerCase(), { ...node, ieeeAddr: address });
  });
  const connections = uniqueMeshLinks(links);
  connections.forEach((link) => {
    [link.sourceIeeeAddr, link.targetIeeeAddr].forEach((address) => {
      if (!nodeMap.has(address.toLowerCase())) nodeMap.set(address.toLowerCase(), { ieeeAddr: address, type: "unknown", friendlyName: address });
    });
  });

  const adjacency = new Map([...nodeMap.keys()].map((key) => [key, []]));
  connections.forEach((link) => {
    const source = link.sourceIeeeAddr.toLowerCase();
    const target = link.targetIeeeAddr.toLowerCase();
    adjacency.get(source)?.push(target);
    adjacency.get(target)?.push(source);
  });
  const root = [...nodeMap.values()].find((node) => graphNodeKind(node) === "coordinator")?.ieeeAddr?.toLowerCase() || [...nodeMap.keys()][0];
  const levels = new Map(root ? [[root, 0]] : []);
  const queue = root ? [root] : [];
  while (queue.length) {
    const current = queue.shift();
    (adjacency.get(current) || []).forEach((neighbor) => {
      if (!levels.has(neighbor)) { levels.set(neighbor, levels.get(current) + 1); queue.push(neighbor); }
    });
  }

  const nodeStatus = options.nodeStatus || (() => "stable");
  const linkStatus = options.linkStatus || (() => "stable");
  const graphNodes = [...nodeMap.values()].map((node) => {
    const status = nodeStatus(node);
    const kind = graphNodeKind(node);
    const label = graphVisibleLabel(node, options.labelMode);
    return {
      data: { id: graphNodeId(node.ieeeAddr), address: node.ieeeAddr, baseLabel: node.friendlyName || node.ieeeAddr || "Unknown", label, kind, status, level: levels.get(node.ieeeAddr.toLowerCase()) ?? 0 },
      classes: `${kind} ${status}`,
    };
  });
  const graphEdges = connections.map((link, index) => {
    const sourceKey = link.sourceIeeeAddr.toLowerCase();
    const targetKey = link.targetIeeeAddr.toLowerCase();
    const sourceLevel = levels.get(sourceKey) ?? 0;
    const targetLevel = levels.get(targetKey) ?? 0;
    const source = sourceLevel <= targetLevel ? link.sourceIeeeAddr : link.targetIeeeAddr;
    const target = sourceLevel <= targetLevel ? link.targetIeeeAddr : link.sourceIeeeAddr;
    const status = linkStatus(link);
    return {
      data: {
        id: `edge-${index}-${graphNodeId(link.sourceIeeeAddr)}-${graphNodeId(link.targetIeeeAddr)}`,
        source: graphNodeId(source), target: graphNodeId(target),
        sourceAddress: source, targetAddress: target,
        sourceLabel: nodeMap.get(source.toLowerCase())?.friendlyName || source,
        targetLabel: nodeMap.get(target.toLowerCase())?.friendlyName || target,
        lqi: link.lqi, minLqi: link.minLqi, maxLqi: link.maxLqi,
        directionCount: link.directionCount, status,
        color: status === "added" ? "#72e0bc" : status === "removed" ? "#ef7772" : status === "changed" ? "#f3be69" : lqiColor(link.lqi),
      },
      classes: status,
    };
  });
  return { elements: [...graphNodes, ...graphEdges], nodes: graphNodes, edges: graphEdges, connections: connections.length };
}

function graphStyle() {
  return [
    { selector: "node", style: {
      "background-color": "#f3be69", "border-color": "#081018", "border-width": 2,
      "color": "#dce7e8", "font-size": 11, "font-weight": 600,
      "label": "data(label)", "text-wrap": "wrap", "text-overflow-wrap": "anywhere", "text-max-width": 220,
      "text-valign": "bottom", "text-halign": "center", "text-justification": "center", "text-margin-y": 12,
      "text-background-color": "#0b1017", "text-background-opacity": 0.84, "text-background-padding": 3,
      "text-outline-color": "#0b1017", "text-outline-width": 2,
      "width": 36, "height": 36,
    } },
    { selector: "node.coordinator", style: { "background-color": "#72e0bc", "width": 44, "height": 44, "border-width": 3 } },
    { selector: "node.router", style: { "background-color": "#84b9ee" } },
    { selector: "node.added", style: { "background-color": "#72e0bc", "border-color": "#72e0bc", "border-width": 3 } },
    { selector: "node.removed", style: { "background-color": "#ef7772", "border-color": "#ef7772", "border-width": 3 } },
    { selector: "node.changed", style: { "background-color": "#f3be69", "border-color": "#f3be69", "border-width": 3 } },
    { selector: "node:selected", style: { "border-color": "#ffffff", "border-width": 4 } },
    { selector: "edge", style: {
      "curve-style": "haystack", "haystack-radius": 0.25,
      "line-color": "data(color)", "width": "mapData(lqi, 0, 255, 0.8, 4.5)", "opacity": 0.28,
    } },
    { selector: "edge.added", style: { "opacity": 0.95, "width": 4 } },
    { selector: "edge.removed", style: { "line-style": "dashed", "opacity": 0.95, "width": 4 } },
    { selector: "edge.changed", style: { "line-style": "dashed", "opacity": 0.95, "width": 4 } },
    { selector: "edge:selected", style: { "opacity": 1, "width": 6 } },
  ];
}

function runGraphLayout(cy, layoutName = state.mapLayout) {
  if (!cy) return;
  const name = layoutName === "radial" ? "concentric" : layoutName === "force" ? "cose" : (window.cytoscapeDagre ? "dagre" : "breadthfirst");
  const options = name === "dagre"
      ? { name, rankDir: "TB", ranker: "network-simplex", nodeDimensionsIncludeLabels: true, nodeSep: 48, edgeSep: 24, rankSep: 110, padding: 65, fit: true, animate: false }
    : name === "concentric"
      ? { name, concentric: (node) => node.data("kind") === "coordinator" ? 3 : node.data("kind") === "router" ? 2 : 1, levelWidth: () => 1, minNodeSpacing: 55, padding: 55, fit: true, animate: false }
      : name === "cose"
        ? { name, nodeRepulsion: 8500, idealEdgeLength: 105, edgeElasticity: 0.35, nestingFactor: 0.9, gravity: 0.35, numIter: 900, padding: 55, fit: true, animate: false }
        : { name, directed: true, roots: cy.nodes(".coordinator"), spacingFactor: 1.15, padding: 55, fit: true, animate: false };
  cy.layout(options).run();
  cy.fit(cy.nodes(), 45);
}

function applyGraphFilter(cy) {
  if (!cy) return;
  cy.edges().forEach((edge) => edge.style("display", Number(edge.data("lqi") || 0) >= state.mapMinLqi ? "element" : "none"));
}

function showGraphSelection(element) {
  if (!$("mapSelection") || !element) return;
  if (element.isNode()) {
    const data = element.data();
    $("mapSelection").textContent = `${data.label} · ${data.kind} · ${data.address}`;
  } else {
    const data = element.data();
    $("mapSelection").textContent = `${data.sourceLabel} ↔ ${data.targetLabel} · LQI ${data.minLqi}${data.directionCount > 1 ? ` · ${data.directionCount} directional records combined` : ""}`;
  }
}

function renderGraph(containerId, nodes, links, options = {}) {
  const container = $(containerId);
  if (!container) return { cy: null, connections: 0 };
  const displayedLinks = backboneMeshLinks(nodes, links, options);
  if (typeof window.cytoscape !== "function") {
    const fallback = buildMapSvg(nodes, displayedLinks, options);
    container.innerHTML = fallback.svg;
    return { cy: null, connections: displayedLinks.length, svg: fallback.svg };
  }
  if (container._cy) container._cy.destroy();
  if (window.cytoscapeDagre && !window.__zigbeeDagreRegistered) {
    window.cytoscape.use(window.cytoscapeDagre);
    window.__zigbeeDagreRegistered = true;
  }
  const model = graphModel(nodes, displayedLinks, options);
  const cy = window.cytoscape({ container, elements: model.elements, style: graphStyle(), layout: { name: "preset" }, wheelSensitivity: 0.18, minZoom: 0.2, maxZoom: 4, boxSelectionEnabled: false });
  container._cy = cy;
  cy.on("tap", "node", (event) => {
    if (state.mapLabelMode === "selected") {
      cy.nodes().forEach((node) => { if (node.data("kind") !== "coordinator") node.data("label", ""); });
      event.target.data("label", graphLabel(event.target.data("baseLabel")));
    }
    showGraphSelection(event.target);
  });
  cy.on("tap", "edge", (event) => showGraphSelection(event.target));
  runGraphLayout(cy, options.layoutName || state.mapLayout);
  applyGraphFilter(cy);
  return { cy, connections: model.connections, model };
}

function fitGraph(cy) {
  if (cy) cy.fit(cy.nodes(), 45);
}

function rerenderStoredGraph(map, containerId, mapType) {
  if (!map) return;
  map.graphOptions = { ...(map.graphOptions || {}), layoutName: state.mapLayout, linkMode: state.mapLinkMode, labelMode: state.mapLabelMode };
  const rendered = renderGraph(containerId, map.nodesData, map.linksData, map.graphOptions);
  if (mapType === "current") state.currentCy = rendered.cy;
  if (mapType === "diff") state.diffCy = rendered.cy;
  map.connections = rendered.connections;
  if (mapType === "current" && $("mapSelection")) $("mapSelection").textContent = "Click a node or link to inspect it.";
}

function buildMapSvg(nodes, links, options = {}) {
  const layout = layoutNodes(nodes);
  const linkStatus = options.linkStatus || (() => "stable");
  const nodeStatus = options.nodeStatus || (() => "stable");
  const lines = links.map((link) => {
    const source = layout.positions[link.sourceIeeeAddr], target = layout.positions[link.targetIeeeAddr];
    if (!source || !target) return "";
    const lqi = link.linkquality ?? link.lqi ?? 0;
    const status = linkStatus(link);
    const stroke = status === "added" ? "#72e0bc" : status === "removed" ? "#ef7772" : status === "changed" ? "#f3be69" : lqiColor(lqi);
    const opacity = status === "stable" ? ".22" : ".9";
    const dash = status === "removed" ? "9 7" : status === "changed" ? "3 5" : "";
    const width = status === "stable" ? 1.3 : Math.max(2.2, Math.min(6, Number(lqi) / 55));
    const statusLabel = status === "stable" ? "" : ` · ${status}`;
    return `<line class="map-link" x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}" ${dash ? `stroke-dasharray="${dash}"` : ""}><title>${escapeHtml(link.sourceIeeeAddr)} → ${escapeHtml(link.targetIeeeAddr)} · LQI ${escapeHtml(lqi)}${statusLabel}</title></line>`;
  }).join("");
  const dots = nodes.map((node) => {
    const point = layout.positions[node.ieeeAddr];
    const status = nodeStatus(node);
    const meta = `${status === "stable" ? node.type || "Unknown" : status} · ${node.ieeeAddr || ""}`;
    return `<g><circle class="map-node" cx="${point.x}" cy="${point.y}" r="16" fill="${mapNodeColor(node, status)}"><title>${escapeHtml(meta)}</title></circle><text class="map-label" x="${point.x}" y="${point.y + 34}" text-anchor="middle">${escapeHtml(displayName(node))}</text><text class="map-meta" x="${point.x}" y="${point.y + 47}" text-anchor="middle">${escapeHtml(node.type || "Unknown")}</text></g>`;
  }).join("");
  const svg = `<svg viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="Zigbee network map"><defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#78919a"></path></marker></defs>${lines}${dots}</svg>`;
  return { svg, width: layout.width, height: layout.height };
}

function applyMapView() {
  const cy = state.inspectorCy;
  if (!cy) return;
  cy.zoom(state.mapView.scale);
  $("zoomValue").textContent = `${Math.round(state.mapView.scale * 100)}%`;
}

function resetMapView() {
  if (!state.inspectorCy) return;
  state.inspectorCy.fit(state.inspectorCy.nodes(), 55);
  state.mapView.scale = state.inspectorCy.zoom();
  $("zoomValue").textContent = `${Math.round(state.mapView.scale * 100)}%`;
}

function changeMapZoom(delta) {
  if (!state.inspectorCy) return;
  const nextZoom = Math.max(0.2, Math.min(4, Number((state.inspectorCy.zoom() + delta).toFixed(2))));
  state.inspectorCy.zoom({ level: nextZoom, renderedPosition: { x: state.inspectorCy.width() / 2, y: state.inspectorCy.height() / 2 } });
  state.mapView.scale = nextZoom;
  $("zoomValue").textContent = `${Math.round(nextZoom * 100)}%`;
}

function renderInspectorMap(map = state.activeInspectorMap) {
  if (!map) return;
  $("inspectorMapTitle").textContent = map.title;
  $("inspectorNodes").textContent = map.nodes;
  $("inspectorLinks").textContent = map.connections ?? map.links;
  if (state.inspectorCy) state.inspectorCy.destroy();
  $("inspectorMapCanvas").innerHTML = `<div id="inspectorGraph" class="graph-surface"></div>`;
  const rendered = renderGraph("inspectorGraph", map.nodesData, map.linksData, map.graphOptions || {});
  state.inspectorCy = rendered.cy;
  resetMapView();
}

function openMapInspector(mode = "current") {
  const map = mode === "diff" ? state.diffMap : state.currentMap;
  if (!map) return;
  state.inspectorMode = mode;
  state.activeInspectorMap = map;
  renderInspectorMap(map);
  $("mapInspector").classList.remove("hidden");
  document.body.classList.add("modal-open");
  $("closeMapInspector").focus();
}

function closeMapInspector() {
  $("mapInspector").classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function wireMapInspector() {
  // Cytoscape owns wheel zooming and drag-to-pan in both the inline and full-screen views.
}

function renderMap(snapshot, summary) {
  const map = snapshot.networkmap || {};
  const nodes = map.nodes || [];
  const links = map.links || [];
  const title = summary ? `${summary.label} · network map` : "Network map";
  $("mapTitle").textContent = title;
  $("selectedNodes").textContent = nodes.length || "0";
  const connectionCount = uniqueMeshLinks(links).length;
  const visibleConnectionCount = backboneMeshLinks(nodes, links, { linkMode: state.mapLinkMode }).length;
  $("selectedLinks").textContent = `${connectionCount} total connections · ${visibleConnectionCount} shown · ${links.length} directed records`;
  if (!nodes.length) {
    state.currentMap = null;
    if (state.currentCy) state.currentCy.destroy();
    state.currentCy = null;
    $("fullscreenMapButton").disabled = true;
    $("fitMapButton").disabled = true;
    $("mapCanvas").innerHTML = `<div class="map-empty">This snapshot contains no nodes.</div>`;
    return;
  }
  if (state.currentCy) state.currentCy.destroy();
  state.currentMap = { title, nodes: nodes.length, links: links.length, connections: visibleConnectionCount, totalConnections: connectionCount, nodesData: nodes, linksData: links, graphOptions: { linkMode: state.mapLinkMode, labelMode: state.mapLabelMode } };
  $("mapCanvas").innerHTML = `<div id="currentGraph" class="graph-surface"></div>`;
  const rendered = renderGraph("currentGraph", nodes, links, state.currentMap.graphOptions);
  state.currentCy = rendered.cy;
  $("fullscreenMapButton").disabled = false;
  $("fitMapButton").disabled = !state.currentCy;
  if (!$("mapInspector").classList.contains("hidden") && state.inspectorMode === "current") {
    state.activeInspectorMap = state.currentMap;
    renderInspectorMap(state.currentMap);
  }
}

async function renderDiffMap(beforeId, afterId, diff) {
  const [beforeSnapshot, afterSnapshot] = await Promise.all([
    api("/api/snapshot/" + encodeURIComponent(beforeId)),
    api("/api/snapshot/" + encodeURIComponent(afterId)),
  ]);
  const beforeMap = beforeSnapshot.networkmap || {};
  const afterMap = afterSnapshot.networkmap || {};
  const nodeById = new Map();
  [...(beforeMap.nodes || []), ...(afterMap.nodes || [])].forEach((node) => {
    if (node.ieeeAddr) nodeById.set(String(node.ieeeAddr).toLowerCase(), node);
  });
  const linkByKey = new Map();
  [...(beforeMap.links || []), ...(afterMap.links || [])].forEach((link) => {
    const key = mapLinkKey(link.sourceIeeeAddr, link.targetIeeeAddr);
    if (key !== "|") linkByKey.set(key, link);
  });
  const addedNodes = new Set((diff.nodes.added || []).map((item) => String(item.ieee).toLowerCase()));
  const removedNodes = new Set((diff.nodes.removed || []).map((item) => String(item.ieee).toLowerCase()));
  const changedNodes = new Set((diff.nodes.changed || []).map((item) => String(item.ieee).toLowerCase()));
  const addedLinks = new Set((diff.links.added || []).map((item) => mapLinkKey(item.source, item.target)));
  const removedLinks = new Set((diff.links.removed || []).map((item) => mapLinkKey(item.source, item.target)));
  const changedLinks = new Set((diff.links.changed || []).map((item) => mapLinkKey(item.source, item.target)));
  const nodes = [...nodeById.values()];
  const links = [...linkByKey.values()];
  const highlightLinks = links.filter((link) => {
    const forward = mapLinkKey(link.sourceIeeeAddr, link.targetIeeeAddr);
    const reverse = mapLinkKey(link.targetIeeeAddr, link.sourceIeeeAddr);
    return addedLinks.has(forward) || addedLinks.has(reverse) || removedLinks.has(forward) || removedLinks.has(reverse) || changedLinks.has(forward) || changedLinks.has(reverse);
  });
  const graphOptions = {
    layoutName: state.mapLayout,
    linkMode: state.mapLinkMode,
    labelMode: state.mapLabelMode,
    highlightLinks,
    nodeStatus: (node) => {
      const key = String(node.ieeeAddr || "").toLowerCase();
      return addedNodes.has(key) ? "added" : removedNodes.has(key) ? "removed" : changedNodes.has(key) ? "changed" : "stable";
    },
    linkStatus: (link) => {
      const forward = mapLinkKey(link.sourceIeeeAddr, link.targetIeeeAddr);
      const reverse = mapLinkKey(link.targetIeeeAddr, link.sourceIeeeAddr);
      return addedLinks.has(forward) || addedLinks.has(reverse) ? "added"
        : removedLinks.has(forward) || removedLinks.has(reverse) ? "removed"
          : changedLinks.has(forward) || changedLinks.has(reverse) ? "changed" : "stable";
    },
  };
  state.diffMap = {
    title: String(diff.after?.label || "After") + " · changes from " + String(diff.before?.label || "before"),
    nodes: nodes.length,
    links: links.length,
    connections: backboneMeshLinks(nodes, links, graphOptions).length,
    nodesData: nodes,
    linksData: links,
    graphOptions,
  };
  if (state.diffCy) state.diffCy.destroy();
  $("diffMapCanvas").innerHTML = `<div id="diffGraph" class="graph-surface"></div>`;
  const rendered = renderGraph("diffGraph", nodes, links, graphOptions);
  state.diffCy = rendered.cy;
  $("diffMapSection").classList.remove("hidden");
  $("fullscreenDiffMapButton").disabled = false;
  if (!$("mapInspector").classList.contains("hidden") && state.inspectorMode === "diff") {
    state.activeInspectorMap = state.diffMap;
    renderInspectorMap(state.diffMap);
  }
}

function diffList(items, formatter) {
  if (!items?.length) return `<li class="muted">None</li>`;
  return items.map(formatter).join("");
}

function renderDiff(diff) {
  state.diff = diff;
  const summary = diff.summary;
  $("comparisonState").textContent = `${summary.changed_links + summary.added_nodes + summary.removed_nodes} changes`;
  $("comparisonHint").textContent = `${summary.degraded_links} degraded links · ${summary.route_changes} route changes`;
  const after = $("afterSelect").value;
  $("markdownLink").href = `/api/diff-markdown?after=${encodeURIComponent(after)}`;
  $("markdownLink").classList.remove("disabled");
  const node = (item) => `<li><strong>${escapeHtml(item.friendly_name || item.ieee)}</strong><br><span class="muted">${escapeHtml(item.ieee)} · ${escapeHtml(item.type || "unknown")}</span></li>`;
  const link = (item) => `<li><strong>${shortId(item.source)} → ${shortId(item.target)}</strong><br><span class="muted">LQI ${escapeHtml(item.lqi)} · ${escapeHtml(item.relationship ?? "—")}</span></li>`;
  const degraded = (item) => { const c = item.changes?.lqi || {}; return `<li><strong>${shortId(item.source)} → ${shortId(item.target)}</strong><br><span class="muted">LQI ${escapeHtml(c.before)} → ${escapeHtml(c.after)} (Δ ${escapeHtml(c.delta)})</span></li>`; };
  const route = (item) => `<li><strong>${shortId(item.source)} → ${shortId(item.target)}</strong><br><span class="muted">Route table changed</span></li>`;
  $("diffContent").innerHTML = `<div class="diff-content">
    <div class="diff-summary">
      <div class="diff-stat"><strong>${summary.added_nodes}</strong><span>nodes added</span></div>
      <div class="diff-stat"><strong>${summary.removed_nodes}</strong><span>nodes removed</span></div>
      <div class="diff-stat"><strong>${summary.degraded_links}</strong><span>degraded links</span></div>
      <div class="diff-stat"><strong>${summary.route_changes}</strong><span>route changes</span></div>
    </div>
    <div class="diff-grid">
      <div class="diff-box good"><h3>Added nodes</h3><ul>${diffList(diff.nodes.added, node)}</ul></div>
      <div class="diff-box danger"><h3>Removed nodes</h3><ul>${diffList(diff.nodes.removed, node)}</ul></div>
      <div class="diff-box warning"><h3>Degraded links</h3><ul>${diffList(diff.links.degraded, degraded)}</ul></div>
      <div class="diff-box info"><h3>Added links</h3><ul>${diffList(diff.links.added, link)}</ul></div>
      <div class="diff-box danger"><h3>Removed links</h3><ul>${diffList(diff.links.removed, link)}</ul></div>
      <div class="diff-box warning"><h3>Active-route changes</h3><ul>${diffList(diff.links.route_changes, route)}</ul></div>
    </div>
  </div>`;
}

async function pollJob(jobId, button, successMessage) {
  clearInterval(state.jobPoll);
  state.jobPoll = setInterval(async () => {
    try {
      const job = await api(`/api/job/${jobId}`);
      if (job.status === "done") {
        clearInterval(state.jobPoll); setBusy(button, false); toast(successMessage); await loadSnapshots();
        if (job.snapshot_id) selectSnapshot(job.snapshot_id);
        if (job.kind === "diff") await loadDiff(job.before, job.after);
      } else if (job.status === "error") {
        clearInterval(state.jobPoll); setBusy(button, false); toast(job.message || "Operation failed", true);
      }
    } catch (error) { clearInterval(state.jobPoll); setBusy(button, false); toast(error.message, true); }
  }, 900);
}

async function capture() {
  const button = $("snapshotButton"); setBusy(button, true, "Capturing…");
  try {
    const data = await api("/api/snapshot", { method: "POST", body: JSON.stringify({
      host: $("mqttHost").value.trim(), port: Number($("mqttPort").value), base_topic: $("baseTopic").value.trim(),
      username: $("mqttUsername").value, password: $("mqttPassword").value, tls: $("mqttTls").checked,
      include_routes: $("includeRoutes").checked,
      label: $("snapshotLabel").value.trim() || datedLabel("capture"), timeout: 180,
    }) });
    toast("Capture started. The map will appear when the scan finishes."); pollJob(data.job_id, button, "Snapshot captured");
  } catch (error) { setBusy(button, false); toast(error.message, true); }
}

async function importFile(file) {
  if (!file) return;
  try {
    const content = await file.text();
    await importContent(content, $("snapshotLabel").value.trim() || datedLabel("networkmap"), `Imported ${file.name}`);
  } catch (error) { toast(error.message, true); }
}

async function importContent(content, label, successMessage) {
  const data = await api("/api/import", { method: "POST", body: JSON.stringify({ content, label }) });
  toast(successMessage);
  const previousSnapshot = state.selectedId;
  await loadSnapshots();
  if (data.snapshot_id) {
    const before = previousSnapshot && previousSnapshot !== data.snapshot_id
      ? previousSnapshot
      : state.snapshots.find((item) => item.id !== data.snapshot_id)?.id || "";
    $("beforeSelect").value = before;
    $("afterSelect").value = data.snapshot_id;
    await selectSnapshot(data.snapshot_id);
    // Re-apply the pair after rendering the newly selected snapshot so the
    // imported map is immediately ready as the "after" side of a comparison.
    renderSelects();
    $("beforeSelect").value = before;
    $("afterSelect").value = data.snapshot_id;
    state.diff = null;
    state.diffMap = null;
    $("diffMapSection").classList.add("hidden");
    $("diffContent").innerHTML = '<div class="diff-empty">Run a comparison to see changes between two meshes.</div>';
    $("comparisonState").textContent = "Ready";
    $("comparisonHint").textContent = "select before and after";
    $("markdownLink").classList.add("disabled");
    $("markdownLink").removeAttribute("href");
  }
}

async function importPastedContent() {
  const content = $("importText").value.trim();
  if (!content) { toast("Paste the raw MQTT response JSON first", true); return; }
  try {
    await importContent(content, $("snapshotLabel").value.trim() || datedLabel("networkmap"), "Imported pasted MQTT response");
    $("importText").value = "";
  } catch (error) { toast(error.message, true); }
}

async function loadDiff(before, after) {
  try {
    const data = await api(`/api/diff?before=${encodeURIComponent(before)}&after=${encodeURIComponent(after)}`);
    if (data.available) {
      renderDiff(data.diff);
      await renderDiffMap(before, after, data.diff);
    } else {
      $("diffContent").innerHTML = `<div class="diff-empty">No report available yet.</div>`;
      $("diffMapSection").classList.add("hidden");
      state.diffMap = null;
    }
  } catch (error) { toast(error.message, true); }
}

async function compareMeshes() {
  const before = $("beforeSelect").value, after = $("afterSelect").value;
  if (!before || !after || before === after) { toast("Choose two different snapshots.", true); return; }
  const button = $("compareButton"); setBusy(button, true, "Comparing…");
  try {
    const data = await api("/api/diff", { method: "POST", body: JSON.stringify({ before, after, lqi_threshold: Number($("lqiThreshold").value) || 15 }) });
    toast("Comparison started."); pollJob(data.job_id, button, "Comparison ready");
  } catch (error) { setBusy(button, false); toast(error.message, true); }
}

async function init() {
  try { await api("/api/health"); $("serverStatus").className = "status-pill ok"; $("serverStatus").innerHTML = `<span class="dot"></span> Local server ready`; await loadSnapshots(); }
  catch (error) { $("serverStatus").className = "status-pill error"; $("serverStatus").innerHTML = `<span class="dot"></span> Server error`; toast(error.message, true); }
  $("snapshotButton").addEventListener("click", capture);
  $("importButton").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", (event) => importFile(event.target.files[0]));
  $("pasteImportButton").addEventListener("click", importPastedContent);
  $("fullscreenMapButton").addEventListener("click", openMapInspector);
  $("fullscreenDiffMapButton").addEventListener("click", () => openMapInspector("diff"));
  $("closeMapInspector").addEventListener("click", closeMapInspector);
  $("zoomInButton").addEventListener("click", () => changeMapZoom(.1));
  $("zoomOutButton").addEventListener("click", () => changeMapZoom(-.1));
  $("resetMapViewButton").addEventListener("click", resetMapView);
  $("mapInspector").addEventListener("click", (event) => { if (event.target === $("mapInspector")) closeMapInspector(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("mapInspector").classList.contains("hidden")) closeMapInspector(); });
  wireMapInspector();
  $("mapLayoutSelect").addEventListener("change", () => {
    state.mapLayout = $("mapLayoutSelect").value;
    runGraphLayout(state.currentCy, state.mapLayout);
    runGraphLayout(state.diffCy, state.mapLayout);
    if (state.inspectorCy) runGraphLayout(state.inspectorCy, state.mapLayout);
  });
  $("mapLinkModeSelect").addEventListener("change", () => {
    state.mapLinkMode = $("mapLinkModeSelect").value;
    rerenderStoredGraph(state.currentMap, "currentGraph", "current");
    rerenderStoredGraph(state.diffMap, "diffGraph", "diff");
    if (!$('mapInspector').classList.contains('hidden') && state.activeInspectorMap) renderInspectorMap(state.activeInspectorMap);
  });
  $("mapLabelModeSelect").addEventListener("change", () => {
    state.mapLabelMode = $("mapLabelModeSelect").value;
    rerenderStoredGraph(state.currentMap, "currentGraph", "current");
    rerenderStoredGraph(state.diffMap, "diffGraph", "diff");
    if (!$('mapInspector').classList.contains('hidden') && state.activeInspectorMap) renderInspectorMap(state.activeInspectorMap);
  });
  $("mapLqiRange").addEventListener("input", () => {
    state.mapMinLqi = Number($("mapLqiRange").value) || 0;
    $("mapLqiValue").value = state.mapMinLqi;
    $("mapLqiValue").textContent = state.mapMinLqi;
    applyGraphFilter(state.currentCy);
    applyGraphFilter(state.diffCy);
    applyGraphFilter(state.inspectorCy);
  });
  $("fitMapButton").addEventListener("click", () => fitGraph(state.currentCy));
  $("compareButton").addEventListener("click", compareMeshes);
  $("refreshButton").addEventListener("click", () => loadSnapshots().catch((error) => toast(error.message, true)));
  $("afterSelect").addEventListener("change", () => { if ($("afterSelect").value) selectSnapshot($("afterSelect").value); });
}

init();
