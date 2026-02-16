// =====================================================================
// ROUTE BUILDER
// =====================================================================
(function() {

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/cycling';

let waypoints = [];       // [{lng, lat, marker}]
let routeGeometry = null; // GeoJSON LineString
let routeDistance = 0;     // meters
let routeElevations = null; // {elevations: [...], distances: [...], coordinates: [...], indices: []}
let routeElevationGain = 0;
let routeSurfaceData = null; // {breakdown: [...], raw_counts: {...}}
let routeTimeout = null;
let isSaving = false;

// --- Init ---
initMap().then(() => {
  map.getContainer().classList.add('builder-cursor');
  map.on('click', onMapClick);
  renderWaypointList();

  // Load existing route if editing
  if (window.EDIT_ROUTE_ID) {
    loadExistingRoute(window.EDIT_ROUTE_ID);
  }
});

// --- Map click: add waypoint ---
function onMapClick(e) {
  if (isSaving) return;
  addWaypoint(e.lngLat.lng, e.lngLat.lat);
}

function addWaypoint(lng, lat) {
  const num = waypoints.length + 1;

  const el = document.createElement('div');
  el.style.cssText = 'width:26px;height:26px;border-radius:50%;background:#1e293b;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);cursor:grab;';
  el.textContent = num;

  const marker = new maplibregl.Marker({ element: el, draggable: true })
    .setLngLat([lng, lat])
    .addTo(map);

  const wp = { lng, lat, marker };
  waypoints.push(wp);

  marker.on('dragend', () => {
    const pos = marker.getLngLat();
    wp.lng = pos.lng;
    wp.lat = pos.lat;
    renderWaypointList();
    queryOSRM();
  });

  renderWaypointList();
  queryOSRM();
}

function removeWaypoint(index) {
  waypoints[index].marker.remove();
  waypoints.splice(index, 1);
  waypoints.forEach((wp, i) => {
    wp.marker.getElement().textContent = i + 1;
  });
  renderWaypointList();
  queryOSRM();
}

// --- Undo / Clear ---
window.undoWaypoint = function() {
  if (waypoints.length === 0) return;
  removeWaypoint(waypoints.length - 1);
};

window.clearRoute = function() {
  if (!confirm('Clear all waypoints?')) return;
  while (waypoints.length) {
    waypoints.pop().marker.remove();
  }
  routeGeometry = null;
  routeDistance = 0;
  routeElevations = null;
  routeElevationGain = 0;
  routeSurfaceData = null;
  clearRouteLine();
  clearGradientLine();
  renderWaypointList();
  updateStats();
  drawElevationProfile();
  renderSurfaceBar(null);
};

// --- Render waypoint list ---
function renderWaypointList() {
  const list = document.getElementById('waypoint-list');
  const undoBtn = document.getElementById('undo-btn');
  const clearBtn = document.getElementById('clear-btn');
  const saveForm = document.getElementById('save-form');
  const statsEl = document.getElementById('route-stats');

  undoBtn.disabled = waypoints.length === 0;
  clearBtn.disabled = waypoints.length === 0;
  saveForm.style.display = waypoints.length >= 2 ? '' : 'none';
  statsEl.style.display = waypoints.length >= 2 ? '' : 'none';

  if (waypoints.length === 0) {
    list.innerHTML = '<div class="waypoint-empty">Click on the map to place your first waypoint</div>';
    document.getElementById('elevation-profile').style.display = 'none';
    document.getElementById('surface-bar').style.display = 'none';
    document.getElementById('gradient-legend').style.display = 'none';
    return;
  }

  list.innerHTML = '';
  waypoints.forEach((wp, i) => {
    const item = document.createElement('div');
    item.className = 'waypoint-item';
    item.innerHTML = `
      <span class="waypoint-num">${i + 1}</span>
      <span class="waypoint-coords">${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}</span>
      <button class="waypoint-remove" title="Remove">&times;</button>
    `;
    item.querySelector('.waypoint-remove').addEventListener('click', () => removeWaypoint(i));
    list.appendChild(item);
  });
}

// --- Query routing engine ---
function queryOSRM() {
  clearTimeout(routeTimeout);
  if (waypoints.length < 2) {
    routeGeometry = null;
    routeDistance = 0;
    routeElevations = null;
    routeElevationGain = 0;
    routeSurfaceData = null;
    clearRouteLine();
    clearGradientLine();
    updateStats();
    drawElevationProfile();
    renderSurfaceBar(null);
    return;
  }

  routeTimeout = setTimeout(async () => {
    try {
      const coords = waypoints.map(wp => `${wp.lng},${wp.lat}`).join(';');
      const url = `${OSRM_BASE}/${coords}?overview=full&geometries=geojson&steps=false`;
      const resp = await fetch(url);
      const data = await resp.json();

      if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
        console.warn('OSRM returned no route:', data);
        return;
      }

      routeGeometry = data.routes[0].geometry;
      routeDistance = data.routes[0].distance;

      drawRouteLine();
      updateStats();
      fetchElevation();
      fetchSurface();

    } catch (err) {
      console.error('Routing error:', err);
    }
  }, 300);
}

// --- Draw route on map ---
function drawRouteLine() {
  if (!routeGeometry) return;

  const data = { type: 'Feature', geometry: routeGeometry };

  if (map.getSource('builder-route')) {
    map.getSource('builder-route').setData(data);
  } else {
    map.addSource('builder-route', {
      type: 'geojson',
      data: data,
    });
    // Dark outline for definition
    map.addLayer({
      id: 'builder-route-outline',
      type: 'line',
      source: 'builder-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#1e3a5f',
        'line-width': 7,
        'line-opacity': 0.15,
      },
    });
    // Solid route line (visible when no gradient data)
    map.addLayer({
      id: 'builder-route-line',
      type: 'line',
      source: 'builder-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#2563eb',
        'line-width': 4,
        'line-opacity': 0.9,
      },
    });
  }
}

