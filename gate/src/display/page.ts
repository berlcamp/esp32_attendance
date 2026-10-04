// The kiosk page: the DepEd seal left, the school logo right, a sample school
// backdrop, a photo placeholder (initials for now), and text for the scan: name, student number, grade, section, time,
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
  :root { --bg: #0b0d10; --fg: #f4f6f8; --muted: #a3acba; --ok: #2fb36b; --bad: #e05252; --panel: #1c2128; --school: #c62828; }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; color: var(--fg); font-family: system-ui, sans-serif; cursor: none; overflow: hidden; }
  body {
    display: flex; flex-direction: column;
    background:
      linear-gradient(180deg, rgba(8,10,16,.55) 0%, rgba(8,10,16,.25) 45%, rgba(8,10,16,.75) 100%),
      url('/assets/school-bg.svg') center bottom / cover no-repeat,
      var(--bg);
  }
  header { display: flex; align-items: center; gap: 3vw; padding: 3vh 4vw 0; }
  header img { height: 15vh; width: auto; filter: drop-shadow(0 .6vh 1.2vh rgba(0,0,0,.5)); }
  .title { flex: 1; text-align: center; text-shadow: 0 .3vh 1vh rgba(0,0,0,.6); }
  .title h1 { font-size: 4.6vh; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
  .title p { margin-top: .8vh; font-size: 2.6vh; color: var(--muted); letter-spacing: .12em; text-transform: uppercase; }
  #clock { margin-top: 1.2vh; font-size: 3.4vh; font-weight: 600; font-variant-numeric: tabular-nums; }
  #banners { position: relative; z-index: 1; }
  .banner { padding: 1.2vh 3vw; font-size: 3.2vh; font-weight: 700; }
  .banner.bad { background: var(--bad); color: #fff; }
  .banner.quiet { background: var(--panel); color: var(--muted); font-weight: 500; font-size: 2.4vh; }
  main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2vh 6vw 6vh; }
  #card {
    display: flex; align-items: center; gap: 4vw; width: min(100%, 150vh);
    padding: 5vh 4vw; border-radius: 3vh;
    background: rgba(12,14,20,.72); backdrop-filter: blur(14px);
    border: 1px solid rgba(255,255,255,.08); border-left: 1vh solid var(--school);
    box-shadow: 0 3vh 8vh rgba(0,0,0,.45);
  }
  #card.known { border-left-color: var(--ok); }
  #card.unknown { border-left-color: var(--bad); }
  #photo {
    position: relative; flex: none; height: 34vh; aspect-ratio: 3 / 4; border-radius: 2vh; overflow: hidden;
    background: linear-gradient(160deg, #3a4052, #1c2030); border: .5vh solid rgba(255,255,255,.15);
    display: flex; align-items: center; justify-content: center;
  }
  #card.known #photo { border-color: var(--ok); }
  #card.unknown #photo { border-color: var(--bad); }
  #card.idle #photo { display: none; }
  #photo svg { position: absolute; bottom: 0; width: 90%; fill: rgba(255,255,255,.08); }
  #initials { position: relative; font-size: 10vh; font-weight: 800; color: rgba(255,255,255,.85); }
  #photo small { position: absolute; bottom: 1.4vh; font-size: 1.8vh; letter-spacing: .2em; text-transform: uppercase; color: var(--muted); }
  .info { min-width: 0; flex: 1; }
  #status { font-size: 4vh; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  #status.known { color: var(--ok); }
  #status.unknown { color: var(--bad); }
  #card.idle .info { text-align: center; }
  #card.idle #status { font-size: 7vh; color: var(--fg); letter-spacing: .04em; animation: pulse 2.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .55; } }
  #name { font-size: 9vh; font-weight: 800; line-height: 1.05; margin: 1.5vh 0 2vh; overflow-wrap: anywhere; }
  #name:empty, #details:empty, #meta:empty { display: none; }
  #details { font-size: 4.2vh; }
  #meta { margin-top: 3vh; font-size: 3vh; color: var(--muted); font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<div id="banners"></div>
<header>
  <img src="/assets/deped-logo.png" alt="DepEd">
  <div class="title">
    <h1>Molave Vocational Technical School</h1>
    <p>Student Attendance</p>
    <div id="clock"></div>
  </div>
  <img src="/assets/school-logo.png" alt="Molave Vocational Technical School">
</header>
<main>
  <div id="card" class="idle">
    <div id="photo">
      <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="36" r="20"/><path d="M10 100c0-24 18-38 40-38s40 14 40 38z"/></svg>
      <span id="initials"></span>
      <small>Photo</small>
    </div>
    <div class="info">
      <div id="status">Please tap your card</div>
      <div id="name"></div>
      <div id="details"></div>
      <div id="meta"></div>
    </div>
  </div>
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

// A placeholder until students have photos: their initials, given name first,
// from "Surname, Given" or "Given Surname".
function initials(fullName) {
  const comma = fullName.indexOf(',');
  const words = fullName.trim().split(/\s+/);
  const given = comma >= 0 ? fullName.slice(comma + 1).trim() : words[0];
  const surname = comma >= 0 ? fullName.slice(0, comma).trim() : (words.length > 1 ? words.at(-1) : '');
  return ((given[0] || '') + (surname[0] || '')).toUpperCase() || '?';
}

function renderIdle() {
  $('card').className = 'idle';
  $('initials').textContent = '';
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
  $('card').className = s ? 'known' : 'unknown';
  $('initials').textContent = s ? initials(s.full_name) : '?';
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
function tick() {
  $('clock').textContent = new Date().toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
setInterval(tick, 1000);
tick();
renderIdle();
renderBanners();
</script>
</body>
</html>
`;
