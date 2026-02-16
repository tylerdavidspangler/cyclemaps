// =====================================================================
// ROUTE BUILDER
// =====================================================================
(function() {

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/cycling';
const VALHALLA_BASE = 'https://valhalla1.openstreetmap.de/route';

// Decode Valhalla's encoded polyline6 format to [lng, lat] coordinates
function decodePolyline6(encoded) {
  const coords = [];
  let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(idx++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(idx++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coords.push([lng / 1e6, lat / 1e6]);
  }
  return coords;
}

let waypoints = [];       // [{lng, lat, marker}]
let routeGeometry = null; // GeoJSON LineString
let routeDistance = 0;     // meters
let routeElevations = null; // {elevations: [...], distances: [...]} for profile
let routeElevationGain = 0;
let routeTimeout = null;
let isSaving = false;
let routingMode = 'road'; // 'road', 'gravel', or 'straight'

// --- Init ---
initMap({ center: [0, 20], zoom: 2 }).then(() => {
  map.getContainer().classList.add('builder-cursor');
  map.on('click', onMapClick);
  renderWaypointList();

  // Routing mode buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      routingMode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === routingMode));
      // Re-route with new mode if we have waypoints
      if (waypoints.length >= 2) queryOSRM();
    });
  });

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
  clearRouteLine();
  renderWaypointList();
  updateStats();
  drawElevationProfile();
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
    clearRouteLine();
    updateStats();
    drawElevationProfile();
    return;
  }

  routeTimeout = setTimeout(async () => {
    if (routingMode === 'straight') {
      const coordsList = waypoints.map(wp => [wp.lng, wp.lat]);
      routeGeometry = { type: 'LineString', coordinates: coordsList };
      routeDistance = 0;
      for (let i = 1; i < coordsList.length; i++) {
        routeDistance += haversine(coordsList[i-1][1], coordsList[i-1][0], coordsList[i][1], coordsList[i][0]) * 1000;
      }
      drawRouteLine();
      updateStats();
      fetchElevation();
      return;
    }

    try {
      if (routingMode === 'gravel') {
        // Valhalla pedestrian profile — routes on trails, dirt roads, fire roads
        const locations = waypoints.map(wp => ({ lat: wp.lat, lon: wp.lng }));
        const resp = await fetch(VALHALLA_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            locations: locations,
            costing: 'pedestrian',
            units: 'km',
          }),
        });
        const data = await resp.json();

        if (!data.trip || !data.trip.legs || !data.trip.legs.length) {
          console.warn('Valhalla returned no route:', data);
          return;
        }

        // Decode all leg shapes and merge into one LineString
        let allCoords = [];
        for (const leg of data.trip.legs) {
          const legCoords = decodePolyline6(leg.shape);
          if (allCoords.length > 0) legCoords.shift(); // avoid duplicate point at leg join
          allCoords = allCoords.concat(legCoords);
        }

        routeGeometry = { type: 'LineString', coordinates: allCoords };
        routeDistance = data.trip.summary.length * 1000; // km → meters

      } else {
        // OSRM cycling profile — snaps to paved roads
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
      }

      drawRouteLine();
      updateStats();
      fetchElevation();

    } catch (err) {
      console.error('Routing error:', err);
    }
  }, 300);
}

// --- Draw route on map ---
function drawRouteLine() {
  if (!routeGeometry) return;

  if (map.getSource('builder-route')) {
    map.getSource('builder-route').setData({
      type: 'Feature',
      geometry: routeGeometry,
    });
  } else {
    map.addSource('builder-route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: routeGeometry },
    });
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
  for (let i = 0; i < coords.length; i += step) {
    sampled.push(coords[i]);
  }
  if (sampled.length > 0 && sampled[sampled.length - 1] !== coords[coords.length - 1]) {
    sampled.push(coords[coords.length - 1]);
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
    };

    updateStats();
    drawElevationProfile();

  } catch (err) {
    if (err.name === 'AbortError') return; // Expected: cancelled by newer request
    console.error('Elevation error:', err);
    document.getElementById('stat-elevation').textContent = 'Error';
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

  // Fill gradient
  const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
  gradient.addColorStop(0, 'rgba(37, 99, 235, 0.25)');
  gradient.addColorStop(1, 'rgba(37, 99, 235, 0.02)');

  ctx.beginPath();
  ctx.moveTo(points[0].x, padding.top + chartH);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[points.length - 1].x, padding.top + chartH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

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

  // Tooltip
  const elevFt = Math.round(elevs[idx] * M_TO_FT);
  const distMi = (dists[idx] * KM_TO_MI).toFixed(1);
  const text = `${elevFt.toLocaleString()} ft @ ${distMi} mi`;
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
      window.location.href = '/viewer';
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
