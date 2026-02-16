import json
import requests
from flask import Blueprint, request, jsonify
import database as db

api = Blueprint('api', __name__, url_prefix='/api')


# --- Route CRUD ---

@api.route('/routes', methods=['GET'])
def list_routes():
    """List all routes (lightweight — no geometry)."""
    return jsonify(db.list_routes())


@api.route('/routes/geojson', methods=['GET'])
def routes_geojson():
    """All routes as a GeoJSON FeatureCollection for the map."""
    items = db.list_routes_with_geometry()
    features = []
    for item in items:
        geometry_str = item.get('geometry', '')
        if not geometry_str:
            continue
        try:
            geometry = json.loads(geometry_str)
        except (json.JSONDecodeError, TypeError):
            continue

        props = {k: v for k, v in item.items() if k not in ('geometry', 'waypoints')}
        features.append({
            'type': 'Feature',
            'geometry': geometry,
            'properties': props,
        })

    return jsonify({
        'type': 'FeatureCollection',
        'features': features,
    })


@api.route('/routes/<route_id>', methods=['GET'])
def get_route(route_id):
    """Get a single route with full geometry and waypoints."""
    item = db.get_route(route_id)
    if not item:
        return jsonify({'error': 'Route not found'}), 404
    return jsonify(item)


@api.route('/routes', methods=['POST'])
def create_route():
    """Create a new route."""
    data = request.get_json()
    if not data or not data.get('name'):
        return jsonify({'error': 'Name is required'}), 400
    item = db.create_route(data)
    return jsonify(item), 201


@api.route('/routes/<route_id>', methods=['PUT'])
def update_route(route_id):
    """Update an existing route."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400
    item = db.update_route(route_id, data)
    if not item:
        return jsonify({'error': 'Route not found'}), 404
    return jsonify(item)


@api.route('/routes/<route_id>', methods=['DELETE'])
def delete_route(route_id):
    """Delete a route."""
    deleted = db.delete_route(route_id)
    if not deleted:
        return jsonify({'error': 'Route not found'}), 404
    return jsonify({'ok': True})


# --- Elevation proxy ---

@api.route('/elevation', methods=['POST'])
def elevation():
    """
    Proxy to Open-Meteo Elevation API.
    Expects JSON body: { "coordinates": [[lng, lat], ...] }
    Returns: { "elevations": [...], "elevation_gain_m": ... }
    """
    data = request.get_json()
    coords = data.get('coordinates', [])
    if not coords:
        return jsonify({'error': 'No coordinates provided'}), 400

    # Round coordinates to 4 decimal places (~11m precision) to keep URLs shorter
    coords = [[round(c[0], 4), round(c[1], 4)] for c in coords]

    # Open-Meteo handles up to ~100 coords per request; batch if needed
    BATCH_SIZE = 80
    all_elevations = []

    for i in range(0, len(coords), BATCH_SIZE):
        batch = coords[i:i + BATCH_SIZE]
        latitudes = ','.join(str(c[1]) for c in batch)
        longitudes = ','.join(str(c[0]) for c in batch)

        try:
            resp = requests.get(
                'https://api.open-meteo.com/v1/elevation',
                params={'latitude': latitudes, 'longitude': longitudes},
                timeout=15,
            )
            if resp.status_code != 200:
                return jsonify({'error': f'Elevation API returned {resp.status_code}'}), 502

            result = resp.json()
            batch_elevations = result.get('elevation', [])
            all_elevations.extend(batch_elevations)
        except requests.exceptions.Timeout:
            return jsonify({'error': 'Elevation API timeout'}), 504
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    # Calculate elevation gain (sum of positive deltas)
    gain = 0.0
    for i in range(1, len(all_elevations)):
        delta = all_elevations[i] - all_elevations[i - 1]
        if delta > 0:
            gain += delta

    return jsonify({
        'elevations': all_elevations,
        'elevation_gain_m': round(gain),
    })
