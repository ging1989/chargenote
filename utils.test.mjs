import test from "node:test";
import assert from "node:assert/strict";
import {
  filterEntriesByPeriod,
  getLocalDateInput,
  previousMonthKey,
  validateEntryForm,
} from "./utils.mjs";

test("getLocalDateInput uses local calendar fields", () => {
  assert.equal(getLocalDateInput(new Date(2026, 0, 2, 0, 30)), "2026-01-02");
});

test("previousMonthKey handles year boundaries", () => {
  assert.equal(previousMonthKey("2026-01"), "2025-12");
  assert.equal(previousMonthKey("2026-06"), "2026-05");
});

test("entry validation rejects blank and zero energy", () => {
  const base = {
    date: "2026-06-06",
    station: "Test",
    kwh: "",
    price_before_disc: "",
    discount: "0",
    peak_type: null,
  };
  assert.equal(validateEntryForm(base, false), false);
  assert.equal(validateEntryForm({ ...base, kwh: "0", price_before_disc: "0" }, false), false);
  assert.equal(validateEntryForm({ ...base, kwh: "10", price_before_disc: "70" }, false), true);
});

test("entry validation enforces peak selection and discount limit", () => {
  const form = {
    date: "2026-06-06",
    station: "Test",
    kwh: "10",
    price_before_disc: "70",
    discount: "80",
    peak_type: null,
  };
  assert.equal(validateEntryForm(form, false), false);
  assert.equal(validateEntryForm({ ...form, discount: "10" }, true), false);
  assert.equal(validateEntryForm({ ...form, discount: "10", peak_type: "on_peak" }, true), true);
});

test("period filter supports month across all years", () => {
  const entries = [
    { date: "2025-06-01" },
    { date: "2026-06-01" },
    { date: "2026-07-01" },
  ];
  assert.equal(filterEntriesByPeriod(entries, 0, 6).length, 2);
  assert.deepEqual(filterEntriesByPeriod(entries, 2026, 6), [entries[1]]);
});
