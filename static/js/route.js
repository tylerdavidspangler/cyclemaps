// =====================================================================
// ROUTE DETAIL PAGE
// =====================================================================
(function() {

let routeData = null;
let routeElevations = null;
let _profileCache = null;

// --- Init ---
initMap().then(() => {
  loadRoute(window.ROUTE_ID);
});

// --- Load route ---
async function loadRoute(routeId) {
  try {
    const resp = await fetch(`/api/routes/${routeId}`);
    if (!resp.ok) {
      document.getElementById('route-name').textContent = 'Route not found';
      return;
    }
    routeData = await resp.json();
    renderRouteInfo();
    drawRoute();
    fetchElevation();
    fetchSurface();
  } catch (err) {
    console.error('Failed to load route:', err);
    document.getElementById('route-name').textContent = 'Failed to load';
  }
}

// --- Render route info ---
function renderRouteInfo() {
  document.getElementById('route-name').textContent = routeData.name;
  document.getElementById('route-desc').textContent = routeData.description || '';
  document.title = routeData.name + ' — CycleMaps';

  if (routeData.distance_km) {
    document.getElementById('stat-distance').textContent = formatDistance(routeData.distance_km);
  }
  if (routeData.elevation_m) {
    document.getElementById('stat-elevation').textContent = formatElevation(routeData.elevation_m);
  }

  // Meta
  const meta = [];
  if (routeData.region) meta.push(routeData.region);
  meta.push(typeLabel(routeData.route_type));
  document.getElementById('route-meta').textContent = meta.join(' · ');

  // Buttons
  document.getElementById('gpx-btn').addEventListener('click', () => {
    window.location.href = `/api/routes/${routeData.id}/gpx`;
  });

  document.getElementById('share-btn').addEventListener('click', () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('share-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy Link'; }, 2000);
    });
  });

  document.getElementById('edit-link').href = `/builder/${routeData.id}`;
}

// --- Draw route on map ---
function drawRoute() {
  const geometry = JSON.parse(routeData.geometry || '{}');
  if (!geometry.coordinates || !geometry.coordinates.length) return;

  // Fit map to route
  const bounds = new maplibregl.LngLatBounds();
  for (const c of geometry.coordinates) bounds.extend(c);
  map.fitBounds(bounds, { padding: { top: 80, bottom: 80, left: 400, right: 80 }, maxZoom: 14 });

  // Base route outline
  map.addSource('route', {
    type: 'geojson',
    data: { type: 'Feature', geometry: geometry },
  });

  map.addLayer({
    id: 'route-outline',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#1e3a5f',
      'line-width': 7,
      'line-opacity': 0.2,
    },
  });

  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': COLORS[routeData.route_type] || COLORS.road,
      'line-width': 4,
      'line-opacity': 0.9,
    },
  });
}

// --- Gradient coloring ---
function applyGradientColoring() {
  if (!routeElevations || routeElevations.elevations.length < 2) return;

  const elevs = routeElevations.elevations;
  const dists = routeElevations.distances;
  const coords = routeElevations.coordinates;
  const geometry = JSON.parse(routeData.geometry || '{}');
  const allCoords = geometry.coordinates || [];

  // Build gradient segments using full-resolution route coords
  const features = [];
  const indices = routeElevations.indices || null;

  for (let i = 0; i < elevs.length - 1; i++) {
    const rise = elevs[i + 1] - elevs[i];
    const run = (dists[i + 1] - dists[i]) * 1000;
    const grade = run > 0 ? Math.abs(rise / run) * 100 : 0;

    let segCoords;
    if (indices && indices[i] !== undefined && indices[i + 1] !== undefined) {
      segCoords = allCoords.slice(indices[i], indices[i + 1] + 1);
    } else {
      segCoords = [coords[i], coords[i + 1]];
    }
    if (segCoords.length < 2) continue;

    features.push({
      type: 'Feature',
      properties: { grade: grade },
      geometry: { type: 'LineString', coordinates: segCoords },
    });
  }

  map.addSource('gradient', { type: 'geojson', data: { type: 'FeatureCollection', features } });
  map.addLayer({
    id: 'gradient-line',
    type: 'line',
    source: 'gradient',
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

  // Hide the solid route line (gradient covers it)
  map.setPaintProperty('route-line', 'line-opacity', 0);
  document.getElementById('gradient-legend').style.display = '';
}

// --- Elevation ---
async function fetchElevation() {
  // Try stored elevation profile first
  if (routeData.elevation_profile) {
    try {
      routeElevations = JSON.parse(routeData.elevation_profile);
      if (routeElevations.elevations && routeElevations.elevations.length >= 2) {
        applyGradientColoring();
        drawElevationProfile();
        return;
      }
    } catch (e) { /* fall through to fetch */ }
  }

  // Fetch from API
  const geometry = JSON.parse(routeData.geometry || '{}');
  const coords = geometry.coordinates || [];
  if (coords.length < 2) return;

  const maxSamples = 80;
  const step = Math.max(1, Math.floor(coords.length / maxSamples));
  const sampled = [];
  const indices = [];
  for (let i = 0; i < coords.length; i += step) {
    sampled.push(coords[i]);
    indices.push(i);
  }
  if (sampled[sampled.length - 1] !== coords[coords.length - 1]) {
    sampled.push(coords[coords.length - 1]);
    indices.push(coords.length - 1);
  }

  try {
    const resp = await fetch('/api/elevation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: sampled }),
    });
    if (!resp.ok) return;

    const data = await resp.json();
    const distances = [0];
    for (let i = 1; i < sampled.length; i++) {
      const [lng1, lat1] = sampled[i - 1];
      const [lng2, lat2] = sampled[i];
      distances.push(distances[i - 1] + haversine(lat1, lng1, lat2, lng2));
    }

    routeElevations = {
      elevations: data.elevations,
      distances: distances,
      coordinates: sampled,
      indices: indices,
    };

    // Update elevation stat
    if (data.elevation_gain_m) {
      document.getElementById('stat-elevation').textContent = formatElevation(data.elevation_gain_m);
    }

    applyGradientColoring();
    drawElevationProfile();
  } catch (err) {
    console.error('Elevation error:', err);
  }
}

// --- Surface ---
async function fetchSurface() {
  // Try stored surface data first
  if (routeData.surface_data) {
    try {
      const data = JSON.parse(routeData.surface_data);
      if (data.breakdown && data.breakdown.length > 0) {
        renderSurfaceBar(data);
        return;
      }
    } catch (e) { /* fall through to fetch */ }
  }

  const geometry = JSON.parse(routeData.geometry || '{}');
  const coords = geometry.coordinates || [];
  if (coords.length < 2) return;

  try {
    const resp = await fetch('/api/surface', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: coords }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.breakdown && data.breakdown.length > 0) {
      renderSurfaceBar(data);
    }
  } catch (err) {
    console.error('Surface error:', err);
  }
}

