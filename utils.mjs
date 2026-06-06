export function getLocalDateInput(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function validateEntryForm(form, isPeak) {
  const kwh = Number(form.kwh);
  const price = Number(form.price_before_disc);
  const discount = Number(form.discount || 0);

  return Boolean(
    form.date &&
    form.station &&
    form.kwh !== "" &&
    form.price_before_disc !== "" &&
    Number.isFinite(kwh) &&
    Number.isFinite(price) &&
    Number.isFinite(discount) &&
    kwh > 0 &&
    price >= 0 &&
    discount >= 0 &&
    discount <= price &&
    (!isPeak || form.peak_type)
  );
}

export function filterEntriesByPeriod(entries, year, month) {
  return entries.filter(entry => {
    const entryYear = Number(entry.date.slice(0, 4));
    const entryMonth = Number(entry.date.slice(5, 7));
    return (year === 0 || entryYear === year) && (month === 0 || entryMonth === month);
  });
}

export function previousMonthKey(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(year, month - 2, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