function clearRouteLine() {
  if (map.getSource('builder-route')) {
    map.getSource('builder-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
  }
}

// --- Gradient coloring ---
function applyGradientColoring() {
  if (!routeElevations || routeElevations.elevations.length < 2 || !routeGeometry) return;

  const elevs = routeElevations.elevations;
  const dists = routeElevations.distances;
  const indices = routeElevations.indices;
  const allCoords = routeGeometry.coordinates;

  const features = [];
  for (let i = 0; i < elevs.length - 1; i++) {
    const rise = elevs[i + 1] - elevs[i];
    const run = (dists[i + 1] - dists[i]) * 1000;
    const grade = run > 0 ? Math.abs(rise / run) * 100 : 0;

    // Use full-resolution route coords for this segment
    let segCoords;
    if (indices && indices[i] !== undefined && indices[i + 1] !== undefined) {
      segCoords = allCoords.slice(indices[i], indices[i + 1] + 1);
    } else {
      segCoords = [routeElevations.coordinates[i], routeElevations.coordinates[i + 1]];
    }
    if (segCoords.length < 2) continue;

    features.push({
      type: 'Feature',
      properties: { grade: grade },
      geometry: { type: 'LineString', coordinates: segCoords },
    });
  }

  const fc = { type: 'FeatureCollection', features };

  if (map.getSource('builder-gradient')) {
    map.getSource('builder-gradient').setData(fc);
  } else {
    map.addSource('builder-gradient', { type: 'geojson', data: fc });
    map.addLayer({
      id: 'builder-gradient-line',
      type: 'line',
      source: 'builder-gradient',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 4,
        'line-opacity': 0.9,
        'line-color': [
          'interpolate', ['linear'], ['get', 'grade'],
          0, '#22c55e', 3, '#84cc16', 5, '#eab308',
          8, '#f97316', 12, '#ef4444', 18, '#991b1b',
        ],
      },
    });
  }

  // Hide solid blue line since gradient covers it
  if (map.getLayer('builder-route-line')) {
    map.setPaintProperty('builder-route-line', 'line-opacity', 0);
  }
  document.getElementById('gradient-legend').style.display = '';
}

