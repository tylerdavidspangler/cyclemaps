import uuid
import json
import os
from datetime import datetime, timezone
from decimal import Decimal

TABLE_NAME = os.environ.get('DYNAMODB_TABLE', 'cyclemaps-routes')

# Storage backend: 'dynamodb' or 'local'
_backend = None
_table = None         # DynamoDB table (when using dynamodb backend)
_local_file = None    # Path to JSON file (when using local backend)
_local_data = []      # In-memory store (when using local backend)


def init_db():
    """Initialize database. Uses DynamoDB if AWS credentials are available, otherwise falls back to local JSON file."""
    global _backend, _table, _local_file, _local_data

    # Try DynamoDB first
    try:
        import boto3
        from botocore.exceptions import ClientError, NoCredentialsError, PartialCredentialsError

        region = os.environ.get('AWS_DEFAULT_REGION', 'us-west-1')
        dynamodb = boto3.resource('dynamodb', region_name=region)
        table = dynamodb.Table(TABLE_NAME)
        table.load()
        _table = table
        _backend = 'dynamodb'
        print(f'[DB] Connected to DynamoDB table: {TABLE_NAME}')
        return

    except Exception as e:
        err_name = type(e).__name__
        # If it's a missing table, try to create it
        if hasattr(e, 'response') and e.response.get('Error', {}).get('Code') == 'ResourceNotFoundException':
            try:
                table = dynamodb.create_table(
                    TableName=TABLE_NAME,
                    KeySchema=[{'AttributeName': 'id', 'KeyType': 'HASH'}],
                    AttributeDefinitions=[{'AttributeName': 'id', 'AttributeType': 'S'}],
                    BillingMode='PAY_PER_REQUEST',
                )
                table.wait_until_exists()
                _table = table
                _backend = 'dynamodb'
                print(f'[DB] Created DynamoDB table: {TABLE_NAME}')
                return
            except Exception:
                pass

        # Fall back to local storage
        print(f'[DB] DynamoDB unavailable ({err_name}), using local JSON storage')

    # Local JSON file fallback
    _backend = 'local'
    _local_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'routes_data.json')
    if os.path.exists(_local_file):
        with open(_local_file, 'r') as f:
            _local_data = json.load(f)
    else:
        _local_data = []
    print(f'[DB] Local storage: {_local_file} ({len(_local_data)} routes)')


def _save_local():
    """Persist local data to JSON file."""
    with open(_local_file, 'w') as f:
        json.dump(_local_data, f, indent=2, default=str)


