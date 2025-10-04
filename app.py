import os
import io
import numpy as np
import pandas as pd
import joblib
import torch
import torch.nn as nn
import tensorflow as tf
from flask import Flask, request, render_template, jsonify

app = Flask(__name__)
DATA_DIR = 'data'
DATA_CSV = os.path.join(DATA_DIR, 'data.csv')
if not os.path.exists(DATA_DIR): os.makedirs(DATA_DIR, exist_ok=True)

# --- Load existing models & scalers (kept from your original app.py) ---
try:
    demand_model = tf.keras.models.load_model("models/demand/demand_forecast_model.h5", compile=False)
    demand_model.compile(optimizer='adam', loss='mse')
    consumption_scaler = joblib.load("models/demand/consumption_scaler.pkl")
except Exception as e:
    print(f"Error loading Demand model: {e}")
    demand_model = None

try:
    wind_model = joblib.load("models/wind/wind_forecast_model.pkl")
    wind_scaler = joblib.load("models/wind/wind_features_scaler.pkl")
except Exception as e:
    print(f"Error loading Wind model: {e}")
    wind_model = None

class LSTMSolar(nn.Module):
    def __init__(self, input_size, hidden_size, num_layers, output_size):
        super(LSTMSolar, self).__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True)
        self.fc = nn.Linear(hidden_size, output_size)
    def forward(self, x):
        out, _ = self.lstm(x)
        out = self.fc(out[:, -1, :])
        return out

try:
    input_size = 6
    hidden_size = 64
    num_layers = 2
    output_size = 1
    solar_model = LSTMSolar(input_size, hidden_size, num_layers, output_size)
    solar_model.load_state_dict(torch.load("models/solar/lstm_solar_model.pth"))
    solar_model.eval()
    scaler_X_solar = joblib.load("models/solar/solar_features_scaler.pkl")
    scaler_y_solar = joblib.load("models/solar/solar_target_scaler.pkl")
except Exception as e:
    print(f"Error loading Solar model: {e}")
    solar_model = None

# --- Helper functions ---

def parse_ddmmyyyy(s):
    # s expected like '25092025'
    try:
        return pd.to_datetime(s, format='%d%m%Y')
    except Exception:
        # fallback to generic parse
        return pd.to_datetime(s)


def ensure_csv_columns(df):
    required = ['date','time','consumption','holiday','wind_speed','cloud_coverage','temperature','irradiance']
    cols = [c.lower() for c in df.columns]
    return all(r in cols for r in required)

# --- API endpoints ---

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/api/upload_csv', methods=['POST'])
def upload_csv():
    # receives multipart/form-data with file field 'file'
    f = request.files.get('file')
    if not f:
        return jsonify({'error':'No file provided'}), 400
    
    # Try different encodings
    encodings = ['utf-8', 'utf-8-sig', 'latin-1', 'iso-8859-1', 'cp1252']
    df = None
    last_error = None
    
    for encoding in encodings:
        try:
            f.seek(0)  # Reset file pointer
            s = f.read().decode(encoding)
            df = pd.read_csv(io.StringIO(s))
            print(f"Successfully read CSV with {encoding} encoding")
            break
        except Exception as e:
            last_error = e
            continue
    
    if df is None:
        return jsonify({'error':f'Failed to read CSV with any encoding. Last error: {last_error}'}), 400

    # normalize column names
    df.columns = [c.strip().lower() for c in df.columns]
    
    if not ensure_csv_columns(df):
        return jsonify({'error':'CSV missing required columns. Required: date,time,consumption,holiday,wind_speed,cloud_coverage,temperature,irradiance'}), 400

    if len(df) < 24:
        return jsonify({'error':'CSV must contain at least 24 rows of last-24-hour data'}), 400

    # Validate data types
    try:
        df['consumption'] = pd.to_numeric(df['consumption'], errors='coerce')
        df['holiday'] = pd.to_numeric(df['holiday'], errors='coerce')
        df['wind_speed'] = pd.to_numeric(df['wind_speed'], errors='coerce')
        df['cloud_coverage'] = pd.to_numeric(df['cloud_coverage'], errors='coerce')
        df['temperature'] = pd.to_numeric(df['temperature'], errors='coerce')
        df['irradiance'] = pd.to_numeric(df['irradiance'], errors='coerce')
        df['time'] = pd.to_numeric(df['time'], errors='coerce')
        
        # Check for NaN values
        if df[['consumption', 'holiday', 'wind_speed', 'cloud_coverage', 'temperature', 'irradiance', 'time']].isnull().any().any():
            return jsonify({'error':'CSV contains invalid numeric values. Please check your data.'}), 400
    except Exception as e:
        return jsonify({'error':f'Data validation error: {e}'}), 400

    # save as server CSV (overwrite)
    df.to_csv(DATA_CSV, index=False)

    # determine last row's date/time to initialize frontend
    last = df.iloc[-1]
    # last date in CSV expected DDMMYYYY
    try:
        last_dt = parse_ddmmyyyy(str(int(last['date'])))
        last_date_iso = last_dt.strftime('%Y-%m-%d')
    except Exception as e:
        try:
            last_date_iso = pd.to_datetime(str(last['date'])).strftime('%Y-%m-%d')
        except Exception as e2:
            return jsonify({'error':f'Invalid date format in CSV. Expected DDMMYYYY format. Error: {e2}'}), 400

    last_time = int(last['time'])
    return jsonify({'ok':True, 'last_date': last_date_iso, 'last_time': last_time, 'rows': len(df)}), 200


