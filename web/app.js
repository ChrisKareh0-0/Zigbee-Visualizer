const state = {
  snapshots: [], localSnapshots: new Map(), selectedId: null, diff: null, diffMarkdownUrl: null, jobPoll: null,
  currentMap: null, diffMap: null, beforeDiffMap: null, afterDiffMap: null, activeInspectorMap: null, inspectorMode: "current",
  currentCy: null, diffCy: null, beforeDiffCy: null, afterDiffCy: null, inspectorCy: null, mapLayout: "hierarchy", mapLinkMode: "backbone", mapLabelMode: "all", mapMinLqi: 0,
  changeVisibleCount: 10, diffView: "context", page: "main",
  mapView: { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 },
};

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[char]));
const formatDate = (value) => value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
const shortId = (value) => value ? `${value.slice(0, 8)}…${value.slice(-5)}` : "—";
const datedLabel = (prefix = "networkmap") => prefix + "-" + new Date().toISOString().replace("T", "-").replace(/:/g, "-").replace(".", "-");

const LOCAL_DB_NAME = "zigbee-mesh-lab";
const LOCAL_DB_VERSION = 1;
const LOCAL_SNAPSHOT_STORE = "snapshots";
let localDbPromise = null;

function isDeployedSite() {
  return !["", "localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

function openLocalDb() {
  if (!window.indexedDB) return Promise.reject(new Error("This browser does not support local snapshot storage."));
  if (!localDbPromise) {
    localDbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
      request.onupgradeneeded = () => request.result.createObjectStore(LOCAL_SNAPSHOT_STORE, { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open local snapshot storage."));
    });
  }
  return localDbPromise;
}

function localDbRequest(mode, operation) {
  return openLocalDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(LOCAL_SNAPSHOT_STORE, mode);
    const request = operation(transaction.objectStore(LOCAL_SNAPSHOT_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Local snapshot storage failed."));
  }));
}

async function listLocalSnapshots() {
  try { return await localDbRequest("readonly", (store) => store.getAll()); }
  catch (error) { console.warn("Local snapshots unavailable", error); return []; }
}

async function readLocalSnapshot(id) {
  try { return await localDbRequest("readonly", (store) => store.get(id)); }
  catch (error) { console.warn("Local snapshot unavailable", error); return null; }
}

function writeLocalSnapshot(record) {
  return localDbRequest("readwrite", (store) => store.put(record));
}

function redactImported(value) {
  const secretNames = new Set(["network_key", "password", "key", "cert", "ca", "ssl_key", "ssl_cert"]);
  if (Array.isArray(value)) return value.map(redactImported);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, secretNames.has(key.toLowerCase()) ? "[redacted]" : redactImported(item),
    ]));
  }
  return value;
}

function snapshotNetworkSummary(snapshot) {
  const info = snapshot.bridge_info || {};
  const network = info.network || {};
  const advanced = (info.config || {}).advanced || {};
  return { channel: network.channel ?? advanced.channel ?? null };
}

function localSnapshotRecord(content, label) {
  let source;
  try { source = JSON.parse(content); }
  catch (error) { throw new Error(`The imported file is not valid JSON: ${error.message}`); }

  const embedded = source && typeof source === "object" && source.networkmap ? source : null;
  let networkmap = embedded ? embedded.networkmap : source;
  let sourceType = embedded ? "snapshot" : "raw map";
  if (!embedded && source && typeof source === "object" && source.data && typeof source.data === "object") {
    networkmap = source.data.value;
    sourceType = "MQTT response";
  }
  if (typeof networkmap === "string") {
    try { networkmap = JSON.parse(networkmap); }
    catch (error) { throw new Error("The file contains Graphviz/PlantUML text; import a raw JSON map instead"); }
  }
  if (!networkmap || typeof networkmap !== "object" || !Array.isArray(networkmap.nodes) || !Array.isArray(networkmap.links)) {
    throw new Error("Expected a raw Zigbee2MQTT map containing 'nodes' and 'links'");
  }

  const capturedAt = embedded?.captured_at || new Date().toISOString();
  const idSuffix = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const id = `local-${Date.now()}-${idSuffix}`;
  const snapshot = {
    schema: 1,
    captured_at: capturedAt,
    label: label || embedded?.label || datedLabel("networkmap"),
    mqtt_base_topic: embedded?.mqtt_base_topic || "",
    request: embedded?.request || { type: "raw", routes: null },
    source: sourceType,
    networkmap,
    bridge_info: redactImported(embedded?.bridge_info || null),
    devices: embedded?.devices || null,
    health: embedded?.health || null,
    bridge_state: embedded?.bridge_state || null,
  };
  return {
    id,
    snapshot,
    summary: {
      id,
      label: snapshot.label,
      captured_at: snapshot.captured_at,
      nodes: networkmap.nodes.length,
      links: networkmap.links.length,
      network: snapshotNetworkSummary(snapshot),
      storage: "browser",
    },
  };
}

