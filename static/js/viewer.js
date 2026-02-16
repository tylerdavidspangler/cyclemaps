// =====================================================================
// VIEWER PAGE
// =====================================================================
(function() {

let allRoutes = [];
let activeType = 'all';
let searchTerm = '';

// --- Init ---
initMap().then(() => {
  loadRoutes();
  setupHoverPopup();
});

// --- Fetch routes from API ---
async function loadRoutes() {
  const status = document.getElementById('status');
  try {
    // Fetch route list and GeoJSON in parallel
    const [listResp, geoResp] = await Promise.all([
      fetch('/api/routes'),
      fetch('/api/routes/geojson'),
    ]);

    allRoutes = await listResp.json();
    const geojson = await geoResp.json();

    // Add source + layer
    map.addSource('routes', { type: 'geojson', data: geojson });

    map.addLayer({
      id: 'routes-line',
      type: 'line',
      source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['match', ['get', 'route_type'], 'gravel', COLORS.gravel, COLORS.road],
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 14, 6],
        'line-opacity': 0.85,
      },
    });

    // Yellow highlight layer — hidden by default, shown on hover
    map.addLayer({
      id: 'routes-highlight',
      type: 'line',
      source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#facc15',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 14, 10],
        'line-opacity': 0.9,
      },
      filter: ['==', ['get', 'id'], ''],
    });

    buildSidebar();
    document.getElementById('loading-bar').classList.add('done');

    // Keep default Bay Area view — clicking a route will fly to it

  } catch (err) {
    console.error(err);
    status.textContent = 'Failed to load routes. Is the server running?';
  }
}

// --- Build sidebar ---
function buildSidebar() {
  const list = document.getElementById('route-list');
  list.innerHTML = '';

  const filtered = allRoutes.filter(r => {
    if (activeType !== 'all' && r.route_type !== activeType) return false;
    if (searchTerm && !r.name.toLowerCase().includes(searchTerm)) return false;
    return true;
  });

  if (filtered.length === 0 && allRoutes.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#x1f6b4;</div>
        <p>No routes yet.<br><a href="/builder">Create your first route</a></p>
      </div>`;
    return;
  }

  if (filtered.length === 0) {
    list.innerHTML = '<div class="status-msg">No matching routes</div>';
    return;
  }

  // Group by region
  const groups = {};
  for (const route of filtered) {
    const region = route.region || 'Uncategorized';
    if (!groups[region]) groups[region] = [];
    groups[region].push(route);
  }

  // Sort regions alphabetically
  const regions = Object.keys(groups).sort();

  for (const region of regions) {
    const header = document.createElement('div');
    header.className = 'region-header';
    header.textContent = region;
    list.appendChild(header);

    for (const route of groups[region]) {
      const item = document.createElement('div');
      item.className = 'route-item';
      item.dataset.id = route.id;
      item.dataset.type = route.route_type;

      const color = COLORS[route.route_type];
      const label = typeLabel(route.route_type);
      const bg = typeBg(route.route_type);
      const tc = typeColor(route.route_type);

      const meta = [];
      if (route.distance_km) meta.push(formatDistance(route.distance_km));
      if (route.elevation_m) meta.push(formatElevation(route.elevation_m) + ' gain');

      item.innerHTML = `
        <div class="route-name">
          <span class="route-dot" style="background:${color}"></span>
          ${route.name}
          <span class="route-type-tag" style="background:${bg};color:${tc}">${label}</span>
        </div>
        ${route.description ? `<div class="route-desc">${route.description}</div>` : ''}
        ${meta.length ? `<div class="route-meta">${meta.join(' · ')}</div>` : ''}
        <div class="route-actions">
          <button onclick="event.stopPropagation(); location.href='/route/${route.id}'">View</button>
          <button onclick="event.stopPropagation(); window.location.href='/api/routes/${route.id}/gpx'">GPX</button>
          <button onclick="event.stopPropagation(); location.href='/builder/${route.id}'">Edit</button>
          <button class="danger" onclick="event.stopPropagation(); deleteRoute('${route.id}', '${route.name.replace(/'/g, "\\'")}')">Delete</button>
        </div>
      `;

      item.addEventListener('click', () => flyToRoute(route));
      item.addEventListener('mouseenter', () => highlightRoute(route.id));
      item.addEventListener('mouseleave', () => unhighlightRoute());

      list.appendChild(item);
    }
  }
}

// --- Fly to route ---
function flyToRoute(route) {
  if (route.center_lng && route.center_lat) {
    map.flyTo({ center: [route.center_lng, route.center_lat], zoom: 12 });
  }

  // Highlight in sidebar
  document.querySelectorAll('.route-item').forEach(el => el.classList.remove('highlighted'));
  const el = document.querySelector(`.route-item[data-id="${route.id}"]`);
  if (el) el.classList.add('highlighted');

  // Highlight on map
  highlightRoute(route.id);
}

// --- Highlight / unhighlight ---
function highlightRoute(routeId) {
  map.setFilter('routes-highlight', ['==', ['get', 'id'], routeId]);
  // Also highlight in sidebar
  document.querySelectorAll('.route-item').forEach(el => {
    el.classList.toggle('hover', el.dataset.id === routeId);
  });
}

function unhighlightRoute() {
  map.setFilter('routes-highlight', ['==', ['get', 'id'], '']);
  document.querySelectorAll('.route-item').forEach(el => el.classList.remove('hover'));
}

// --- Hover popup on map ---
function setupHoverPopup() {
  map.on('mousemove', 'routes-line', (e) => {
    if (!e.features.length) return;
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    const bg = typeBg(p.route_type);
    const tc = typeColor(p.route_type);

    highlightRoute(p.id);

    const meta = [];
    if (p.distance_km) meta.push(formatDistance(p.distance_km));
    if (p.elevation_m) meta.push(formatElevation(p.elevation_m) + ' gain');

    popup.setLngLat(e.lngLat).setHTML(`
      <div class="popup-name">${p.name}</div>
      ${p.description ? `<div class="popup-desc">${p.description}</div>` : ''}
      ${meta.length ? `<div class="popup-meta">${meta.join(' · ')}</div>` : ''}
      <span class="popup-type" style="background:${bg};color:${tc}">${p.route_type}</span>
    `).addTo(map);
  });
  map.on('mouseleave', 'routes-line', () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
    unhighlightRoute();
  });
}

// --- Delete route ---
window.deleteRoute = async function(id, name) {
  if (!confirm(`Delete "${name}"?`)) return;
  try {
    const resp = await fetch(`/api/routes/${id}`, { method: 'DELETE' });
    if (resp.ok) {
      window.location.reload();
    }
  } catch (err) {
    console.error(err);
    alert('Failed to delete route');
  }
};

// --- Filter buttons ---
document.querySelectorAll('.type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeType = btn.dataset.type;
    document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === activeType));
    buildSidebar();

    // Filter map
    if (activeType === 'all') {
      map.setFilter('routes-line', null);
    } else {
      map.setFilter('routes-line', ['==', ['get', 'route_type'], activeType]);
    }
  });
});

// --- Search ---
document.getElementById('search-input').addEventListener('input', (e) => {
  searchTerm = e.target.value.toLowerCase().trim();
  buildSidebar();
});

})();