@app.route('/api/tick', methods=['POST'])
def api_tick():
    # append tick data (JSON) to server CSV
    j = request.get_json() or {}
    expected = ['date','time','consumption','holiday','wind_speed','cloud_coverage','temperature','irradiance']
    if not all(k in j for k in expected):
        return jsonify({'error':'Missing fields in tick payload'}), 400

    # append row to CSV (create file with header if not exists)
    row = {k: j[k] for k in expected}
    # persist
    if os.path.exists(DATA_CSV):
        df = pd.read_csv(DATA_CSV)
        new_row_df = pd.DataFrame([row])
        df = pd.concat([df, new_row_df], ignore_index=True)
    else:
        df = pd.DataFrame([row])
    df.to_csv(DATA_CSV, index=False)
    return jsonify({'ok':True}), 200


@app.route('/api/predict', methods=['POST'])
def api_predict():
    # Use last 24 rows from data.csv to produce predictions
    if not os.path.exists(DATA_CSV):
        return jsonify({'error':'No data on server. Upload CSV first.'}), 400
    try:
        df = pd.read_csv(DATA_CSV)
        df.columns = [c.lower() for c in df.columns]
    except Exception as e:
        return jsonify({'error':f'Failed to read server CSV: {e}'}), 500

    if len(df) < 24:
        return jsonify({'error':'Not enough rows (need >=24)'}), 400

    # build datetime and sort
    try:
        df['datetime'] = df.apply(lambda r: parse_ddmmyyyy(str(r['date'])) + pd.to_timedelta(int(r['time']), unit='h'), axis=1)
    except Exception:
        # attempt generic parse
        df['datetime'] = pd.to_datetime(df['date']) + pd.to_timedelta(df['time'].astype(int), unit='h')
    df = df.sort_values('datetime').reset_index(drop=True)
    last24 = df.iloc[-24:].copy().reset_index(drop=True)

    # prepare predictions structure
    result = {'solar_gen':0.0, 'wind_gen':0.0, 'demand_forecast':0.0}

    # --- Demand: use last 24 rows as sequence ---
    if demand_model is not None and 'consumption' in last24.columns:
        try:
            # scaled consumption vector (24x1)
            cons_vals = last24['consumption'].astype(float).values.reshape(-1,1)
            scaled_cons = consumption_scaler.transform(cons_vals).reshape(-1,)
            days = np.array([parse_ddmmyyyy(str(d)).day for d in last24['date']])
            months = np.array([parse_ddmmyyyy(str(d)).month for d in last24['date']])
            scaled_day = (days.astype(float) / 6.0)
            scaled_time = (last24['time'].astype(float) / 23.0)
            holiday_vec = last24['holiday'].astype(float).values

            demand_features = np.stack([scaled_cons, scaled_day, scaled_time, holiday_vec], axis=1)  # shape (24,4)
            demand_sequence = np.expand_dims(demand_features, axis=0)  # shape (1,24,4)

            pred_scaled = demand_model.predict(demand_sequence)
            # inverse transform
            pred_demand = consumption_scaler.inverse_transform(pred_scaled)[0,0]
            result['demand_forecast'] = float(np.round(pred_demand,2))
        except Exception as e:
            result['demand_error'] = str(e)

    # --- Wind: use the latest row and mapping for time (mapping kept for wind) ---
    if wind_model is not None:
        try:
            latest = last24.iloc[-1]
            dt = parse_ddmmyyyy(str(latest['date']))
            day = float(dt.day); month = float(dt.month)
            mapped_time = (0 if int(latest['time'])<6 else (6 if int(latest['time'])<12 else (12 if int(latest['time'])<18 else 18)))
            wind_df = pd.DataFrame([[day, month, mapped_time, float(latest['wind_speed']), float(latest['cloud_coverage'])]],
                                   columns=["day","month","time","wind_speed","cloud_coverage"])
            wind_scaled = wind_scaler.transform(wind_df)
            pred_wind = (wind_model.predict(wind_scaled)[0])/6
            # clamp to sensible max
            pred_wind = float(np.round(np.clip(pred_wind, 0, 160),2))
            result['wind_gen'] = pred_wind
        except Exception as e:
            result['wind_error'] = str(e)

    # --- Solar: use last 24 rows (time mapping removed) ---
    if solar_model is not None and scaler_X_solar is not None and scaler_y_solar is not None:
        try:
            feats = []
            for _, r in last24.iterrows():
                dt = parse_ddmmyyyy(str(r['date']))
                day = float(dt.day); month = float(dt.month)
                # MODIFIED: Use the raw 'time' feature directly
                raw_time = float(r['time'])
                feats.append([day, month, raw_time, float(r['temperature']), float(r['irradiance']), float(r['cloud_coverage'])])
            
            feat_arr = np.array(feats)  # shape (24,6)
            feat_scaled = scaler_X_solar.transform(feat_arr)  # (24,6)
            solar_seq = np.expand_dims(feat_scaled, axis=0).astype(np.float32)  # (1,24,6)
            solar_tensor = torch.tensor(solar_seq)
            
            with torch.no_grad():
                pred_scaled_solar = solar_model(solar_tensor).numpy()
            
            pred_solar = (scaler_y_solar.inverse_transform(pred_scaled_solar)[0,0])/6
            # clamp to solarMax
            pred_solar = float(np.round(np.clip(pred_solar, 0, 340),2))
            result['solar_gen'] = pred_solar
        except Exception as e:
            result['solar_error'] = str(e)
        if int(latest['time'])<4 or int(latest['time'])>18:
            result['solar_gen'] = 0.0  # enforce zero generation before 4 AM

    return jsonify(result), 200

# Keep original /predict route (to preserve your form-based flow)
@app.route('/predict', methods=['POST'])
def predict_form():
    # keep your existing implementation intact (not shown here for brevity) — simply reuse existing code
    return render_template('index.html', prediction_text='Legacy predict: use /api/predict for JSON')

if __name__ == '__main__':
    app.run(debug=True)
