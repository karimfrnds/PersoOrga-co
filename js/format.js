// ============================================================================
// format.js – Kleine Format-Helfer (Währung, Datum)
// ============================================================================

function euro(n) {
  const val = Number.isFinite(n) ? n : 0;
  return val.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function hours(n) {
  const val = Number.isFinite(n) ? n : 0;
  return val.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " h";
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function dateDe(yyyymmdd) {
  if (!yyyymmdd) return "";
  const [y, m, d] = yyyymmdd.split("-");
  const weekday = new Date(yyyymmdd + "T12:00:00").toLocaleDateString("de-DE", { weekday: "long" });
  return `${weekday}, ${d}.${m}.${y}`;
}

function monthLabel(yyyymm) {
  const [y, m] = yyyymm.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export { euro, hours, todayStr, dateDe, monthLabel, escapeHtml };