def _convert_decimals(obj):
    """Convert Decimal values to float for JSON compatibility."""
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, dict):
        return {k: _convert_decimals(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_convert_decimals(i) for i in obj]
    return obj


# --- CRUD operations ---

def create_route(data):
    """Create a new route. Returns the full saved item."""
    now = datetime.now(timezone.utc).isoformat()
    item = {
        'id': str(uuid.uuid4()),
        'name': data['name'],
        'description': data.get('description', ''),
        'route_type': data.get('route_type', 'road'),
        'region': data.get('region', ''),
        'distance_km': float(data.get('distance_km', 0)),
        'elevation_m': float(data.get('elevation_m', 0)),
        'geometry': data.get('geometry', ''),
        'waypoints': data.get('waypoints', '[]'),
        'center_lng': float(data.get('center_lng', 0)),
        'center_lat': float(data.get('center_lat', 0)),
        'elevation_profile': data.get('elevation_profile', ''),
        'surface_data': data.get('surface_data', ''),
        'created_at': now,
        'updated_at': now,
    }

    if _backend == 'dynamodb':
        # Convert floats to Decimal for DynamoDB
        dynamo_item = json.loads(json.dumps(item), parse_float=Decimal)
        _table.put_item(Item=dynamo_item)
    else:
        _local_data.append(item)
        _save_local()

    return item


def get_route(route_id):
    """Get a single route by ID. Returns item dict or None."""
    if _backend == 'dynamodb':
        resp = _table.get_item(Key={'id': route_id})
        item = resp.get('Item')
        return _convert_decimals(item) if item else None
    else:
        for item in _local_data:
            if item['id'] == route_id:
                return item
        return None


def list_routes():
    """List all routes without geometry (lightweight)."""
    if _backend == 'dynamodb':
        from botocore.exceptions import ClientError
        resp = _table.scan(
            ProjectionExpression='id, #n, description, route_type, #r, distance_km, elevation_m, center_lng, center_lat, created_at, updated_at',
            ExpressionAttributeNames={'#n': 'name', '#r': 'region'},
        )
        items = resp.get('Items', [])
        while 'LastEvaluatedKey' in resp:
            resp = _table.scan(
                ProjectionExpression='id, #n, description, route_type, #r, distance_km, elevation_m, center_lng, center_lat, created_at, updated_at',
                ExpressionAttributeNames={'#n': 'name', '#r': 'region'},
                ExclusiveStartKey=resp['LastEvaluatedKey'],
            )
            items.extend(resp.get('Items', []))
        return _convert_decimals(items)
    else:
        return [{k: v for k, v in item.items() if k not in ('geometry', 'waypoints')} for item in _local_data]


def list_routes_with_geometry():
    """List all routes including geometry."""
    if _backend == 'dynamodb':
        resp = _table.scan()
        items = resp.get('Items', [])
        while 'LastEvaluatedKey' in resp:
            resp = _table.scan(ExclusiveStartKey=resp['LastEvaluatedKey'])
            items.extend(resp.get('Items', []))
        return _convert_decimals(items)
    else:
        return list(_local_data)


def update_route(route_id, data):
    """Update an existing route. Returns updated item or None if not found."""
    existing = get_route(route_id)
    if not existing:
        return None

    now = datetime.now(timezone.utc).isoformat()
    update_fields = {
        'name': data.get('name', existing['name']),
        'description': data.get('description', existing.get('description', '')),
        'route_type': data.get('route_type', existing.get('route_type', 'road')),
        'region': data.get('region', existing.get('region', '')),
        'distance_km': float(data.get('distance_km', existing.get('distance_km', 0))),
        'elevation_m': float(data.get('elevation_m', existing.get('elevation_m', 0))),
        'geometry': data.get('geometry', existing.get('geometry', '')),
        'waypoints': data.get('waypoints', existing.get('waypoints', '[]')),
        'center_lng': float(data.get('center_lng', existing.get('center_lng', 0))),
        'center_lat': float(data.get('center_lat', existing.get('center_lat', 0))),
        'elevation_profile': data.get('elevation_profile', existing.get('elevation_profile', '')),
        'surface_data': data.get('surface_data', existing.get('surface_data', '')),
        'updated_at': now,
    }

    if _backend == 'dynamodb':
        dynamo_fields = json.loads(json.dumps(update_fields), parse_float=Decimal)
        _table.update_item(
            Key={'id': route_id},
            UpdateExpression='SET #n = :name, description = :description, route_type = :route_type, '
                             '#r = :region, distance_km = :distance_km, elevation_m = :elevation_m, '
                             'geometry = :geometry, waypoints = :waypoints, center_lng = :center_lng, '
                             'center_lat = :center_lat, elevation_profile = :elevation_profile, '
                             'surface_data = :surface_data, updated_at = :updated_at',
            ExpressionAttributeNames={'#n': 'name', '#r': 'region'},
            ExpressionAttributeValues={
                ':name': dynamo_fields['name'],
                ':description': dynamo_fields['description'],
                ':route_type': dynamo_fields['route_type'],
                ':region': dynamo_fields['region'],
                ':distance_km': dynamo_fields['distance_km'],
                ':elevation_m': dynamo_fields['elevation_m'],
                ':geometry': dynamo_fields['geometry'],
                ':waypoints': dynamo_fields['waypoints'],
                ':center_lng': dynamo_fields['center_lng'],
                ':center_lat': dynamo_fields['center_lat'],
                ':elevation_profile': dynamo_fields['elevation_profile'],
                ':surface_data': dynamo_fields['surface_data'],
                ':updated_at': dynamo_fields['updated_at'],
            },
        )
    else:
        for i, item in enumerate(_local_data):
            if item['id'] == route_id:
                _local_data[i] = {**existing, **update_fields}
                break
        _save_local()

    return {**existing, **update_fields}


def delete_route(route_id):
    """Delete a route by ID. Returns True if deleted, False if not found."""
    if _backend == 'dynamodb':
        existing = get_route(route_id)
        if not existing:
            return False
        _table.delete_item(Key={'id': route_id})
        return True
    else:
        for i, item in enumerate(_local_data):
            if item['id'] == route_id:
                _local_data.pop(i)
                _save_local()
                return True
        return False
