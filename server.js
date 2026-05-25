require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const morgan = require('morgan');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(morgan('dev'));
app.use(cors());
app.use(bodyParser.json());

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY, PORT = 3000 } = process.env;
const VALID_API_KEY = API_KEY && API_KEY !== 'replace_me_with_api_key_if_desired' ? API_KEY : null;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('Warning: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set. Some endpoints may fail.');
}
if (!VALID_API_KEY) {
  console.warn('Note: API_KEY is not set or is using placeholder. API authentication is disabled.');
}

const supabase = createClient(SUPABASE_URL || '', SUPABASE_SERVICE_ROLE_KEY || '');

const path = require('path');
// Serve frontend static files from project root so frontend can call relative /api paths
app.use(express.static(path.join(__dirname)));

function requireApiKey(req, res, next) {
  if (!VALID_API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.api_key || '';
  if (key === VALID_API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.use('/api', requireApiKey);

/* Basic CRUD for charging_sessions */
app.get('/api/charges', async (req, res) => {
  const { data, error } = await supabase.from('charging_sessions').select('*').order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/charges/:id', async (req, res) => {
  const id = req.params.id;
  const { data, error } = await supabase.from('charging_sessions').select('*').eq('id', id).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || null);
});

app.post('/api/charges', async (req, res) => {
  const payload = req.body;
  const { data, error } = await supabase.from('charging_sessions').insert([payload]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(Array.isArray(data) ? data[0] : data);
});

app.put('/api/charges/:id', async (req, res) => {
  const id = req.params.id;
  const payload = req.body;
  const { data, error } = await supabase.from('charging_sessions').update(payload).eq('id', id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(Array.isArray(data) ? data[0] : data);
});

app.delete('/api/charges/:id', async (req, res) => {
  const id = req.params.id;
  const { error } = await supabase.from('charging_sessions').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

// Rates endpoints
app.get('/api/rates', async (req, res) => {
  const { data, error } = await supabase.from('station_rates').select('*');
  if (error) {
    // If table doesn't exist, return empty
    return res.status(200).json([]);
  }
  res.json(data || []);
});

app.post('/api/rates', async (req, res) => {
  const payload = req.body;
  try {
    // upsert by station
    const { data, error } = await supabase.from('station_rates').upsert(payload, { onConflict: ['station'] }).select();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(Array.isArray(data) ? data[0] : data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/rates/:station', async (req, res) => {
  const station = req.params.station;
  const { error } = await supabase.from('station_rates').delete().eq('station', station);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
