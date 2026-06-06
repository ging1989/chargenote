const test = require('node:test');
const assert = require('node:assert/strict');
const { chargePayload, ratePayload, validateCharge, validateRate } = require('./server-utils.cjs');

test('API payload helpers remove untrusted fields', () => {
  assert.deepEqual(chargePayload({ date: '2026-06-06', user_id: 'other', final_price: 1 }), { date: '2026-06-06' });
  assert.deepEqual(ratePayload({ station: 'A', user_id: 'other', unknown: true }), { station: 'A' });
});

test('charge API validation accepts valid data and rejects invalid totals', () => {
  const valid = {
    date: '2026-06-06',
    station: 'A',
    kwh: 10,
    price_before_disc: 70,
    discount: 5,
    peak_type: null,
  };
  assert.equal(validateCharge(valid), null);
  assert.match(validateCharge({ ...valid, kwh: 0 }), /kWh/);
  assert.match(validateCharge({ ...valid, discount: 80 }), /Discount/);
});

test('rate API validation follows the selected rate type', () => {
  assert.equal(validateRate({ station: 'A', rate_type: 'flat', flat: 7.5 }), null);
  assert.equal(validateRate({ station: 'A', rate_type: 'peak', on_peak: 8, off_peak: 5 }), null);
  assert.match(validateRate({ station: 'A', rate_type: 'flat', flat: -1 }), /Rates/);
});