function clearGradientLine() {
  if (map.getSource('builder-gradient')) {
    map.getSource('builder-gradient').setData({ type: 'FeatureCollection', features: [] });
  }
  if (map.getLayer('builder-route-line')) {
    map.setPaintProperty('builder-route-line', 'line-opacity', 0.9);
  }
  document.getElementById('gradient-legend').style.display = 'none';
}

// --- Stats ---
function updateStats() {
  const distEl = document.getElementById('stat-distance');
  const elevEl = document.getElementById('stat-elevation');

  if (routeDistance > 0) {
    distEl.textContent = formatDistance(routeDistance / 1000);
  } else {
    distEl.textContent = '\u2014';
  }

  if (routeElevationGain > 0) {
    elevEl.textContent = formatElevation(routeElevationGain);
  } else {
    elevEl.textContent = '\u2014';
  }
}

// --- Elevation ---
let elevAbortController = null;

async function fetchElevation() {
  if (!routeGeometry || !routeGeometry.coordinates || routeGeometry.coordinates.length < 2) return;

  // Cancel any in-flight elevation request
  if (elevAbortController) elevAbortController.abort();
  elevAbortController = new AbortController();
  const signal = elevAbortController.signal;

  // Show loading state
  document.getElementById('stat-elevation').textContent = '...';

  const coords = routeGeometry.coordinates;
  // Sample ~80 points evenly (cap at 80 to stay within API limits)
  const maxSamples = 80;
  const step = Math.max(1, Math.floor(coords.length / maxSamples));
  const sampled = [];
  const indices = [];
  for (let i = 0; i < coords.length; i += step) {
    sampled.push(coords[i]);
    indices.push(i);
  }
  if (sampled.length > 0 && sampled[sampled.length - 1] !== coords[coords.length - 1]) {
    sampled.push(coords[coords.length - 1]);
    indices.push(coords.length - 1);
  }

  try {
    const resp = await fetch('/api/elevation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: sampled }),
      signal: signal,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.warn('Elevation API error:', resp.status, err);
      document.getElementById('stat-elevation').textContent = 'Error';
      return;
    }

    const data = await resp.json();

    // Ignore if this request was cancelled (a newer one is pending)
    if (signal.aborted) return;

    // Sanitize: replace any null/NaN with 0
    if (data.elevations) {
      for (let i = 0; i < data.elevations.length; i++) {
        if (data.elevations[i] == null || isNaN(data.elevations[i])) {
          data.elevations[i] = 0;
        }
      }
    }

    routeElevationGain = data.elevation_gain_m || 0;

    // Compute cumulative distances for the elevation profile
    const distances = [0];
    for (let i = 1; i < sampled.length; i++) {
      const [lng1, lat1] = sampled[i - 1];
      const [lng2, lat2] = sampled[i];
      const d = haversine(lat1, lng1, lat2, lng2);
      distances.push(distances[i - 1] + d);
    }

    routeElevations = {
      elevations: data.elevations,
      distances: distances,
      coordinates: sampled,
      indices: indices,
    };

    updateStats();
    applyGradientColoring();
    drawElevationProfile();

  } catch (err) {
    if (err.name === 'AbortError') return; // Expected: cancelled by newer request
    console.error('Elevation error:', err);
    document.getElementById('stat-elevation').textContent = 'Error';
  }
}

// --- Surface data ---
let surfaceAbortController = null;

async function fetchSurface() {
  if (!routeGeometry || !routeGeometry.coordinates || routeGeometry.coordinates.length < 2) return;

  if (surfaceAbortController) surfaceAbortController.abort();
  surfaceAbortController = new AbortController();
  const signal = surfaceAbortController.signal;

  try {
    const resp = await fetch('/api/surface', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: routeGeometry.coordinates }),
      signal: signal,
    });

    if (!resp.ok || signal.aborted) return;
    const data = await resp.json();
    if (signal.aborted) return;

    routeSurfaceData = data;
    renderSurfaceBar(data);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Surface error:', err);
  }
}