function renderSurfaceBar(data) {
  const container = document.getElementById('surface-bar');
  const track = document.getElementById('surface-track');
  const labels = document.getElementById('surface-labels');
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

// --- Haversine ---
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// --- Elevation Profile Chart ---
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
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 0.5;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';

  const elevTicks = 4;
  for (let i = 0; i <= elevTicks; i++) {
    const y = padding.top + (chartH * i / elevTicks);
    const elevVal = maxElev - (elevRange * i / elevTicks);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();
    ctx.fillText(Math.round(elevVal * M_TO_FT).toLocaleString() + "'", padding.left - 4, y + 3);
  }

  ctx.textAlign = 'center';
  const distTicks = Math.max(1, Math.min(5, Math.floor(totalDistMi)));
  for (let i = 0; i <= distTicks; i++) {
    const x = padding.left + (chartW * i / distTicks);
    ctx.fillText((totalDistMi * i / distTicks).toFixed(1) + ' mi', x, h - 6);
  }

  // Build points
  const points = [];
  for (let i = 0; i < elevs.length; i++) {
    const x = padding.left + (dists[i] / dists[dists.length - 1]) * chartW;
    const y = padding.top + chartH - ((elevs[i] - minElev) / elevRange) * chartH;
    points.push({ x, y });
  }

  // Gradient fill — color by grade
  for (let i = 0; i < points.length - 1; i++) {
    const rise = elevs[i + 1] - elevs[i];
    const run = (dists[i + 1] - dists[i]) * 1000;
    const grade = run > 0 ? Math.abs(rise / run) * 100 : 0;
    const color = gradeToColor(grade);

    ctx.beginPath();
    ctx.moveTo(points[i].x, padding.top + chartH);
    ctx.lineTo(points[i].x, points[i].y);
    ctx.lineTo(points[i + 1].x, points[i + 1].y);
    ctx.lineTo(points[i + 1].x, padding.top + chartH);
    ctx.closePath();
    ctx.fillStyle = color + '40'; // 25% opacity
    ctx.fill();
  }

  // Line colored by grade
  for (let i = 0; i < points.length - 1; i++) {
    const rise = elevs[i + 1] - elevs[i];
    const run = (dists[i + 1] - dists[i]) * 1000;
    const grade = run > 0 ? Math.abs(rise / run) * 100 : 0;

    ctx.beginPath();
    ctx.moveTo(points[i].x, points[i].y);
    ctx.lineTo(points[i + 1].x, points[i + 1].y);
    ctx.strokeStyle = gradeToColor(grade);
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Peaks and valleys
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

  _profileCache = ctx.getImageData(0, 0, canvas.width, canvas.height);

  if (hoverIdx !== undefined && hoverIdx >= 0 && hoverIdx < points.length) {
    drawProfileHover(ctx, points, elevs, dists, padding, chartW, chartH, hoverIdx);
  }

  if (!canvas._hasHoverSetup) {
    canvas._hasHoverSetup = true;
    setupProfileHover(canvas, padding);
  }
}

function drawProfileHover(ctx, points, elevs, dists, padding, chartW, chartH, idx) {
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(points[idx].x, padding.top);
  ctx.lineTo(points[idx].x, padding.top + chartH);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(points[idx].x, points[idx].y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#2563eb';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();

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
  if (!map.getSource('elev-hover-point')) {
    map.addSource('elev-hover-point', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'elev-hover-dot',
      type: 'circle',
      source: 'elev-hover-point',
      paint: { 'circle-radius': 6, 'circle-color': '#2563eb', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' },
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

    drawProfileHover(ctx, points, elevs, dists, padding, chartW, chartH, closest);
    ctx.restore();

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

})();
