from flask import Flask, redirect, render_template
import database as db
from routes_api import api

app = Flask(__name__)
app.register_blueprint(api)


# --- Page routes ---

@app.route('/')
def index():
    return redirect('/viewer')


@app.route('/viewer')
def viewer():
    return render_template('viewer.html')


@app.route('/builder')
def builder():
    return render_template('builder.html')


@app.route('/builder/<route_id>')
def builder_edit(route_id):
    return render_template('builder.html', route_id=route_id)


# --- Init ---

if __name__ == '__main__':
    db.init_db()
    app.run(debug=True, host='0.0.0.0', port=8080)
