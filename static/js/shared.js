// =====================================================================
// CONSTANTS & HELPERS
// =====================================================================
const COLORS = { road: '#2563eb', gravel: '#d97706' };

const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

const KM_TO_MI = 0.621371;
const M_TO_FT = 3.28084;

function formatDistance(km) {
  const mi = km * KM_TO_MI;
  if (mi < 0.1) return (mi * 5280).toFixed(0) + ' ft';
  return mi.toFixed(1) + ' mi';
}

function formatElevation(m) {
  return Math.round(m * M_TO_FT).toLocaleString() + ' ft';
}

function typeLabel(type) {
  return type === 'gravel' ? 'Gravel' : 'Road';
}

function typeBg(type) {
  return type === 'road' ? '#dbeafe' : '#fef3c7';
}

function typeColor(type) {
  return type === 'road' ? '#1d4ed8' : '#92400e';
}

// =====================================================================
// MAP INITIALIZATION
// =====================================================================
let map, popup;

function initMap(options = {}) {
  const center = options.center || [0, 20];
  const zoom = options.zoom || 2;

  return fetch(MAP_STYLE_URL)
    .then(r => r.json())
    .then(baseStyle => {
      map = new maplibregl.Map({
        container: 'map',
        style: baseStyle,
        center: center,
        zoom: zoom,
        attributionControl: true,
      });

      map.addControl(new maplibregl.NavigationControl(), 'top-right');
      popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '300px' });

      return new Promise(resolve => {
        map.on('load', () => resolve(map));
      });
    });
}