async function getSnapshot(id) {
  const local = state.localSnapshots.get(id) || await readLocalSnapshot(id);
  if (local) return local.snapshot;
  return (await api(`/api/snapshot/${encodeURIComponent(id)}`));
}

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

function compareControls(prefix = "") {
  return {
    before: $(prefix ? `${prefix}BeforeSelect` : "beforeSelect"),
    after: $(prefix ? `${prefix}AfterSelect` : "afterSelect"),
    threshold: $(prefix ? `${prefix}LqiThreshold` : "lqiThreshold"),
    button: $(prefix ? `${prefix}CompareButton` : "compareButton"),
  };
}

function activeCompareControls() {
  return state.page === "changes" ? compareControls("changes") : compareControls();
}

function resetDiffView(message = "Choose two different snapshots, then compare them.") {
  state.diff = null;
  state.diffView = "context";
  state.diffMap = null;
  state.beforeDiffMap = null;
  state.afterDiffMap = null;
  new Set([state.diffCy, state.beforeDiffCy, state.afterDiffCy].filter(Boolean)).forEach((graph) => graph.destroy());
  state.diffCy = null;
  state.beforeDiffCy = null;
  state.afterDiffCy = null;
  if ($("diffMapSection")) $("diffMapSection").classList.add("hidden");
  if ($("diffContent")) $("diffContent").innerHTML = `<div class="diff-empty">${escapeHtml(message)}</div>`;
  if (state.diffMarkdownUrl) { URL.revokeObjectURL(state.diffMarkdownUrl); state.diffMarkdownUrl = null; }
  if ($("markdownLink")) { $("markdownLink").classList.add("disabled"); $("markdownLink").removeAttribute("href"); $("markdownLink").removeAttribute("download"); }
  if ($("comparisonState")) $("comparisonState").textContent = "Ready";
  if ($("comparisonHint")) $("comparisonHint").textContent = "select before and after";
}

