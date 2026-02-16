import json
import requests
from xml.sax.saxutils import escape as xml_escape
from flask import Blueprint, request, jsonify, Response
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
            # Replace nulls/NaNs with interpolated or neighbor values
            for j, v in enumerate(batch_elevations):
                if v is None:
                    batch_elevations[j] = 0
            all_elevations.extend(batch_elevations)
        except requests.exceptions.Timeout:
            return jsonify({'error': 'Elevation API timeout'}), 504
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    # Interpolate any zero-placeholder values between valid neighbors
    for i in range(len(all_elevations)):
        if all_elevations[i] == 0:
            # Find nearest non-zero neighbors
            prev_val = next((all_elevations[j] for j in range(i - 1, -1, -1) if all_elevations[j] != 0), None)
            next_val = next((all_elevations[j] for j in range(i + 1, len(all_elevations)) if all_elevations[j] != 0), None)
            if prev_val is not None and next_val is not None:
                all_elevations[i] = (prev_val + next_val) / 2
            elif prev_val is not None:
                all_elevations[i] = prev_val
            elif next_val is not None:
                all_elevations[i] = next_val

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


# --- GPX export ---

@api.route('/routes/<route_id>/gpx', methods=['GET'])
def export_gpx(route_id):
    """Export a route as a GPX file."""
    item = db.get_route(route_id)
    if not item:
        return jsonify({'error': 'Route not found'}), 404

    geometry = json.loads(item.get('geometry', '{}'))
    coords = geometry.get('coordinates', [])
    name = xml_escape(item.get('name', 'Untitled Route'))
    desc = xml_escape(item.get('description', ''))

    trkpts = []
    for coord in coords:
        lng, lat = coord[0], coord[1]
        trkpts.append(f'      <trkpt lat="{lat}" lon="{lng}"></trkpt>')

    gpx = f"""<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="CycleMaps"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>{name}</name>
    <desc>{desc}</desc>
  </metadata>
  <trk>
    <name>{name}</name>
    <trkseg>
{chr(10).join(trkpts)}
    </trkseg>
  </trk>
</gpx>"""

    safe_filename = item.get('name', 'route').replace('"', '').replace('/', '-')
    return Response(
        gpx,
        mimetype='application/gpx+xml',
        headers={'Content-Disposition': f'attachment; filename="{safe_filename}.gpx"'},
    )


# --- Surface data proxy (Overpass API) ---

@api.route('/surface', methods=['POST'])
def surface():
    """
    Query Overpass API for surface tags along a route.
    Expects JSON body: { "coordinates": [[lng, lat], ...] }
    Returns surface type breakdown weighted by route distance.
    """
    import math

    data = request.get_json()
    coords = data.get('coordinates', [])
    if not coords or len(coords) < 2:
        return jsonify({'error': 'Need at least 2 coordinates'}), 400

    # Sample ~40 evenly-spaced points along the route
    step = max(1, len(coords) // 40)
    sampled = coords[::step]
    if sampled[-1] != coords[-1]:
        sampled.append(coords[-1])

    # Query Overpass for ways WITH geometry so we can match points to ways
    coord_str = ','.join(f'{c[1]},{c[0]}' for c in sampled)
    query = f'[out:json][timeout:20];way(around:10,{coord_str})[highway];out body geom;'

    try:
        resp = requests.post(
            'https://overpass-api.de/api/interpreter',
            data={'data': query},
            timeout=25,
        )
        if resp.status_code != 200:
            return jsonify({'error': f'Overpass returned {resp.status_code}'}), 502

        result = resp.json()
        elements = result.get('elements', [])

        if not elements:
            return jsonify({'breakdown': [], 'total_points': 0})

        # Build list of ways with their node geometries and surface tags
        ways = []
        for el in elements:
            geom = el.get('geometry', [])
            if not geom:
                continue
            surface_tag = el.get('tags', {}).get('surface', '')
            way_coords = [(n['lon'], n['lat']) for n in geom]
            ways.append({'surface': surface_tag, 'coords': way_coords})

        def point_to_seg_dist_sq(px, py, ax, ay, bx, by):
            """Squared distance from point (px,py) to segment (ax,ay)-(bx,by)."""
            dx, dy = bx - ax, by - ay
            if dx == 0 and dy == 0:
                return (px - ax) ** 2 + (py - ay) ** 2
            t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
            proj_x, proj_y = ax + t * dx, ay + t * dy
            return (px - proj_x) ** 2 + (py - proj_y) ** 2

        def min_dist_to_way(point, way_coords):
            """Minimum distance from a point to any segment in a way."""
            px, py = point
            best = float('inf')
            for i in range(len(way_coords) - 1):
                d = point_to_seg_dist_sq(px, py, way_coords[i][0], way_coords[i][1],
                                         way_coords[i+1][0], way_coords[i+1][1])
                if d < best:
                    best = d
            return best

        # For each sample point, find the nearest way and record its surface
        paved_set = {'asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes',
                     'cobblestone', 'sett', 'paving_stones', 'metal', 'wood'}
        gravel_set = {'gravel', 'fine_gravel', 'compacted', 'pebblestone'}

        surface_counts = {'paved': 0, 'gravel': 0, 'dirt': 0}
        matched = 0

        for pt in sampled:
            lng, lat = pt[0], pt[1]
            best_dist = float('inf')
            best_surface = ''
            for way in ways:
                d = min_dist_to_way((lng, lat), way['coords'])
                if d < best_dist:
                    best_dist = d
                    best_surface = way['surface']

            if best_surface:
                matched += 1
                if best_surface in paved_set:
                    surface_counts['paved'] += 1
                elif best_surface in gravel_set:
                    surface_counts['gravel'] += 1
                else:
                    surface_counts['dirt'] += 1
            else:
                # Way exists but no surface tag — assume paved (most common for highways)
                matched += 1
                surface_counts['paved'] += 1

        if matched == 0:
            return jsonify({'breakdown': [], 'total_points': 0})

        breakdown = []
        for stype in ['paved', 'gravel', 'dirt']:
            if surface_counts[stype] > 0:
                breakdown.append({
                    'type': stype,
                    'percentage': round(surface_counts[stype] / matched * 100),
                })

        return jsonify({
            'breakdown': breakdown,
            'total_points': matched,
        })

    except requests.exceptions.Timeout:
        return jsonify({'error': 'Overpass timeout'}), 504
    except Exception as e:
        return jsonify({'error': str(e)}), 502
