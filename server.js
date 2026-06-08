require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const morgan = require('morgan');
const { chargePayload, ratePayload, validateCharge, validateRate } = require('./server-utils.cjs');

const app = express();
app.use(morgan('dev'));
app.use(express.json({ limit: '100kb' }));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PORT = 3000 } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Warning: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set. Some endpoints may fail.');
}

const supabase = createClient(SUPABASE_URL || '', SUPABASE_SERVICE_ROLE_KEY || '');

const path = require('path');
app.use(express.static(__dirname));

async function requireUser(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired session' });
  req.user = data.user;
  next();
}

app.use('/api', requireUser);

/* Basic CRUD for charging_sessions */
app.get('/api/charges', async (req, res) => {
  const { data, error } = await supabase.from('charging_sessions').select('*').eq('user_id', req.user.id).order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/charges/:id', async (req, res) => {
  const id = req.params.id;
  const { data, error } = await supabase.from('charging_sessions').select('*').eq('user_id', req.user.id).eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Charge not found' });
  res.json(data || null);
});

app.post('/api/charges', async (req, res) => {
  const clean = chargePayload(req.body);
  const invalid = validateCharge(clean);
  if (invalid) return res.status(400).json({ error: invalid });
  const payload = { ...clean, station: clean.station.trim(), user_id: req.user.id };
  const { data, error } = await supabase.from('charging_sessions').insert([payload]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(Array.isArray(data) ? data[0] : data);
});

app.put('/api/charges/:id', async (req, res) => {
  const id = req.params.id;
  const payload = chargePayload(req.body);
  const invalid = validateCharge(payload);
  if (invalid) return res.status(400).json({ error: invalid });
  payload.station = payload.station.trim();
  const { data, error } = await supabase.from('charging_sessions').update(payload).eq('user_id', req.user.id).eq('id', id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(Array.isArray(data) ? data[0] : data);
});

app.delete('/api/charges/:id', async (req, res) => {
  const id = req.params.id;
  const { error } = await supabase.from('charging_sessions').delete().eq('user_id', req.user.id).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

// Rates endpoints
app.get('/api/rates', async (req, res) => {
  const { data, error } = await supabase.from('station_rates').select('*').eq('user_id', req.user.id);
  if (error) {
    // If table doesn't exist, return empty
    return res.status(200).json([]);
  }
  res.json(data || []);
});

app.post('/api/rates', async (req, res) => {
  const clean = ratePayload(req.body);
  const invalid = validateRate(clean);
  if (invalid) return res.status(400).json({ error: invalid });
  const payload = { ...clean, station: clean.station.trim(), user_id: req.user.id };
  try {
    // upsert by station
    const { data, error } = await supabase.from('station_rates').upsert(payload, { onConflict: ['user_id', 'station'] }).select();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(Array.isArray(data) ? data[0] : data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/rates/:station', async (req, res) => {
  const station = req.params.station;
  const { error } = await supabase.from('station_rates').delete().eq('user_id', req.user.id).eq('station', station);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
