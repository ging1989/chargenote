const CHARGE_FIELDS = ['date', 'station', 'trip', 'peak_type', 'price_before_disc', 'kwh', 'discount', 'rate_snapshot'];
const RATE_FIELDS = ['station', 'rate_type', 'on_peak', 'off_peak', 'on_time', 'off_time', 'flat', 'color', 'abbr'];

function pick(body, fields) {
  return Object.fromEntries(fields.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
}

function chargePayload(body) {
  return pick(body, CHARGE_FIELDS);
}

function ratePayload(body) {
  return pick(body, RATE_FIELDS);
}

function validateCharge(payload) {
  const price = Number(payload.price_before_disc);
  const kwh = Number(payload.kwh);
  const discount = Number(payload.discount ?? 0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.date || '')) return 'Invalid date';
  if (typeof payload.station !== 'string' || !payload.station.trim()) return 'Station is required';
  if (!Number.isFinite(kwh) || kwh <= 0) return 'kWh must be greater than zero';
  if (!Number.isFinite(price) || price < 0) return 'Price must be zero or greater';
  if (!Number.isFinite(discount) || discount < 0 || discount > price) return 'Discount is invalid';
  if (payload.peak_type != null && !['on_peak', 'off_peak'].includes(payload.peak_type)) return 'Invalid peak type';
  return null;
}

function validateRate(payload) {
  if (typeof payload.station !== 'string' || !payload.station.trim()) return 'Station is required';
  if (!['flat', 'peak'].includes(payload.rate_type)) return 'Invalid rate type';
  const values = payload.rate_type === 'flat' ? [payload.flat] : [payload.on_peak, payload.off_peak];
  if (values.some(value => !Number.isFinite(Number(value)) || Number(value) < 0)) return 'Rates must be zero or greater';
  return null;
}

module.exports = { chargePayload, ratePayload, validateCharge, validateRate };
