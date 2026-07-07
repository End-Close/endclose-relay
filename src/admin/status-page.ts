// Single static admin status page: renders GET /status, refreshes every 5s. Read-only —
// mutations go through relayctl so they carry an actor and are harder to fat-finger.
export const STATUS_PAGE_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>endclose-relay</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
  h1 { font-size: 1.2rem; } h1 small { font-weight: normal; opacity: .6; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  th { opacity: .6; font-weight: normal; }
  .pill { display: inline-block; padding: .05rem .5rem; border-radius: 1rem; border: 1px solid currentColor; }
  .ok { color: #2e7d32; } .warn { color: #e65100; } .bad { color: #c62828; }
  #meta { opacity: .75; }
</style>
<h1>endclose-relay <small id="ver"></small></h1>
<p id="meta">loading…</p>
<div id="ks"></div>
<table id="routes"><thead><tr>
  <th>route</th><th>stream</th><th>state</th><th>pending</th><th>retry</th><th>parked</th>
  <th>delivered</th><th>oldest pending</th><th>last delivered</th>
</tr></thead><tbody></tbody></table>
<script>
async function tick() {
  let s;
  try { s = await (await fetch('/status')).json(); }
  catch { document.getElementById('meta').textContent = 'relay unreachable'; return; }
  document.getElementById('ver').textContent = 'v' + s.version;
  document.getElementById('meta').textContent =
    'uptime ' + fmtDur(s.uptime_s) + ' · config ' + (s.config_hash || '?').slice(0, 19) +
    ' · db ' + (s.storage.db_bytes / 1024 / 1024).toFixed(1) + ' MiB';
  const ks = s.killswitch.global;
  document.getElementById('ks').innerHTML = ks === 'none'
    ? '<span class="pill ok">forwarding</span>'
    : '<span class="pill ' + (ks === 'panic' ? 'bad' : 'warn') + '">killswitch: ' + ks + '</span>';
  const rows = s.routes.map(r => '<tr><td>' + r.id + '</td><td>' + r.data_stream_key + '</td>' +
    '<td>' + (r.paused ? '<span class="warn">paused</span>' : 'active') + '</td>' +
    '<td>' + (r.counts.pending || 0) + '</td>' +
    '<td>' + (r.counts.retry || 0) + '</td>' +
    '<td class="' + (r.counts.parked ? 'bad' : '') + '">' + (r.counts.parked || 0) + '</td>' +
    '<td>' + (r.counts.delivered || 0) + '</td>' +
    '<td>' + (r.oldest_pending_age_s == null ? '—' : fmtDur(r.oldest_pending_age_s)) + '</td>' +
    '<td>' + (r.last_delivered_at ? new Date(r.last_delivered_at).toLocaleString() : '—') + '</td></tr>');
  document.querySelector('#routes tbody').innerHTML = rows.join('');
}
function fmtDur(s) {
  if (s < 90) return s + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  if (s < 172800) return (s / 3600).toFixed(1) + 'h';
  return Math.round(s / 86400) + 'd';
}
tick(); setInterval(tick, 5000);
</script>
`