function showPage(page) {
  state.page = page === "changes" ? "changes" : "main";
  $("mainPage").classList.toggle("hidden", state.page === "changes");
  $("changesPage").classList.toggle("hidden", state.page !== "changes");
  if (state.page === "changes") {
    if (window.location.hash !== "#changes") window.history.replaceState(null, "", "#changes");
  } else if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

function openChangesPage() {
  showPage("changes");
  const controls = compareControls("changes");
  if (controls.before.value && controls.after.value && controls.before.value !== controls.after.value && !state.diff) {
    loadDiff(controls.before.value, controls.after.value);
  }
}

async function loadSnapshots() {
  const [data, localRecords] = await Promise.all([api("/api/snapshots"), listLocalSnapshots()]);
  state.localSnapshots = new Map(localRecords.map((record) => [record.id, record]));
  state.snapshots = [...localRecords.map((record) => record.summary), ...(data.snapshots || [])]
    .sort((left, right) => String(right.captured_at || "").localeCompare(String(left.captured_at || "")));
  $("snapshotCount").textContent = state.snapshots.length;
  renderSelects();
  renderRows();
  if (state.snapshots.length && !state.selectedId) selectSnapshot(state.snapshots[0].id);
}

function renderSelects() {
  const options = state.snapshots.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)} · ${escapeHtml(formatDate(item.captured_at))}</option>`).join("");
  ["", "changes"].forEach((prefix) => {
    const controls = compareControls(prefix);
    const previousBefore = controls.before.value;
    const previousAfter = controls.after.value;
    controls.before.innerHTML = `<option value="">Select snapshot</option>${options}`;
    controls.after.innerHTML = `<option value="">Select snapshot</option>${options}`;
    if (state.snapshots.some((item) => item.id === previousBefore)) controls.before.value = previousBefore;
    if (state.snapshots.some((item) => item.id === previousAfter)) controls.after.value = previousAfter;
    if (!controls.before.value && state.snapshots.length > 1) controls.before.value = state.snapshots[state.snapshots.length - 1].id;
    if (!controls.after.value && state.snapshots.length) controls.after.value = state.snapshots[0].id;
  });
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
    const data = await getSnapshot(id);
    renderMap(data, state.snapshots.find((item) => item.id === id));
  } catch (error) { toast(error.message, true); }
}

function lqiColor(lqi) {
  const value = Math.max(0, Math.min(255, Number(lqi) || 0));
  if (value < 85) return "#ef7772";
  if (value < 170) return "#f3be69";
  return "#72e0bc";
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
    // Keep status nodes the same size as the main map. Dagre includes node
    // dimensions in the layout, so changing their size would move the graph.
    { selector: "node.added", style: { "background-color": "#72e0bc", "border-color": "#72e0bc" } },
    { selector: "node.removed", style: { "background-color": "#ef7772", "border-color": "#ef7772" } },
    { selector: "node.changed", style: { "background-color": "#f3be69", "border-color": "#f3be69" } },
    { selector: "node:selected", style: { "border-color": "#ffffff", "border-width": 4 } },
    { selector: "edge", style: {
      "curve-style": "haystack", "haystack-radius": 0.25,
      "line-color": "data(color)", "width": "mapData(lqi, 0, 255, 1.2, 4.5)", "opacity": 0.72,
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

function displayedGraphLinks(nodes, links, options = {}) {
  const sourceLinks = options.diffOnly && options.linkStatus
    ? (links || []).filter((link) => options.linkStatus(link) !== "stable")
    : (links || []);
  return backboneMeshLinks(nodes, sourceLinks, options);
}

function topologyGraphOptions(overrides = {}) {
  return {
    ...overrides,
    layoutName: state.mapLayout,
    linkMode: state.mapLinkMode,
    labelMode: state.mapLabelMode,
  };
}

function renderGraph(containerId, nodes, links, options = {}) {
  const container = $(containerId);
  if (!container) return { cy: null, connections: 0 };
  const displayedLinks = displayedGraphLinks(nodes, links, options);
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
  if (options.presetPositions) {
    const positions = {};
    cy.nodes().forEach((node) => {
      const position = options.presetPositions[String(node.data("address") || "").toLowerCase()];
      if (position) positions[node.id()] = position;
    });
    cy.layout({ name: "preset", positions, fit: true, padding: 55, animate: false }).run();
    cy.fit(cy.nodes(), 45);
  } else {
    runGraphLayout(cy, options.layoutName || state.mapLayout);
  }
  applyGraphFilter(cy);
  return { cy, connections: model.connections, model };
}

// Main topology maps and comparison maps deliberately share this renderer.
// The comparison layer only adds node/link status callbacks and never swaps
// to a second visualization library.
function renderTopologyGraph(containerId, map) {
  return renderGraph(containerId, map.nodesData, map.linksData, map.graphOptions || {});
}

function fitGraph(cy) {
  if (cy) cy.fit(cy.nodes(), 45);
}

function rerenderStoredGraph(map, containerId, mapType) {
  if (!map) return;
  map.graphOptions = { ...topologyGraphOptions(map.graphOptions || {}) };
  const rendered = renderTopologyGraph(containerId, map);
  if (mapType === "current") state.currentCy = rendered.cy;
  if (mapType === "diff") state.diffCy = rendered.cy;
  if (mapType === "before-diff") state.beforeDiffCy = rendered.cy;
  if (mapType === "after-diff") { state.afterDiffCy = rendered.cy; state.diffCy = rendered.cy; }
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
  const rendered = renderTopologyGraph("inspectorGraph", map);
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
  state.currentMap = { title, nodes: nodes.length, links: links.length, connections: visibleConnectionCount, totalConnections: connectionCount, nodesData: nodes, linksData: links, graphOptions: topologyGraphOptions() };
  $("mapCanvas").innerHTML = `<div id="currentGraph" class="graph-surface"></div>`;
  const rendered = renderTopologyGraph("currentGraph", state.currentMap);
  state.currentCy = rendered.cy;
  $("fullscreenMapButton").disabled = false;
  $("fitMapButton").disabled = !state.currentCy;
  if (!$("mapInspector").classList.contains("hidden") && state.inspectorMode === "current") {
    state.activeInspectorMap = state.currentMap;
    renderInspectorMap(state.currentMap);
  }
}

function buildDiffMapSide(snapshot, diff, side) {
  const map = snapshot.networkmap || {};
  const addedNodes = new Set((diff.nodes?.added || []).map((item) => String(item.ieee).toLowerCase()));
  const removedNodes = new Set((diff.nodes?.removed || []).map((item) => String(item.ieee).toLowerCase()));
  const changedNodes = new Set((diff.nodes?.changed || []).map((item) => String(item.ieee).toLowerCase()));
  const addedLinks = new Set((diff.links?.added || []).map((item) => mapLinkKey(item.source, item.target)));
  const removedLinks = new Set((diff.links?.removed || []).map((item) => mapLinkKey(item.source, item.target)));
  const changedLinks = new Set((diff.links?.changed || []).map((item) => mapLinkKey(item.source, item.target)));
  const statusForLink = (link) => {
    const forward = mapLinkKey(link.sourceIeeeAddr, link.targetIeeeAddr);
    const reverse = mapLinkKey(link.targetIeeeAddr, link.sourceIeeeAddr);
    if (side === "before") {
      return removedLinks.has(forward) || removedLinks.has(reverse) ? "removed"
        : changedLinks.has(forward) || changedLinks.has(reverse) ? "changed" : "stable";
    }
    return addedLinks.has(forward) || addedLinks.has(reverse) ? "added"
      : changedLinks.has(forward) || changedLinks.has(reverse) ? "changed" : "stable";
  };
  const nodes = map.nodes || [];
  const links = map.links || [];
  const graphOptions = topologyGraphOptions({
    // Keep the comparison map on the same clean backbone as the main map.
    // The change list still contains every changed link; the map uses the
    // backbone to make the spatial comparison readable.
    diffOnly: state.diffView === "changes",
    nodeStatus: (node) => {
      const key = String(node.ieeeAddr || "").toLowerCase();
      if (side === "before") return removedNodes.has(key) ? "removed" : changedNodes.has(key) ? "changed" : "stable";
      return addedNodes.has(key) ? "added" : changedNodes.has(key) ? "changed" : "stable";
    },
    linkStatus: statusForLink,
  });
  const displayedLinks = displayedGraphLinks(nodes, links, graphOptions);
  return {
    title: `${side === "before" ? diff.before?.label || "Before" : diff.after?.label || "After"}`,
    nodes: nodes.length,
    links: links.length,
    connections: displayedLinks.length,
    highlightedNodes: nodes.filter((node) => graphOptions.nodeStatus(node) !== "stable").length,
    highlightedLinks: displayedLinks.filter((link) => statusForLink(link) !== "stable").length,
    nodesData: nodes,
    linksData: links,
    graphOptions,
  };
}

function diffMapMeta(map) {
  const focus = state.diffView === "changes" ? "changed" : "highlighted";
  return `${map.nodes} nodes · ${map.connections} shown · ${map["highlightedNodes"]} ${focus} nodes · ${map["highlightedLinks"]} ${focus} links`;
}

function updateDiffMapFocus() {
  const showingChangesOnly = state.diffView === "changes";
  $("toggleStableDiffButton").textContent = showingChangesOnly ? "Show stable links" : "Focus changes only";
  $("diffMapFocusNote").textContent = showingChangesOnly
    ? "Showing the changed backbone only. Stable nodes remain as context; the complete change list above contains every difference."
    : "Showing the clean backbone view, organized like the main map. Added, removed, and changed items remain highlighted.";
  [
    [state.beforeDiffMap, "beforeChangeGraph", "before-diff", "beforeMapMeta"],
    [state.afterDiffMap, "afterChangeGraph", "after-diff", "afterMapMeta"],
  ].forEach(([map, containerId, mapType, metaId]) => {
    if (!map) return;
    map.graphOptions = { ...(map.graphOptions || {}), diffOnly: showingChangesOnly };
    rerenderStoredGraph(map, containerId, mapType);
    $(metaId).textContent = diffMapMeta(map);
  });
  if (!$("mapInspector").classList.contains("hidden") && state.inspectorMode === "diff" && state.diffMap) {
    state.activeInspectorMap = state.diffMap;
    renderInspectorMap(state.diffMap);
  }
}

async function renderDiffMap(beforeId, afterId, diff) {
  const [beforeSnapshot, afterSnapshot] = await Promise.all([
    getSnapshot(beforeId),
    getSnapshot(afterId),
  ]);
  state.diffView = "context";
  state.beforeDiffMap = buildDiffMapSide(beforeSnapshot, diff, "before");
  state.afterDiffMap = buildDiffMapSide(afterSnapshot, diff, "after");
  state.diffMap = state.afterDiffMap;
  if (state.beforeDiffCy) state.beforeDiffCy.destroy();
  if (state.afterDiffCy) state.afterDiffCy.destroy();
  $("beforeChangeMapCanvas").innerHTML = `<div id="beforeChangeGraph" class="graph-surface"></div>`;
  $("afterChangeMapCanvas").innerHTML = `<div id="afterChangeGraph" class="graph-surface"></div>`;
  $("diffMapSection").classList.remove("hidden");
  const beforeRendered = renderTopologyGraph("beforeChangeGraph", state.beforeDiffMap);
  const afterRendered = renderTopologyGraph("afterChangeGraph", state.afterDiffMap);
  state.beforeDiffCy = beforeRendered.cy;
  state.afterDiffCy = afterRendered.cy;
  state.diffCy = state.afterDiffCy;
  $("beforeMapTitle").textContent = state.beforeDiffMap.title;
  $("afterMapTitle").textContent = state.afterDiffMap.title;
  $("beforeMapMeta").textContent = diffMapMeta(state.beforeDiffMap);
  $("afterMapMeta").textContent = diffMapMeta(state.afterDiffMap);
  updateDiffMapFocus();
  $("fullscreenDiffMapButton").disabled = !state.afterDiffMap.nodes;
  if (!$("mapInspector").classList.contains("hidden") && state.inspectorMode === "diff") {
    state.activeInspectorMap = state.diffMap;
    renderInspectorMap(state.diffMap);
  }
}

function changeEntries(diff) {
  const entries = [];
  const add = (group, tone, items, formatter) => (items || []).forEach((item) => entries.push({ group, tone, ...formatter(item) }));
  const linkTitle = (item) => `${shortId(item.source)} → ${shortId(item.target)}`;
  add("Removed nodes", "danger", diff.nodes?.removed, (item) => ({ title: item.friendly_name || item.ieee, meta: `${item.ieee} · ${item.type || "unknown"}` }));
  add("Removed links", "danger", diff.links?.removed, (item) => ({ title: linkTitle(item), meta: `LQI ${item.lqi ?? "—"} · ${item.relationship ?? "—"}` }));
  add("Added nodes", "good", diff.nodes?.added, (item) => ({ title: item.friendly_name || item.ieee, meta: `${item.ieee} · ${item.type || "unknown"}` }));
  add("Added links", "good", diff.links?.added, (item) => ({ title: linkTitle(item), meta: `LQI ${item.lqi ?? "—"} · ${item.relationship ?? "—"}` }));
  add("Degraded links", "warning", diff.links?.degraded, (item) => { const c = item.changes?.lqi || {}; return { title: linkTitle(item), meta: `LQI ${c.before ?? "—"} → ${c.after ?? "—"} (Δ ${c.delta ?? "—"})` }; });
  const degradedKeys = new Set((diff.links?.degraded || []).map((item) => mapLinkKey(item.source, item.target)));
  add("Changed links", "warning", (diff.links?.changed || []).filter((item) => !degradedKeys.has(mapLinkKey(item.source, item.target))), (item) => { const c = item.changes?.lqi || {}; return { title: linkTitle(item), meta: c.before !== undefined || c.after !== undefined ? `LQI ${c.before ?? "—"} → ${c.after ?? "—"} (Δ ${c.delta ?? "—"})` : "Link data changed" }; });
  add("Active-route changes", "warning", diff.links?.route_changes, (item) => ({ title: linkTitle(item), meta: "Route table changed" }));
  add("Changed nodes", "warning", diff.nodes?.changed, (item) => ({ title: item.friendly_name || item.ieee, meta: `${item.ieee} · ${Object.keys(item.changes || {}).join(", ") || "device data"}` }));
  add("Device changes", "info", diff.devices?.changed, (item) => ({ title: item.friendly_name || item.ieee || "Device", meta: `${item.ieee || "—"} · device data changed` }));
  return entries;
}

function renderChangeList() {
  const list = $("changeItems");
  const count = $("changeCount");
  const loadMore = $("loadMoreChangesButton");
  if (!list || !state.diff) return;
  const entries = changeEntries(state.diff);
  const visible = entries.slice(0, state.changeVisibleCount);
  count.textContent = `${visible.length} of ${entries.length}`;
  list.innerHTML = visible.length ? visible.map((entry) => `<li class="compact-change ${entry.tone}"><span class="change-group">${escapeHtml(entry.group)}</span><span class="compact-change-copy"><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.meta)}</span></span></li>`).join("") : '<li class="empty">No changes found between these captures.</li>';
  if (loadMore) loadMore.classList.toggle("hidden", visible.length >= entries.length);
}

function renderDiff(diff, markdown = "") {
  state.diff = diff;
  state.changeVisibleCount = 10;
  const summary = diff.summary || {};
  const changeCount = changeEntries(diff).length;
  $("comparisonState").textContent = `${changeCount} changes`;
  $("comparisonHint").textContent = `${summary.degraded_links || 0} degraded links · ${summary.route_changes || 0} route changes`;
  const after = compareControls("changes").after.value || compareControls().after.value;
  if (state.diffMarkdownUrl) URL.revokeObjectURL(state.diffMarkdownUrl);
  if (markdown) {
    state.diffMarkdownUrl = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    $("markdownLink").href = state.diffMarkdownUrl;
    $("markdownLink").download = "zigbee-mesh-diff.md";
  } else {
    state.diffMarkdownUrl = null;
    $("markdownLink").href = `/api/diff-markdown?after=${encodeURIComponent(after)}`;
    $("markdownLink").removeAttribute("download");
  }
  $("markdownLink").classList.remove("disabled");
  $("diffContent").innerHTML = `<div class="diff-content">
    <div class="diff-summary">
      <div class="diff-stat"><strong>${summary.added_nodes || 0}</strong><span>nodes added</span></div>
      <div class="diff-stat"><strong>${summary.removed_nodes || 0}</strong><span>nodes removed</span></div>
      <div class="diff-stat"><strong>${summary.degraded_links || 0}</strong><span>degraded links</span></div>
      <div class="diff-stat"><strong>${summary.route_changes || 0}</strong><span>route changes</span></div>
    </div>
    <div class="change-list-heading"><h3>Change list</h3><span id="changeCount" class="muted small"></span></div>
    <ul id="changeItems" class="change-items" aria-live="polite"></ul>
    <div class="load-more-row"><button class="ghost" id="loadMoreChangesButton">Load more</button></div>
  </div>`;
  renderChangeList();
  $("loadMoreChangesButton").addEventListener("click", () => { state.changeVisibleCount += 10; renderChangeList(); });
}

async function pollJob(jobId, button, successMessage) {
  clearInterval(state.jobPoll);
  state.jobPoll = setInterval(async () => {
    try {
      const job = await api(`/api/job/${jobId}`);
      if (job.status === "done") {
        clearInterval(state.jobPoll); setBusy(button, false); toast(successMessage); await loadSnapshots();
        if (job.snapshot_id) selectSnapshot(job.snapshot_id);
        if (job.kind === "diff") { await loadDiff(job.before, job.after); openChangesPage(); }
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
    $("importFile").value = "";
  } catch (error) { toast(error.message, true); }
}

async function finishImport(snapshotId, successMessage) {
  toast(successMessage);
  const previousSnapshot = state.selectedId;
  await loadSnapshots();
  if (!snapshotId) return;
  const before = previousSnapshot && previousSnapshot !== snapshotId
    ? previousSnapshot
    : state.snapshots.find((item) => item.id !== snapshotId)?.id || "";
  $("beforeSelect").value = before;
  $("afterSelect").value = snapshotId;
  await selectSnapshot(snapshotId);
  // Re-apply the pair after rendering the newly selected snapshot so the
  // imported map is immediately ready as the "after" side of a comparison.
  renderSelects();
  $("beforeSelect").value = before;
  $("afterSelect").value = snapshotId;
  $("changesBeforeSelect").value = before;
  $("changesAfterSelect").value = snapshotId;
  resetDiffView();
}

async function importContent(content, label, successMessage) {
  if (isDeployedSite()) {
    // Vercel's filesystem is ephemeral and requests can be handled by
    // different function instances. Keep uploaded captures in this browser
    // so they remain available after reloads and do not depend on /tmp.
    const record = localSnapshotRecord(content, label);
    try {
      await writeLocalSnapshot(record);
    } catch (error) {
      throw new Error(`Could not save this mesh in browser storage: ${error.message}`);
    }
    await finishImport(record.id, `${successMessage} (saved in this browser)`);
    return;
  }

  const data = await api("/api/import", { method: "POST", body: JSON.stringify({ content, label }) });
  await finishImport(data.snapshot_id, successMessage);
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
    const controls = activeCompareControls();
    const data = await compareSnapshotPair(before, after, Number(controls.threshold.value) || 15);
    renderDiff(data.diff, data.markdown);
    await renderDiffMap(before, after, data.diff);
  } catch (error) { toast(error.message, true); }
}

async function compareSnapshotPair(before, after, lqiThreshold) {
  const [beforeSnapshot, afterSnapshot] = await Promise.all([getSnapshot(before), getSnapshot(after)]);
  return api("/api/compare", {
    method: "POST",
    body: JSON.stringify({ before_snapshot: beforeSnapshot, after_snapshot: afterSnapshot, lqi_threshold: lqiThreshold }),
  });
}

async function compareMeshes() {
  const controls = activeCompareControls();
  const before = controls.before.value, after = controls.after.value;
  if (!before || !after || before === after) { toast("Choose two different snapshots.", true); return; }
  const button = controls.button; setBusy(button, true, "Comparing…");
  try {
    const data = await compareSnapshotPair(before, after, Number(controls.threshold.value) || 15);
    openChangesPage();
    renderDiff(data.diff, data.markdown);
    await renderDiffMap(before, after, data.diff);
    toast("Comparison ready");
  } catch (error) { toast(error.message, true); }
  finally { setBusy(button, false); }
}

function syncComparePair(sourcePrefix = "") {
  const source = compareControls(sourcePrefix);
  const target = compareControls(sourcePrefix ? "" : "changes");
  target.before.value = source.before.value;
  target.after.value = source.after.value;
  target.threshold.value = source.threshold.value;
  resetDiffView();
}

async function init() {
  try {
    await api("/api/health");
    $("serverStatus").className = "status-pill ok";
    $("serverStatus").innerHTML = `<span class="dot"></span> ${isDeployedSite() ? "Deployed app ready" : "Local server ready"}`;
    await loadSnapshots();
  }
  catch (error) { $("serverStatus").className = "status-pill error"; $("serverStatus").innerHTML = `<span class="dot"></span> Server error`; toast(error.message, true); }
  $("snapshotButton").addEventListener("click", capture);
  $("importButton").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", (event) => importFile(event.target.files[0]));
  $("pasteImportButton").addEventListener("click", importPastedContent);
  $("changesPageButton").addEventListener("click", openChangesPage);
  $("openChangesButton").addEventListener("click", openChangesPage);
  $("backToLabButton").addEventListener("click", () => showPage("main"));
  $("fullscreenMapButton").addEventListener("click", openMapInspector);
  $("fullscreenDiffMapButton").addEventListener("click", () => openMapInspector("diff"));
  $("toggleStableDiffButton").addEventListener("click", () => {
    if (!state.beforeDiffMap || !state.afterDiffMap) return;
    state.diffView = state.diffView === "changes" ? "context" : "changes";
    updateDiffMapFocus();
  });
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
    rerenderStoredGraph(state.beforeDiffMap, "beforeChangeGraph", "before-diff");
    rerenderStoredGraph(state.afterDiffMap, "afterChangeGraph", "after-diff");
    if (state.inspectorCy) runGraphLayout(state.inspectorCy, state.mapLayout);
  });
  $("mapLinkModeSelect").addEventListener("change", () => {
    state.mapLinkMode = $("mapLinkModeSelect").value;
    rerenderStoredGraph(state.currentMap, "currentGraph", "current");
    rerenderStoredGraph(state.beforeDiffMap, "beforeChangeGraph", "before-diff");
    rerenderStoredGraph(state.afterDiffMap, "afterChangeGraph", "after-diff");
    if (!$('mapInspector').classList.contains('hidden') && state.activeInspectorMap) renderInspectorMap(state.activeInspectorMap);
  });
  $("mapLabelModeSelect").addEventListener("change", () => {
    state.mapLabelMode = $("mapLabelModeSelect").value;
    rerenderStoredGraph(state.currentMap, "currentGraph", "current");
    rerenderStoredGraph(state.beforeDiffMap, "beforeChangeGraph", "before-diff");
    rerenderStoredGraph(state.afterDiffMap, "afterChangeGraph", "after-diff");
    if (!$('mapInspector').classList.contains('hidden') && state.activeInspectorMap) renderInspectorMap(state.activeInspectorMap);
  });
  $("mapLqiRange").addEventListener("input", () => {
    state.mapMinLqi = Number($("mapLqiRange").value) || 0;
    $("mapLqiValue").value = state.mapMinLqi;
    $("mapLqiValue").textContent = state.mapMinLqi;
    applyGraphFilter(state.currentCy);
    applyGraphFilter(state.beforeDiffCy);
    applyGraphFilter(state.afterDiffCy);
    applyGraphFilter(state.inspectorCy);
  });
  $("fitMapButton").addEventListener("click", () => fitGraph(state.currentCy));
  $("compareButton").addEventListener("click", compareMeshes);
  $("changesCompareButton").addEventListener("click", compareMeshes);
  $("refreshButton").addEventListener("click", () => loadSnapshots().catch((error) => toast(error.message, true)));
  $("beforeSelect").addEventListener("change", () => syncComparePair());
  $("afterSelect").addEventListener("change", () => { syncComparePair(); if ($("afterSelect").value) selectSnapshot($("afterSelect").value); });
  $("changesBeforeSelect").addEventListener("change", () => syncComparePair("changes"));
  $("changesAfterSelect").addEventListener("change", () => { syncComparePair("changes"); if ($("changesAfterSelect").value) selectSnapshot($("changesAfterSelect").value); });
  window.addEventListener("hashchange", () => window.location.hash === "#changes" ? openChangesPage() : showPage("main"));
  if (window.location.hash === "#changes") openChangesPage(); else showPage("main");
}

init();