function renderSurfaceBar(data) {
  const container = document.getElementById('surface-bar');
  const track = document.getElementById('surface-track');
  const labels = document.getElementById('surface-labels');

  if (!data || !data.breakdown || data.breakdown.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = '';
  track.innerHTML = '';
  labels.innerHTML = '';

  for (const item of data.breakdown) {
    const seg = document.createElement('div');
    seg.className = 'surface-segment';
    seg.style.width = item.percentage + '%';
    seg.style.background = SURFACE_COLORS[item.type] || '#94a3b8';
    track.appendChild(seg);

    const lbl = document.createElement('span');
    lbl.className = 'surface-label';
    lbl.innerHTML = `<span class="surface-dot" style="background:${SURFACE_COLORS[item.type] || '#94a3b8'}"></span>${SURFACE_LABELS[item.type] || item.type} ${item.percentage}%`;
    labels.appendChild(lbl);
  }
}

// Haversine distance in km
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// --- Elevation Profile Chart ---
let _profileCache = null; // cached ImageData for hover redraws

function drawElevationProfile(hoverIdx) {
  const container = document.getElementById('elevation-profile');
  const canvas = document.getElementById('elevation-canvas');

  if (!routeElevations || routeElevations.elevations.length < 2) {
    container.style.display = 'none';
    _profileCache = null;
    return;
  }

  container.style.display = '';
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width;
  const h = 140;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);

  const elevs = routeElevations.elevations;
  const dists = routeElevations.distances;
  const totalDistMi = dists[dists.length - 1] * KM_TO_MI;

  const minElev = Math.min(...elevs);
  const maxElev = Math.max(...elevs);
  const elevRange = maxElev - minElev || 1;

  const padding = { top: 20, right: 12, bottom: 28, left: 42 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;

  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, w, h);

  // Grid lines and labels
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 0.5;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';

  const elevTicks = 4;
  for (let i = 0; i <= elevTicks; i++) {
    const y = padding.top + (chartH * i / elevTicks);
    const elevVal = maxElev - (elevRange * i / elevTicks);
    const elevFt = Math.round(elevVal * M_TO_FT);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();
    ctx.fillText(elevFt.toLocaleString() + "'", padding.left - 4, y + 3);
  }

  // Distance labels
  ctx.textAlign = 'center';
  const distTicks = Math.max(1, Math.min(5, Math.floor(totalDistMi)));
  for (let i = 0; i <= distTicks; i++) {
    const distVal = (totalDistMi * i / distTicks);
    const x = padding.left + (chartW * i / distTicks);
    ctx.fillText(distVal.toFixed(1) + ' mi', x, h - 6);
  }

  // Build path points
  const points = [];
  for (let i = 0; i < elevs.length; i++) {
    const x = padding.left + (dists[i] / dists[dists.length - 1]) * chartW;
    const y = padding.top + chartH - ((elevs[i] - minElev) / elevRange) * chartH;
    points.push({ x, y });
  }

  // Gradient-colored fill and line
  for (let i = 0; i < points.length - 1; i++) {
    const rise = elevs[i + 1] - elevs[i];
    const run = (dists[i + 1] - dists[i]) * 1000;
    const grade = run > 0 ? Math.abs(rise / run) * 100 : 0;
    const color = gradeToColor(grade);

    // Fill segment
    ctx.beginPath();
    ctx.moveTo(points[i].x, padding.top + chartH);
    ctx.lineTo(points[i].x, points[i].y);
    ctx.lineTo(points[i + 1].x, points[i + 1].y);
    ctx.lineTo(points[i + 1].x, padding.top + chartH);
    ctx.closePath();
    ctx.fillStyle = color + '40';
    ctx.fill();

    // Line segment
    ctx.beginPath();
    ctx.moveTo(points[i].x, points[i].y);
    ctx.lineTo(points[i + 1].x, points[i + 1].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Mark peaks and valleys
  for (let i = 1; i < elevs.length - 1; i++) {
    const isPeak = elevs[i] > elevs[i-1] && elevs[i] > elevs[i+1] && (elevs[i] - Math.min(elevs[i-1], elevs[i+1])) > elevRange * 0.08;
    const isValley = elevs[i] < elevs[i-1] && elevs[i] < elevs[i+1] && (Math.max(elevs[i-1], elevs[i+1]) - elevs[i]) > elevRange * 0.08;

    if (isPeak || isValley) {
      ctx.beginPath();
      ctx.arc(points[i].x, points[i].y, 3, 0, Math.PI * 2);
      ctx.fillStyle = isPeak ? '#ef4444' : '#22c55e';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Cache the base chart image
  _profileCache = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // Draw hover overlay if provided
  if (hoverIdx !== undefined && hoverIdx >= 0 && hoverIdx < points.length) {
    drawProfileHoverOverlay(ctx, points, elevs, dists, padding, chartW, chartH, hoverIdx);
  }

  // Setup hover events (only once)
  if (!canvas._hasHoverSetup) {
    canvas._hasHoverSetup = true;
    setupProfileHover(canvas, padding);
  }
}

function drawProfileHoverOverlay(ctx, points, elevs, dists, padding, chartW, chartH, idx) {
  // Crosshair
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(points[idx].x, padding.top);
  ctx.lineTo(points[idx].x, padding.top + chartH);
  ctx.stroke();
  ctx.setLineDash([]);

  // Dot
  ctx.beginPath();
  ctx.arc(points[idx].x, points[idx].y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#2563eb';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Tooltip with grade info
  const elevFt = Math.round(elevs[idx] * M_TO_FT);
  const distMi = (dists[idx] * KM_TO_MI).toFixed(1);
  let gradeText = '';
  if (idx < elevs.length - 1) {
    const rise = elevs[idx + 1] - elevs[idx];
    const run = (dists[idx + 1] - dists[idx]) * 1000;
    const grade = run > 0 ? (rise / run) * 100 : 0;
    gradeText = ` | ${grade >= 0 ? '+' : ''}${grade.toFixed(1)}%`;
  }
  const text = `${elevFt.toLocaleString()} ft @ ${distMi} mi${gradeText}`;
  ctx.font = 'bold 11px -apple-system, sans-serif';
  const tw = ctx.measureText(text).width + 12;
  let tx = points[idx].x - tw / 2;
  tx = Math.max(padding.left, Math.min(tx, padding.left + chartW - tw));
  const ty = Math.max(padding.top + 8, points[idx].y - 16);

  ctx.fillStyle = 'rgba(30, 41, 59, 0.9)';
  ctx.beginPath();
  ctx.roundRect(tx, ty - 14, tw, 20, 4);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(text, tx + tw / 2, ty);
}

function setupProfileHover(canvas, padding) {
  // Add hover marker source to map
  if (!map.getSource('elev-hover-point')) {
    map.addSource('elev-hover-point', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'elev-hover-dot',
      type: 'circle',
      source: 'elev-hover-point',
      paint: {
        'circle-radius': 6,
        'circle-color': '#2563eb',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    });
  }

  canvas.addEventListener('mousemove', function(e) {
    if (!routeElevations || !_profileCache) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const dpr = window.devicePixelRatio || 1;

    const w = rect.width;
    const chartW = w - padding.left - padding.right;
    const frac = (mx - padding.left) / chartW;
    if (frac < 0 || frac > 1) return;

    const dists = routeElevations.distances;
    const targetDist = frac * dists[dists.length - 1];
    let closest = 0;
    for (let i = 1; i < dists.length; i++) {
      if (Math.abs(dists[i] - targetDist) < Math.abs(dists[closest] - targetDist)) closest = i;
    }

    // Restore cached base image and draw overlay
    const ctx = canvas.getContext('2d');
    ctx.putImageData(_profileCache, 0, 0);
    ctx.save();
    ctx.scale(dpr, dpr);

    const elevs = routeElevations.elevations;
    const minElev = Math.min(...elevs);
    const maxElev = Math.max(...elevs);
    const elevRange = maxElev - minElev || 1;
    const chartH = 140 - padding.top - padding.bottom;

    const points = [];
    for (let i = 0; i < elevs.length; i++) {
      const x = padding.left + (dists[i] / dists[dists.length - 1]) * chartW;
      const y = padding.top + chartH - ((elevs[i] - minElev) / elevRange) * chartH;
      points.push({ x, y });
    }

    drawProfileHoverOverlay(ctx, points, elevs, dists, padding, chartW, chartH, closest);
    ctx.restore();

    // Show dot on map
    if (routeElevations.coordinates[closest]) {
      const [lng, lat] = routeElevations.coordinates[closest];
      map.getSource('elev-hover-point').setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }],
      });
    }
  });

  canvas.addEventListener('mouseleave', function() {
    if (!_profileCache) return;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(_profileCache, 0, 0);

    if (map.getSource('elev-hover-point')) {
      map.getSource('elev-hover-point').setData({ type: 'FeatureCollection', features: [] });
    }
  });
}

// --- Save route ---
window.saveRoute = async function() {
  const name = document.getElementById('route-name').value.trim();
  if (!name) { alert('Please enter a route name'); return; }
  if (!routeGeometry) { alert('No route to save'); return; }

  const saveBtn = document.getElementById('save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  isSaving = true;

  const coords = routeGeometry.coordinates;
  const mid = coords[Math.floor(coords.length / 2)];

  const payload = {
    name: name,
    description: document.getElementById('route-desc').value.trim(),
    route_type: document.getElementById('route-type').value,
    region: document.getElementById('route-region').value.trim(),
    distance_km: parseFloat((routeDistance / 1000).toFixed(2)),
    elevation_m: routeElevationGain || 0,
    geometry: JSON.stringify(routeGeometry),
    waypoints: JSON.stringify(waypoints.map(wp => [wp.lng, wp.lat])),
    center_lng: mid[0],
    center_lat: mid[1],
    elevation_profile: routeElevations ? JSON.stringify(routeElevations) : '',
    surface_data: routeSurfaceData ? JSON.stringify(routeSurfaceData) : '',
  };

  try {
    const isEdit = !!window.EDIT_ROUTE_ID;
    const url = isEdit ? `/api/routes/${window.EDIT_ROUTE_ID}` : '/api/routes';
    const method = isEdit ? 'PUT' : 'POST';

    const resp = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      const saved = await resp.json();
      window.location.href = `/route/${saved.id}`;
    } else {
      const err = await resp.json();
      alert('Save failed: ' + (err.error || 'Unknown error'));
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Route';
      isSaving = false;
    }
  } catch (err) {
    console.error('Save error:', err);
    alert('Failed to save route');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Route';
    isSaving = false;
  }
};

// --- Load existing route for editing ---
async function loadExistingRoute(routeId) {
  try {
    const resp = await fetch(`/api/routes/${routeId}`);
    if (!resp.ok) return;

    const route = await resp.json();

    document.getElementById('route-name').value = route.name || '';
    document.getElementById('route-desc').value = route.description || '';
    document.getElementById('route-type').value = route.route_type || 'road';
    document.getElementById('route-region').value = route.region || '';

    const wps = JSON.parse(route.waypoints || '[]');
    for (const [lng, lat] of wps) {
      addWaypoint(lng, lat);
    }

    if (wps.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const [lng, lat] of wps) bounds.extend([lng, lat]);
      map.fitBounds(bounds, { padding: 100, maxZoom: 14 });
    }

  } catch (err) {
    console.error('Failed to load route:', err);
  }
}

})();
