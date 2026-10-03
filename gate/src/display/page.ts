// The kiosk page. Text only: name, student number, grade, section, time,
// known/unknown (spec, Decisions). Rendered with textContent, never
// innerHTML, so a student's name cannot inject markup. It reloads itself when
// the service reports a different version, so a deploy reaches the monitor
// without anyone touching it.
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Gate</title>
<style>
  :root { --bg: #0b0d10; --fg: #f4f6f8; --muted: #8a94a3; --ok: #2fb36b; --bad: #e05252; --panel: #1c2128; }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; cursor: none; overflow: hidden; }
  #banners { position: fixed; top: 0; left: 0; right: 0; }
  .banner { padding: 1.2vh 3vw; font-size: 3.2vh; font-weight: 700; }
  .banner.bad { background: var(--bad); color: #fff; }
  .banner.quiet { background: var(--panel); color: var(--muted); font-weight: 500; font-size: 2.4vh; }
  main { height: 100%; display: flex; flex-direction: column; justify-content: center; padding: 0 6vw; }
  #status { font-size: 4vh; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  #status.known { color: var(--ok); }
  #status.unknown { color: var(--bad); }
  #name { font-size: 11vh; font-weight: 800; line-height: 1.05; margin: 2vh 0; overflow-wrap: anywhere; }
  #details { font-size: 4.5vh; }
  #meta { margin-top: 3vh; font-size: 3vh; color: var(--muted); font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div id="banners"></div>
<main>
  <div id="status">Please tap your card</div>
  <div id="name"></div>
  <div id="details"></div>
  <div id="meta"></div>
</main>
<script>
const BOOT_VERSION = "{{VERSION}}";
const $ = (id) => document.getElementById(id);
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
let state = null;
let connected = false;
// A tap stays on screen for one minute, then the default message returns, so a
// student is never greeted with someone else's name from minutes ago.
const IDLE_MS = 60 * 1000;
let idleTimer = null;

function renderIdle() {
  $('status').className = '';
  $('status').textContent = 'Please tap your card';
  $('name').textContent = '';
  $('details').textContent = '';
  $('meta').textContent = '';
}

function renderScan(e) {
  clearTimeout(idleTimer);
  // Measured from the tap itself, so a tap replayed after a browser restart
  // only shows if it is still recent.
  const age = Math.max(Date.now() - new Date(e.at).getTime(), 0);
  if (age >= IDLE_MS) { renderIdle(); return; }
  idleTimer = setTimeout(renderIdle, IDLE_MS - age);
  const s = e.student;
  $('status').className = s ? 'known' : 'unknown';
  $('status').textContent = s ? 'Welcome' : 'Unknown card';
  $('name').textContent = s ? s.full_name : e.uid;
  $('details').textContent = s
    ? [s.student_no, s.grade_level, s.section_name].filter(Boolean).join('  ·  ')
    : 'This card is not enrolled. Please see the office.';
  $('meta').textContent = clock(e.at);
}

function renderBanners() {
  const list = [];
  if (!connected) {
    list.push(['bad', 'Scanner service not responding']);
  } else if (state) {
    if (!state.readerOnline) list.push(['bad', 'READER OFFLINE — check the reader USB cable']);
    else if (!state.readerEnabled) list.push(['bad', 'Reader paused — cards are not being accepted']);
    if (state.rosterStale) {
      list.push(['quiet', state.rosterSyncedAt
        ? 'Student list last updated ' + new Date(state.rosterSyncedAt).toLocaleString()
        : 'Student list not downloaded yet']);
    }
    if (state.queueDepth > 0 && (state.uploadOk === false || !state.netOn)) {
      list.push(['quiet', 'Offline — ' + state.queueDepth + ' scan(s) saved, they will be sent when the internet is back']);
    }
  }
  $('banners').replaceChildren(...list.map(([cls, text]) => {
    const div = document.createElement('div');
    div.className = 'banner ' + cls;
    div.textContent = text;
    return div;
  }));
}

const events = new EventSource('/events');
events.onopen = () => { connected = true; renderBanners(); };
events.onerror = () => { connected = false; renderBanners(); };
events.onmessage = (m) => {
  const e = JSON.parse(m.data);
  if (e.type === 'scan') renderScan(e);
  if (e.type === 'state') {
    if (e.state.version !== BOOT_VERSION) { location.reload(); return; }
    state = e.state;
    renderBanners();
  }
};
renderIdle();
renderBanners();
</script>
</body>
</html>
`;
