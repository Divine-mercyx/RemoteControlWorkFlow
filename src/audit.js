// Append-only audit trail of session events (one JSON line per event).
// Phase 3: persist to the database and show in the admin panel.
export function createAudit(sink = (line) => console.log(line)) {
  return function audit(event, data = {}) {
    sink(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
  };
}
