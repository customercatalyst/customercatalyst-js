/*!
 * CustomerCatalyst Messenger widget (phases 1b + 2). No dependencies, loaded on customers' pages.
 *   <script src="<host>/v1/messenger.js" data-key="pk_…" async></script>
 * Opens from its corner launcher (if shown), from any element with data-ccm-open="new" | "home",
 * or from CustomerCatalystMessenger.open() / .close(). window.ccMessengerSettings (optional, set
 * before the script) may carry { key, name, email }: key when there is no data-key, name/email to
 * prefill the New screen. Globals: CustomerCatalystMessenger only; browser storage: ccm_ keys only.
 * Never touches the tracking SDK (CustomerCatalyst / customercatalyst) or CustomerCatalystForm.
 * Every message opens a new ticket and returns a conversation token; the browser keeps up to 20
 * (ccm_conversations) and shows only those conversations: list, thread, replies in the widget.
 * Tokens live in storage and POST bodies only — never in URLs, the console or DOM attributes.
 * Polling: the thread every 10 s and the list every 30 s, only while that screen is open and the tab
 * visible; with the panel closed, one check at load drives the launcher's unread dot.
 * Look: the design canvas (Widget-Home / New / Sent / OnSite / Conversations / Thread). All org and visitor text goes in
 * with textContent; links only http(s). data-preview="1" (/v1/messenger/preview) never fetches
 * and never sends: it takes {type:"cc-messenger-preview", config} from the settings page by postMessage.
 * Served by the Worker together with ../shared/kit.js; this file alone does not run.
 */
(function () {
  'use strict';
  var script = ownScript('messenger.js');
  if (!script || !script.src) return;
  var HOST = new URL(script.src).origin;
  if (window.CustomerCatalystMessenger && window.CustomerCatalystMessenger.loaded) return; // pasted twice
  var settings = window.ccMessengerSettings && typeof window.ccMessengerSettings === 'object' ? window.ccMessengerSettings : {};
  var key = script.getAttribute('data-key') || (typeof settings.key === 'string' ? settings.key : '');
  var preview = script.getAttribute('data-preview') === '1';
  if (!preview && !KEY_RE.test(key)) return;
  var uid = 'ccm' + Math.random().toString(36).slice(2, 8);
  var STORE = 'ccm_visitor', CONV = 'ccm_conversations';
  var TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

  var TEXTS = ['title', 'greeting', 'reply_time', 'new_button', 'message_hint', 'after_send'], MULTI = ['greeting', 'after_send'];
  var DEFAULTS = { greeting: 'Ask us anything. We read every message.', reply_time: 'We usually reply within a few hours',
    new_button: 'Send us a message', message_hint: 'Write your message…', after_send: 'Thanks! We\'ve got it.' };

  // 24×24 stroke icons (the canvas's own paths where it has one). Circles are written as arcs so
  // everything is a <path>.
  var ICONS = {
    bubble: ['M4 5h16v11H8l-4 4z'],
    question: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z', 'M9.6 9.3a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2.2-2.5 3.8', 'M12 17.3h.01'],
    headset: ['M4 15v-3a8 8 0 0 1 16 0v3', 'M4 15a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2z', 'M20 15a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2z'],
    dots: ['M4 5h16v11H8l-4 4z', 'M8.5 10.5h.01', 'M12 10.5h.01', 'M15.5 10.5h.01'],
    envelope: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'],
    close: ['M6 6l12 12M18 6L6 18'],
    send: ['M4 12l16-8-6 16-3-7z'],
    back: ['M15 6l-6 6 6 6'],
    out: ['M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    check: ['M5 12l5 5 9-10'],
    next: ['M9 6l6 6-6 6'],
    clip: ['M21 11l-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8'],
    down: ['M12 4v11M7 10l5 5 5-5M5 20h14']
  };
  var LAUNCHER_ICONS = ['bubble', 'question', 'headset', 'dots', 'envelope'];
  function icon(name) {
    var NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg');
    [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'],
      ['stroke-linejoin', 'round'], ['aria-hidden', 'true'], ['focusable', 'false']].forEach(function (a) { s.setAttribute(a[0], a[1]); });
    ICONS[name].forEach(function (d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }

  // ── config ────────────────────────────────────────────────────────────────
  // The form's clean-up plus the messenger block: enums checked here, texts one line, capped.
  function cleanM(c) {
    var out = clean(c), m = c && c.messenger;
    if (m && typeof m === 'object') {
      var o = {};
      if ('position' in m) o.position = m.position === 'left' ? 'left' : 'right';
      if ('launcher_shown' in m) o.launcher_shown = m.launcher_shown !== false;
      if ('icon' in m) o.icon = LAUNCHER_ICONS.indexOf(m.icon) !== -1 ? m.icon : 'bubble';
      if (m.texts && typeof m.texts === 'object') {
        o.texts = {};
        // greeting and after_send may run over several lines (shown with pre-line, as text); the rest is one line.
        TEXTS.forEach(function (k) {
          if (!(k in m.texts)) return;
          o.texts[k] = MULTI.indexOf(k) !== -1 ? capStr(m.texts[k], 2000).replace(/\r\n?/g, '\n') : capStr(m.texts[k], 500).replace(/[\r\n\t]+/g, ' ');
        });
      }
      out.messenger = o;
    }
    return out;
  }
  // Settings-preview updates accumulate, the messenger block and its texts included.
  function mergeM(a, b) {
    var o = merge(a, b);
    if (a.messenger && b.messenger) {
      o.messenger = merge(a.messenger, b.messenger);
      if (a.messenger.texts && b.messenger.texts) o.messenger.texts = merge(a.messenger.texts, b.messenger.texts);
    }
    return o;
  }
  function m(cfg) { return cfg.messenger || {}; }
  function text(cfg, k) {
    var v = str((m(cfg).texts || {})[k]);
    if (v) return v;
    if (k === 'title') return str(cfg.org_name) ? 'Hi, we\'re ' + str(cfg.org_name) : 'Hi there';
    return DEFAULTS[k];
  }

  // ── remembered visitor (email identity) ───────────────────────────────────
  function remembered() {
    if (preview) return null;
    try {
      var v = JSON.parse(window.localStorage.getItem(STORE) || 'null');
      if (v && typeof v.name === 'string' && typeof v.email === 'string' && str(v.name) && str(v.name).length <= LIMITS.name
        && EMAIL_RE.test(str(v.email)) && str(v.email).length <= LIMITS.email) return { name: str(v.name), email: str(v.email) };
    } catch (e) { /* storage blocked or junk */ }
    return null;
  }
  function remember(v) { try { window.localStorage.setItem(STORE, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
  // "Not you?": the identity AND the conversations this browser was given.
  function forget() {
    try { window.localStorage.removeItem(STORE); window.localStorage.removeItem(CONV); } catch (e) { /* storage blocked */ }
    convData = {};
    marks();
  }
  // "Not you?" with conversations on this device asks first, inside the box (no browser dialog).
  // keep = the box's normal children, put back on Cancel.
  function askForget(box, keep, yes) {
    var n = convs().length;
    if (!n) return yes();
    var no = h('button', { type: 'button', 'class': 'lnk no' }, ['Forget']);
    var back = h('button', { type: 'button', 'class': 'lnk' }, ['Cancel']);
    no.addEventListener('click', yes);
    back.addEventListener('click', function () { box.replaceChildren.apply(box, keep); keep[keep.length - 1].focus(); });
    box.replaceChildren(h('div', { 'class': 'ask', role: 'alert' }, [
      'Forget your details and ' + n + (n === 1 ? ' conversation' : ' conversations') + ' on this device? You can still reply by email.',
      h('span', {}, [no, back])]));
    no.focus();
  }

  // ── conversations this browser holds: [{t, label, subject, read_at}], newest first, max 20 ──
  function convs() {
    if (preview) return [];
    try {
      var v = JSON.parse(window.localStorage.getItem(CONV) || '[]');
      return (Array.isArray(v) ? v : []).filter(function (c) { return c && typeof c.t === 'string' && TOKEN_RE.test(c.t); }).slice(0, 20)
        .map(function (c) { return { t: c.t, label: capStr(c.label, 40), subject: capStr(c.subject, LIMITS.subject), read_at: capStr(c.read_at, 40) }; });
    } catch (e) { return []; }
  }
  function saveConvs(list) { try { window.localStorage.setItem(CONV, JSON.stringify(list.slice(0, 20))); } catch (e) { /* storage blocked */ } }
  // Newest first.
  function addConv(c) {
    saveConvs([c].concat(convs().filter(function (x) { return x.t !== c.t; })));
  }
  function setRead(t, at) {
    var list = convs(), hit = false;
    list.forEach(function (c) { if (c.t === t && newer(at, c.read_at)) { c.read_at = at; hit = true; } });
    if (hit) saveConvs(list);
  }
  var line1 = function (v, max) { return capStr(v, max).replace(/[\r\n\t]+/g, ' ').trim(); };
  function cleanConv(c) {
    return { label: line1(c.label, 40), subject: line1(c.subject, LIMITS.subject), status: STATUS[c.status] ? c.status : 'open',
      last_at: capStr(c.last_at, 40), last_from: c.last_from === 'you' ? 'you' : 'team', last_kind: c.last_kind === 'email' ? 'email' : 'message', last_preview: line1(c.last_preview, 120),
      last_team_at: capStr(c.last_team_at, 40), last_author: line1(c.last_author, 60), last_initials: line1(c.last_initials, 3) };
  }
  var STATUS = { open: 'Open', solved: 'Solved', closed: 'Closed' };
  // Stored entries merged with the last answer. Once an answer is in, only the conversations it knows show.
  function convList() {
    return convs().map(function (c) { var d = convData && convData[c.t]; return d ? merge(d, { t: c.t, read_at: c.read_at, subject: d.subject || c.subject, label: d.label || c.label }) : convData ? null : c; })
      .filter(Boolean);
  }
  function unread(c) { return !!(c.last_team_at && newer(c.last_team_at, c.read_at)); }

  // ── time ──────────────────────────────────────────────────────────────────
  function when(v) { var d = new Date(v); return v && !isNaN(d) ? d : null; }
  function newer(a, b) { var x = when(a), y = when(b); return !!x && (!y || x > y); }
  function hm(d) { return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
  function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
  function yesterday() { var y = new Date(); y.setDate(y.getDate() - 1); return y; }
  function dayLabel(d) {
    return sameDay(d, new Date()) ? 'Today' : sameDay(d, yesterday()) ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function ago(v) {
    var d = when(v), now = new Date();
    if (!d) return '';
    if (Math.abs(now - d) < 60000) return 'Now';
    return sameDay(d, now) ? hm(d) : sameDay(d, yesterday()) ? 'Yesterday' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  // ── requests ──────────────────────────────────────────────────────────────
  function answer(p) {
    return p.then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return { status: r.status, b: b }; }); },
      function () { return { status: 0, b: null }; });
  }
  function postJson(path, body) {
    return fetch(HOST + path, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  // ── look ──────────────────────────────────────────────────────────────────
  // Values copied from the canvas (Widget-Home / New / Sent / OnSite); #0E6B5C there is the
  // example org colour. Owner rules on top: field borders #CFD8D5, placeholders #727776, subtle
  // focus (1px org colour + 3px ring at 15%), own select chevron, one 12px footer line.
  function css(cfg) {
    var p = palette(cfg.color), k = cfg.corners === 'square' ? 0 : cfg.corners === 'pill' ? 2 : 1;
    var R = ['4px', '10px', '21px'][k], BTN = ['4px', '10px', '999px'][k], CARD = ['4px', '12px', '16px'][k];
    var AREA = ['4px', '10px', '16px'][k], PANEL = ['4px', '16px', '16px'][k];
    var side = m(cfg).position === 'left' ? 'left' : 'right';
    var launcher = m(cfg).launcher_shown !== false;
    var font = cfg.font === 'inter' ? 'Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif' : 'inherit';
    var ring = '0 0 0 3px ' + p.ring;
    // font-family on :host itself: after all:initial, "inherit" there still reaches the page's font.
    return ':host{all:initial;font-family:' + font + '}' +
      '.r{font-family:' + font + ';color:#13231F;font-size:16px;line-height:normal;-webkit-font-smoothing:antialiased;text-align:left}' +
      '*{box-sizing:border-box}[hidden]{display:none!important}' +
      'a{color:' + p.ink + '}' +
      'button{font-family:inherit}' +
      'button:focus-visible,a:focus-visible,.chip input:focus-visible+span,.check input:focus-visible{outline:none;box-shadow:' + ring + '}' +
      '.chip input:focus-visible+span,.btn:focus-visible{border-color:' + p.brand + '}' +
      '[tabindex="-1"]:focus{outline:none}' +
      // launcher
      '.launch{position:fixed;bottom:24px;' + side + ':24px;z-index:2147483000;width:56px;height:56px;border-radius:' + (k ? '50%' : '14px') + ';background:' + p.brand + ';color:' + p.on + ';display:grid;place-items:center;box-shadow:0 8px 20px rgba(19,35,31,.25);border:0;padding:0;margin:0;cursor:pointer;transition:transform .15s ease}' +
      '.launch:hover{transform:scale(1.05)}.launch svg{width:24px;height:24px}' +
      '.launch:focus-visible{box-shadow:0 8px 20px rgba(19,35,31,.25),0 0 0 3px #fff,0 0 0 5px ' + p.brand + '}' +
      // panel
      '.w{position:fixed;' + side + ':24px;bottom:' + (launcher ? '96px' : '24px') + ';z-index:2147483000;width:368px;max-width:calc(100vw - 48px);' +
      'height:min(618px,calc(100vh - ' + (launcher ? '120px' : '48px') + '));background:#fff;border-radius:' + PANEL + ';box-shadow:0 18px 48px rgba(19,35,31,.22);overflow:hidden;display:flex;flex-direction:column;animation:ccmIn .18s ease-out}' +
      '@keyframes ccmIn{from{opacity:0;transform:translateY(8px)}}.w.still{animation:none}@media (prefers-reduced-motion:reduce){.w{animation:none}.launch{transition:none}}' +
      '.scr{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column}' +
      // close button: only where the launcher can't close (no launcher, or full screen on phones)
      '.x{display:' + (launcher ? 'none' : 'grid') + ';place-items:center;width:44px;height:44px;margin:-6px -10px -6px auto;border:0;border-radius:8px;background:transparent;color:inherit;padding:0;cursor:pointer;flex:none}' +
      '.x svg{width:20px;height:20px}.wh .x:focus-visible{box-shadow:0 0 0 2px ' + p.on + '}' +
      // Home
      '.wh{background:' + p.brand + ';color:' + p.on + ';padding:22px 20px 60px;display:flex;flex-direction:column;gap:12px;flex:none}' +
      '.wtop{display:flex;justify-content:space-between;align-items:center}' +
      '.lg{width:36px;height:36px;border-radius:8px;background:#fff;color:' + p.ink + ';display:grid;place-items:center;font-weight:700;flex:none;object-fit:contain}' +
      '.wh h2{margin:0;font-size:24px;font-weight:600;line-height:1.25;overflow-wrap:anywhere}' +
      '.wh p{margin:0;opacity:.92;font-size:14px;line-height:1.5;overflow-wrap:anywhere;white-space:pre-line}' +
      '.wb{margin-top:-40px;padding:0 14px 14px;display:flex;flex-direction:column;gap:10px;flex:1 0 auto}' +
      '.wc{background:#fff;border-radius:' + CARD + ';box-shadow:0 2px 10px rgba(19,35,31,.1);padding:14px 16px;display:flex;flex-direction:column;gap:6px;text-decoration:none;color:inherit}' +
      '.wc b{color:#13231F;font-size:14px;font-weight:600}.wc small{color:#5A6A65;font-size:13px;line-height:1.4}' +
      '.rowc{display:flex;justify-content:space-between;align-items:center;gap:10px}.rowc svg{width:18px;height:18px;color:#5A6A65;flex:none}' +
      '.wbtn{height:44px;width:100%;border-radius:' + BTN + ';background:' + p.brand + ';color:' + p.on + ';border:0;font-weight:600;font-size:14px;display:flex;align-items:center;justify-content:center;gap:8px;margin-top:6px;cursor:pointer;padding:0 12px}' +
      '.wbtn svg,.send svg{width:16px;height:16px;flex:none}.wbtn:hover,.send:hover{filter:brightness(.94)}' +
      '.foot{margin-top:auto;font-size:12px;color:#6B7672;text-align:center}' +
      '.foot>span{white-space:nowrap}.foot a{color:inherit;text-decoration:none}.foot a:hover{text-decoration:underline}' +
      // New / Sent bar
      '.bar{display:flex;align-items:center;gap:10px;padding:14px;border-bottom:1px solid #EDF0EF;flex:none;position:sticky;top:0;z-index:2;background:#fff}' +
      // New: Send + footer stay at the bottom while the fields scroll
      '.sf{position:sticky;bottom:0;z-index:2;margin:auto -16px -16px;padding:12px 16px 14px;background:#fff;border-top:1px solid #EDF0EF;display:flex;flex-direction:column;gap:10px}' +
      '.bk{width:44px;height:44px;margin:-6px;border-radius:8px;display:grid;place-items:center;color:#13231F;background:transparent;border:0;padding:0;cursor:pointer;flex:none}' +
      '.bk svg{width:18px;height:18px}.bk:hover,.x:hover{background:rgba(19,35,31,.06)}.wh .x:hover{background:rgba(255,255,255,.14)}' +
      '.bar h2{margin:0;font-size:15px;font-weight:700;color:#13231F;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar .x{color:#13231F}' +
      // New
      '.body{padding:16px;display:flex;flex-direction:column;gap:14px;flex:1 0 auto}' +
      '.lb{font-size:13px;font-weight:600;color:#13231F}' +
      '.grp{display:flex;flex-direction:column;gap:14px}' +
      '.chips{display:flex;gap:8px;flex-wrap:wrap}' +
      '.chip{position:relative;display:inline-flex}.chip input{position:absolute;opacity:0;width:1px;height:1px;margin:0}' +
      '.chip span{display:inline-flex;align-items:center;height:34px;padding:0 12px;border-radius:999px;border:1px solid #CFD8D5;background:#fff;font-weight:500;font-size:13px;color:#2E3D39;cursor:pointer;white-space:nowrap}' +
      '.chip span:hover{border-color:#9FB0AB}.chip input:checked+span{border-color:' + p.ink + ';background:' + p.tint + ';color:' + p.ink + '}' +
      '.ans{background:' + p.soft + ';border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;font-size:13px;color:#2E3D39;line-height:1.45;overflow-wrap:anywhere}' +
      '.ans a{font-weight:600;text-decoration:none}.ans a:hover{text-decoration:underline}' +
      '.who{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;color:#5A6A65;border:1px solid #EDF0EF;border-radius:10px;padding:10px 12px}' +
      '.who>span{min-width:0;overflow-wrap:anywhere}.who b{color:#13231F;font-weight:600}' +
      '.lnk{font-size:12px;color:' + p.ink + ';background:none;border:0;padding:4px 0;text-decoration:underline;cursor:pointer;flex:none;border-radius:3px}' +
      '.lnk.no{color:#B42318}.ask{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:1.4;color:#2E3D39}.ask span{display:flex;gap:14px}' +
      '.two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}' +
      '.fld{display:flex;flex-direction:column;gap:6px;min-width:0}' +
      '.in{height:42px;width:100%;border:1px solid #CFD8D5;border-radius:' + R + ';padding:0 12px;font-family:inherit;font-size:14px;color:#13231F;background:#fff;margin:0}' +
      '.in::placeholder{color:#727776;opacity:1}.in:focus{border-color:' + p.brand + ';outline:none;box-shadow:' + ring + '}' +
      'select.in{-webkit-appearance:none;appearance:none;padding-right:40px;cursor:pointer;background:#fff ' + CHEVRON + '}select.in.ph{color:#727776}select.in option{color:#13231F}' +
      'textarea.in{height:110px;padding:10px 12px;resize:none;line-height:1.5;border-radius:' + AREA + '}' +
      '.in[aria-invalid=true]{border-color:#B42318}' +
      '.hint{font-size:12px;color:#5F6B67}.em{font-size:12px;color:#B42318}' +
      '.check{display:flex;gap:10px;align-items:center;min-height:34px;font-size:13px;font-weight:500;color:#13231F}.check input{width:18px;height:18px;margin:0;flex:none;accent-color:' + p.brand + '}' +
      '.att{align-self:flex-start;background:none;border:0;padding:0;min-height:24px;font-size:13px;font-weight:600;color:' + p.ink + ';cursor:pointer;border-radius:3px}' +
      '.files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;font-size:13px;color:#3D4C47}' +
      '.files li{display:flex;align-items:center;gap:4px;min-width:0}.files li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.rm{flex:none;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:#5F6B67;font-size:18px;line-height:1;cursor:pointer}.rm:hover{background:#F1F4F3;color:#13231F}' +
      '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
      '.send{height:46px;width:100%;border-radius:' + BTN + ';background:' + p.brand + ';color:' + p.on + ';border:0;font-weight:600;font-size:14px;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer}' +
      '.send[aria-busy=true]{opacity:.75;cursor:progress}.send[data-preview]{cursor:default;filter:none}' +
      '.alert{margin:0;font-size:13px;color:#B42318}.alert:empty{display:none}' +
      '.ts{border:0;width:100%;height:70px;display:block;flex:none}.ts.inv{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}' +
      // Sent
      '.sent{padding:28px 20px;display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center;flex:1 0 auto}' +
      '.okc{width:56px;height:56px;border-radius:50%;background:' + p.tint + ';color:' + p.ink + ';display:grid;place-items:center;flex:none}.okc svg{width:26px;height:26px}' +
      '.sent h3{margin:0;font-size:20px;color:#13231F;font-weight:600;overflow-wrap:anywhere;white-space:pre-line}' +
      '.sent .foot,.body .foot{margin-top:0}' +
      '.sent p{margin:0;color:#3D4C47;font-size:14px;line-height:1.55}' +
      '.card{width:100%;border:1px solid #EDF0EF;border-radius:' + CARD + ';padding:14px;text-align:left;display:flex;flex-direction:column;gap:6px}' +
      '.card small{font-size:12px;color:#5A6A65}.card b{color:#13231F;font-size:14px;overflow-wrap:anywhere}' +
      '.tag{align-self:flex-start;height:22px;padding:0 8px;border-radius:4px;background:#F1F4F8;color:#4B5565;font-size:12px;font-weight:500;display:inline-flex;align-items:center}' +
      '.steps{width:100%;display:flex;flex-direction:column;gap:10px;text-align:left;list-style:none;margin:0;padding:0}' +
      '.st{display:flex;gap:10px;font-size:13px;color:#3D4C47;line-height:1.45;overflow-wrap:anywhere}' +
      '.st>span:first-child{width:22px;height:22px;border-radius:50%;background:' + p.soft + ';color:' + p.ink + ';display:grid;place-items:center;font-weight:600;font-size:12px;flex:none}' +
      '.btn{width:100%;height:44px;border-radius:' + BTN + ';border:1px solid #CFD8D5;background:#fff;color:#13231F;font-weight:600;font-size:14px;display:flex;align-items:center;justify-content:center;margin-top:auto;cursor:pointer}.btn:hover{border-color:#9FB0AB}' +
      '.slot{display:contents}.acts{width:100%;margin-top:auto;display:flex;flex-direction:column;gap:8px}.acts .btn,.acts .wbtn{margin-top:0}' +
      // unread: launcher dot, Home card, list rows (canvas #C2410C)
      '.dot{width:8px;height:8px;border-radius:50%;background:#C2410C;display:inline-block;flex:none}small .dot{margin-right:6px;vertical-align:1px}' +
      '.ldot{position:absolute;top:1px;right:1px;width:14px;height:14px;border-radius:50%;background:#C2410C;border:2px solid #fff}' +
      // Home: Your conversations card (a button)
      'button.wc{border:0;width:100%;text-align:left;font:inherit;cursor:pointer;margin:0}.wc small{overflow-wrap:anywhere}' +
      '.see{display:flex;align-items:center;gap:2px;font-size:12px;color:#5A6A65;flex:none;white-space:nowrap}' +
      // Conversations list (Widget-Conversations)
      '.thr{overflow:hidden}' +
      '.list{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:auto}' +
      '.it{display:flex;gap:12px;padding:14px 16px;border:0;border-bottom:1px solid #EDF0EF;background:#fff;width:100%;margin:0;text-align:left;font:inherit;color:inherit;align-items:flex-start;cursor:pointer;flex:none}' +
      '.it:hover{background:#FAFBFB}.it.unread{background:' + p.soft + '}.it .dot{margin-top:6px}' +
      '.ava{width:36px;height:36px;border-radius:50%;background:' + p.tint + ';color:' + p.ink + ';display:grid;place-items:center;font-weight:600;font-size:12px;flex:none}' +
      '.tx{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}' +
      '.r1{display:flex;justify-content:space-between;gap:8px}.r1 b{color:#13231F;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.r1 time{font-size:12px;color:#5A6A65;flex:none}' +
      '.pre{font-size:13px;color:#3D4C47;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.unread .pre{color:#13231F;font-weight:500}' +
      '.meta{display:flex;gap:6px;align-items:center;font-size:12px;color:#5A6A65;min-width:0}' +
      '.stc{height:20px;padding:0 7px;border-radius:4px;font-size:11px;font-weight:600;display:inline-flex;align-items:center;flex:none}.stc.open{background:' + p.tint + ';color:' + p.ink + '}.stc.done{background:#F1F4F8;color:#4B5565}' +
      '.empty{padding:28px 16px;font-size:13px;color:#5A6A65;text-align:center}' +
      '.lf{padding:12px 16px;display:flex;flex-direction:column;gap:10px;border-top:1px solid #EDF0EF;flex:none}.lf .wbtn{margin-top:0}' +
      '.fine2{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12px;color:#5A6A65}.fine2>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      // Thread (Widget-Thread): bubbles radius 14 with a 4px tail corner, composer with 40px buttons
      '.bar h2.ti{display:flex;flex-direction:column;flex:1 1 auto;white-space:normal}.ti span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ti small{font-size:12px;color:#5A6A65;font-weight:400}' +
      '.thr .bar{padding:12px 14px}.ti b{font-size:14px}' +
      '.msgs{flex:1 1 auto;min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:12px;background:#FAFBFB}' +
      '.day{align-self:center;font-size:11px;color:#5A6A65}' +
      '.m{max-width:82%;display:flex;flex-direction:column;gap:4px;min-width:0}' +
      '.m p{margin:0;padding:10px 12px;border-radius:14px;font-size:13.5px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}' +
      '.me{align-self:flex-end;align-items:flex-end}.me p{background:' + p.brand + ';color:' + p.on + ';border-bottom-right-radius:4px}' +
      '.them{align-self:flex-start;align-items:flex-start}.them p{background:#fff;color:#13231F;border:1px solid #E3E9E7;border-bottom-left-radius:4px}' +
      '.by{font-size:11px;color:#5A6A65;display:flex;gap:6px;align-items:center}.by .ava{width:20px;height:20px;font-size:9px}' +
      '.ev{align-self:center;font-size:11.5px;color:#5A6A65;background:#F1F4F8;border-radius:999px;padding:4px 10px;text-align:center}' +
      '.fc{display:inline-flex;align-items:center;gap:6px;max-width:100%;background:#fff;border:1px solid #E3E9E7;border-radius:8px;padding:6px 10px;font-family:inherit;font-size:11px;color:#13231F;cursor:pointer;margin:0}' +
      '.fc svg{width:13px;height:13px;flex:none;color:#5A6A65}.fc span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fc:hover{border-color:#9FB0AB}' +
      '.thr .files{padding:8px 14px 0;flex:none}.thr .alert{padding:8px 14px 0;flex:none}' +
      '.comp{border-top:1px solid #EDF0EF;padding:10px;display:flex;gap:8px;align-items:flex-end;flex:none;background:#fff;margin:0}' +
      '.cin{flex:1 1 auto;min-width:0;height:40px;min-height:40px;max-height:96px;border:1px solid #CFD8D5;border-radius:' + R + ';padding:9px 12px;font-family:inherit;font-size:13.5px;line-height:1.5;resize:none;color:#13231F;background:#fff;margin:0;display:block}' +
      '.cin::placeholder{color:#727776;opacity:1}.cin:focus{border-color:' + p.brand + ';outline:none;box-shadow:' + ring + '}' +
      '.sb{width:40px;height:40px;border-radius:' + BTN + ';background:' + p.brand + ';color:' + p.on + ';border:0;display:grid;place-items:center;flex:none;cursor:pointer;padding:0;margin:0}' +
      '.sb svg{width:18px;height:18px}.sb.att{background:#F3F7F6;color:#2E3D39}.sb:hover{filter:brightness(.94)}.sb[aria-busy=true]{opacity:.75;cursor:progress}' +
      // Loading: list rows from storage wait for their preview line and time; the thread shows bubble shapes.
      LOADING_CSS + '.skp{height:11px;width:75%;margin:3px 0}.skt{height:10px;width:34px;margin-top:3px;flex:none}' +
      '.skb{height:38px;width:160px;border-radius:14px}.them .skb{border-bottom-left-radius:4px}.me .skb{border-bottom-right-radius:4px}.skb.big{height:58px;width:220px}' +
      // Phones: the open panel takes the whole screen; the launcher steps aside, the panel's own X closes.
      (preview ? '' : '@media (max-width:480px){.w{left:0;right:0;top:0;bottom:0;width:auto;max-width:none;height:auto;border-radius:0}' +
        '.x{display:grid}.launch[aria-expanded=true]{display:none}.in,.cin{font-size:16px}}');
  }

  // ── the widget ────────────────────────────────────────────────────────────
  var cfg = null, root = null, launch = null, panel = null, screen = null, newView = null, opener = null, sentData = null;
  // convData: token → the last conversations answer for it (null = no answer yet). threadT: the open thread's token.
  var convData = null, threadT = null, view = null, timer = null, gen = 0;
  var api = window.CustomerCatalystMessenger = { version: '1', loaded: true, open: function () {}, close: function () {} };
  var pendingOpen = null; // open() called before the config arrived
  api.open = function (s) { pendingOpen = s === 'new' ? 'new' : 'home'; };

  function render() {
    var host = root ? null : h('div', { 'data-cc-messenger': '' });
    if (host) { document.body.appendChild(host); root = host.attachShadow({ mode: 'open' }); }
    var wasOpen = panel && !panel.hidden;
    var wrap = h('div', { 'class': 'r' });
    root.replaceChildren(h('style', {}, [css(cfg)]), wrap);
    panel = h('div', { 'class': wasOpen ? 'w still' : 'w', role: 'dialog', 'aria-label': (str(cfg.org_name) ? str(cfg.org_name) + ' ' : '') + 'support' });
    panel.hidden = true;
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    wrap.appendChild(panel);
    launch = null;
    if (m(cfg).launcher_shown !== false) {
      launch = h('button', { type: 'button', 'class': 'launch', 'aria-expanded': 'false' });
      launch.addEventListener('click', function () { if (panel.hidden) { opener = launch; open('home'); } else close(); });
      wrap.appendChild(launch);
    }
    newView = null;
    setOpen(!!wasOpen);
    if (wasOpen) go(screen || 'home', true);
  }
  function setOpen(on) {
    panel.hidden = !on;
    if (!launch) return;
    var dot = !on && convData && convList().some(unread);
    launch.setAttribute('aria-expanded', on ? 'true' : 'false');
    launch.setAttribute('aria-label', on ? 'Close messenger' : dot ? 'Open messenger, new reply' : 'Open messenger');
    launch.replaceChildren(icon(on ? 'close' : (m(cfg).icon || 'bubble')));
    if (dot) launch.appendChild(h('span', { 'class': 'ldot', 'aria-hidden': 'true' }));
  }
  // Unread state changed: the launcher dot, and the Home card if Home is showing.
  function marks() {
    if (!panel) return;
    setOpen(!panel.hidden);
    if (screen === 'home' && view && view.ccUpdate) view.ccUpdate();
  }

  // ── polling: only while the panel is open, on that screen, in a visible tab ──
  function live() { return !!panel && !panel.hidden && document.visibilityState !== 'hidden'; }
  function stop() { gen++; if (timer) { clearTimeout(timer); timer = null; } }
  function later(fn, ms) { var g = gen; timer = setTimeout(function () { timer = null; if (g === gen) fn(); }, ms); }
  // Ask for every conversation this browser holds; unknown or foreign tokens simply don't come back.
  function loadConvs(done) {
    var list = convs();
    if (!list.length) { convData = {}; if (done) done(); return; }
    answer(postJson('/v1/messenger/conversations', { key: key, tokens: list.map(function (c) { return c.t; }) })).then(function (res) {
      var b = res.b;
      if (b && b.success === true && Array.isArray(b.conversations)) {
        var map = {};
        b.conversations.forEach(function (c) { if (c && typeof c.index === 'number' && list[c.index]) map[list[c.index].t] = cleanConv(c); });
        convData = map;
      }
      if (done) done();
    });
  }
  function open(s) {
    if (!cfg) return;
    setOpen(true);
    go(s === 'new' ? 'new' : s === 'sent' && sentData ? 'sent' : 'home');
  }
  function close() {
    if (!cfg || panel.hidden) return;
    stop();
    setOpen(false);
    var back = opener && opener.isConnected !== false ? opener : launch;
    if (back && back.focus) back.focus();
  }

  function go(s, keepFocus) {
    stop();
    if (s === 'thread' && !threadT) s = 'home';
    screen = s;
    view = s === 'new' ? (newView = newView || buildNew()) : s === 'sent' ? buildSent() : s === 'list' ? buildList() : s === 'thread' ? buildThread() : buildHome();
    panel.replaceChildren(view);
    if (!keepFocus && view.ccTitle) view.ccTitle.focus();
    if (view.ccPoll && live()) view.ccPoll();
  }
  function openThread(t) { threadT = t; go('thread'); }
  // files_failed: the message went in, n of its files did not.
  function filesFailed(b) {
    var n = b && typeof b.files_failed === 'number' && b.files_failed > 0 ? Math.min(Math.floor(b.files_failed), 99) : 0;
    return n ? (n === 1 ? '1 file' : n + ' files') + ' could not be attached.' : '';
  }
  function closeBtn() {
    var x = h('button', { type: 'button', 'class': 'x', 'aria-label': 'Close messenger' }, [icon('close')]);
    x.addEventListener('click', close);
    return x;
  }
  // title: text, or [title, subline] (thread); back: the screen Back goes to.
  function bar(title, back) {
    var bk = h('button', { type: 'button', 'class': 'bk', 'aria-label': 'Back' }, [icon('back')]);
    bk.addEventListener('click', function () { go(back || 'home'); });
    var tb = Array.isArray(title) ? h('b', {}, [title[0]]) : null, ts = tb && h('small', {}, [title[1]]);
    var t = tb ? h('h2', { tabindex: '-1', 'class': 'ti' }, [h('span', {}, [tb]), h('span', {}, [ts])]) : h('h2', { tabindex: '-1' }, [title]);
    var b = h('div', { 'class': 'bar' }, [bk, t, closeBtn()]);
    b.ccTitle = t; b.ccLines = [tb, ts];
    return b;
  }
  function foot(parts, after) { return fineLine(parts.concat([poweredBy(), after]), 'foot'); }

  function buildHome() {
    var org = str(cfg.org_name), logo = safeUrl(cfg.logo_url);
    var newBtn = h('button', { type: 'button', 'class': 'wbtn' }, [icon('send'), text(cfg, 'new_button')]);
    newBtn.addEventListener('click', function () { go('new'); });
    var help = safeUrl(cfg.help_site_url), helpCard = null;
    if (help && (cfg.help_mode === 'link' || cfg.help_mode === 'first')) {
      helpCard = link(help, '', 'wc');
      helpCard.replaceChildren(h('span', { 'class': 'rowc' }, [
        h('span', {}, [h('b', {}, ['Help center']), h('br'), h('small', {}, ['Guides and answers at ' + new URL(help).hostname])]), icon('out')]));
    }
    // Your conversations: only when this browser holds one; refreshed in place when an answer lands.
    var slot = h('div', { 'class': 'slot' });
    function update() {
      var list = convList(), news = list.filter(unread)[0], last = list[0];
      if (!last) { slot.replaceChildren(); return; }
      var card = h('button', { type: 'button', 'class': 'wc' }, [h('span', { 'class': 'rowc' }, [
        h('span', {}, [h('b', {}, ['Your conversations']), h('br'),
          h('small', {}, news ? [h('span', { 'class': 'dot', 'aria-hidden': 'true' }), 'New reply on "' + (news.subject || news.label) + '"'] : [last.subject || last.label])]),
        h('span', { 'class': 'see' }, ['See all', icon('next')])])]);
      card.addEventListener('click', function () { go('list'); });
      slot.replaceChildren(card);
    }
    update();
    var t = h('h2', { tabindex: '-1' }, [text(cfg, 'title')]);
    var v = h('div', { 'class': 'scr' }, [
      h('div', { 'class': 'wh' }, [
        h('div', { 'class': 'wtop' }, [logo ? h('img', { 'class': 'lg', src: logo, alt: '' }) : h('span', { 'class': 'lg', 'aria-hidden': 'true' }, [org.charAt(0).toUpperCase() || '?']), closeBtn()]),
        t,
        h('p', {}, [text(cfg, 'greeting')])]),
      h('div', { 'class': 'wb' }, [
        h('div', { 'class': 'wc' }, [h('b', {}, [text(cfg, 'new_button')]), h('small', {}, [text(cfg, 'reply_time')]), newBtn]),
        slot,
        helpCard,
        foot([])])]);
    v.ccTitle = t; v.ccUpdate = update;
    return v;
  }

  // The visitor's picked files with a remove button each; onRemove runs after one is removed.
  function renderFiles(ul, files, onRemove) {
    ul.replaceChildren();
    files.forEach(function (f, i) {
      var rm = h('button', { type: 'button', 'class': 'rm', 'aria-label': 'Remove ' + f.name }, ['×']);
      rm.addEventListener('click', function () { files.splice(i, 1); renderFiles(ul, files, onRemove); onRemove(); });
      ul.appendChild(h('li', {}, [h('span', {}, [f.name + ' · ' + kb(f.size)]), rm]));
    });
  }

  function buildNew() {
    var rows = {}, files = [], busy = false, ts = null, picked = null;
    var invisible = cfg.turnstile_mode === 'invisible';
    var me = remembered();
    var form = h('form', { 'class': 'body', novalidate: '' });

    // A row: label (visible or, as in the canvas, the placeholder + an aria-label), control, error.
    function row(name, control, label, opts) {
      opts = opts || {};
      var id = uid + '-' + name, wrap = h('div', { 'class': 'fld' });
      control.setAttribute('id', id);
      if (opts.required) control.setAttribute('aria-required', 'true');
      if (control.getAttribute('type') === 'checkbox') wrap.appendChild(h('label', { 'class': 'check' }, [control, label]));
      else { control.setAttribute('aria-label', label); wrap.appendChild(control); }
      var hint = opts.hint ? h('span', { id: id + '-hint', 'class': 'hint' }, [opts.hint]) : null;
      if (hint) { wrap.appendChild(hint); control.setAttribute('aria-describedby', id + '-hint'); }
      var err = h('span', { id: id + '-err', 'class': 'em' }); err.hidden = true;
      wrap.appendChild(err);
      rows[name] = { controls: [control], err: err, hint: hint && id + '-hint' };
      return wrap;
    }
    function setError(name, msg) {
      var r = rows[name]; if (!r) return;
      r.err.textContent = msg || ''; r.err.hidden = !msg;
      r.controls.forEach(function (c) {
        var ids = [r.hint, msg ? r.err.getAttribute('id') : null].filter(Boolean).join(' ');
        if (msg) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid');
        if (ids) c.setAttribute('aria-describedby', ids); else c.removeAttribute('aria-describedby');
      });
    }
    var input = function (max, ph, type) { return h('input', { 'class': 'in', type: type || 'text', maxlength: String(max), placeholder: ph }); };

    var topics = validTopics(cfg);
    if (topics.length) {
      var answer = h('div', { 'class': 'ans', 'aria-live': 'polite' }); answer.hidden = true;
      var chips = h('div', { 'class': 'chips', role: 'radiogroup', 'aria-labelledby': uid + '-topic-lb', 'aria-required': 'true' });
      var radios = topics.map(function (t) {
        var rb = h('input', { type: 'radio', name: uid + '-topic', value: str(t.id) });
        rb.addEventListener('change', function () {
          picked = t; setError('topic', '');
          answer.replaceChildren();
          var art = safeUrl(t.article_url);
          if (str(t.short_text)) answer.appendChild(h('span', {}, [str(t.short_text)]));
          if (art) answer.appendChild(link(art, 'Read the article ↗'));
          answer.hidden = !(str(t.short_text) || art);
        });
        chips.appendChild(h('label', { 'class': 'chip' }, [rb, h('span', {}, [str(t.name)])]));
        return rb;
      });
      var terr = h('span', { id: uid + '-topic-err', 'class': 'em' }); terr.hidden = true;
      rows.topic = { controls: radios, err: terr };
      form.appendChild(h('div', { 'class': 'grp' }, [h('span', { 'class': 'lb', id: uid + '-topic-lb' }, ['What is it about?']), chips, answer, terr]));
    }

    // Who is writing: remembered after the first send ("Not you?" forgets), else two inputs.
    var name = input(LIMITS.name, 'Your name'), email = input(LIMITS.email, 'Your email', 'email');
    name.setAttribute('autocomplete', 'name'); email.setAttribute('autocomplete', 'email');
    var who = h('div', { 'class': 'two' }, [row('name', name, 'Your name', { required: true }), row('email', email, 'Your email', { required: true })]);
    if (me) {
      var notYou = h('button', { type: 'button', 'class': 'lnk' }, ['Not you?']);
      var lineKids = [h('span', {}, ['Writing as ', h('b', {}, [me.name]), ' · ' + me.email]), notYou];
      var line = h('div', { 'class': 'who' }, lineKids);
      notYou.addEventListener('click', function () {
        askForget(line, lineKids, function () {
          forget(); me = null;
          form.replaceChild(who, line);
          name.value = ''; email.value = ''; name.focus();
        });
      });
      form.appendChild(line);
    } else {
      if (str(settings.name)) name.value = capStr(str(settings.name), LIMITS.name);
      if (EMAIL_RE.test(str(settings.email))) email.value = capStr(str(settings.email), LIMITS.email);
      form.appendChild(who);
    }

    var subject = input(LIMITS.subject, 'Subject');
    form.appendChild(row('subject', subject, 'Subject', { required: true }));

    var extra = validFields(cfg);
    extra.forEach(function (f) {
      var c, kind = f.kind, label = str(f.label), ph = f.required ? label : label + ' (optional)';
      if (kind === 'long') c = h('textarea', { 'class': 'in', maxlength: String(LIMITS.long), rows: '3', placeholder: ph });
      else if (kind === 'checkbox') c = h('input', { type: 'checkbox' });
      else if (kind === 'list') {
        c = h('select', { 'class': 'in ph' }, [h('option', { value: '' }, [ph])]);
        (Array.isArray(f.options) ? f.options : []).forEach(function (o) { if (str(o)) c.appendChild(h('option', { value: str(o) }, [str(o)])); });
        c.addEventListener('change', function () { c.setAttribute('class', c.value ? 'in' : 'in ph'); });
      } else c = input(LIMITS.short, ph);
      form.appendChild(row('field_' + str(f.id), c, label, { required: !!f.required, hint: str(f.hint) }));
    });

    var message = h('textarea', { 'class': 'in', maxlength: String(LIMITS.message), rows: '5', placeholder: text(cfg, 'message_hint') });
    form.appendChild(row('message', message, 'Message', { required: true }));

    // Files: our own list so a visitor can add in several goes and remove one.
    var fileList = h('ul', { 'class': 'files' });
    if (cfg.files_on !== false) {
      var picker = filePicker();
      var add = h('button', { type: 'button', 'class': 'att', 'aria-describedby': uid + '-files-hint' }, ['+ Attach a file']);
      var ferr = h('span', { id: uid + '-files-err', 'class': 'em' }); ferr.hidden = true;
      add.addEventListener('click', function () { picker.click(); });
      picker.addEventListener('change', function () { var problem = takeFiles(files, picker.files); picker.value = ''; showFiles(); setError('files', problem); });
      form.appendChild(h('div', { 'class': 'fld' }, [add, h('span', { id: uid + '-files-hint', 'class': 'sr' }, [FILE_HINT]), fileList, ferr, picker]));
      rows.files = { controls: [add], err: ferr, hint: uid + '-files-hint' };
    }
    function showFiles() { renderFiles(fileList, files, function () { setError('files', ''); rows.files.controls[0].focus(); }); }

    var alert = h('p', { 'class': 'alert', role: 'alert' });
    var send = h('button', { type: 'submit', 'class': 'send' }, [icon('send'), 'Send']);
    form.appendChild(alert);
    if (preview) { send.disabled = true; send.setAttribute('data-preview', ''); }
    else {
      ts = turnstile(HOST, invisible, function (st) { if (st.token && alert.textContent === NOT_VERIFIED) alert.textContent = ''; });
      form.appendChild(ts.frame);
    }
    var privacy = invisible && safeUrl(cfg.privacy_url);
    // One 12px line fits 336px: "We'll reply by email · Powered by CustomerCatalyst" (managed: the visible
    // Turnstile widget right above carries Cloudflare's own mark), or "Powered by … · Privacy" (invisible).
    form.appendChild(h('div', { 'class': 'sf' }, [send, foot([invisible ? null : preview ? 'Preview: sending is off' : 'We\'ll reply by email'], privacy ? link(privacy, 'Privacy') : null)]));

    function validate() {
      var bad = [];
      function need(n, good, msg) { setError(n, good ? '' : msg); if (!good) bad.push(n); }
      if (rows.topic) need('topic', !!picked, 'Pick a topic.');
      if (!me) {
        need('name', str(name.value), 'Add your name.');
        need('email', EMAIL_RE.test(str(email.value)), str(email.value) ? 'Check the email address, like name@company.com.' : 'Add your email.');
      }
      need('subject', str(subject.value), 'Add a subject.');
      extra.forEach(function (f) {
        var c = rows['field_' + str(f.id)].controls[0];
        if (f.required) need('field_' + str(f.id), f.kind === 'checkbox' ? c.checked : str(c.value), 'This field is required.');
      });
      need('message', str(message.value), 'Write a message.');
      return bad;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (preview || busy) return;
      alert.textContent = '';
      var bad = validate();
      if (bad.length) { rows[bad[0]].controls[0].focus(); return; }
      if (!ts.token) {
        if (ts.error) { alert.textContent = NOT_VERIFIED; ts.reset(); }
        else alert.textContent = 'The security check is still running. Try again in a moment.';
        return;
      }
      var vName = me ? me.name : str(name.value), vEmail = me ? me.email : str(email.value);
      var fd = submissionData(['key', key], { name: vName, email: vEmail, topic: picked && str(picked.id),
        subject: str(subject.value), message: str(message.value) }, extra, rows, files, ts.token);
      busy = true; send.disabled = true; send.setAttribute('aria-busy', 'true'); send.replaceChildren(spinner(), 'Sending…');
      var finish = function () { busy = false; send.disabled = false; send.removeAttribute('aria-busy'); send.replaceChildren(icon('send'), 'Send'); ts.reset(); };
      postSubmission(HOST + '/v1/messenger/submit', fd, { rows: rows, setError: setError, alert: alert, finish: finish,
        closed: ['messenger_closed', 'Messages are switched off right now.'],
        done: function (b) {
          remember({ name: str(b.name) || vName, email: str(b.email) || vEmail });
          var token = typeof b.conversation_token === 'string' && TOKEN_RE.test(b.conversation_token) ? b.conversation_token : null;
          if (token) {
            addConv({ t: token, label: line1(b.ticket_id_label, 40), subject: line1(subject.value, LIMITS.subject), read_at: '' });
            convData = null; // the next answer includes it; until then the stored list shows
            loadConvs(marks);
          }
          // confirmation:false = no "we got it" mail goes out (e.g. an unproven address); missing = sent.
          sentData = { ticket: str(b.ticket_id_label), topic: picked ? str(picked.name) : '', subject: str(subject.value),
            email: str(b.email) || vEmail, copy: b.confirmation !== false, token: token, failed: filesFailed(b) };
          newView = null; // the next New starts empty, as the remembered visitor
          go('sent');
        } });
    });

    var top = bar('New conversation'), v = h('div', { 'class': 'scr' }, [top, form]);
    v.ccTitle = top.ccTitle;
    return v;
  }

  function buildSent() {
    var d = sentData || {};
    var again = h('button', { type: 'button', 'class': 'btn' }, ['Back to start']);
    again.addEventListener('click', function () { go('home'); });
    // A copy is promised only when the confirmation mail really goes out. With a conversation token
    // the answer also shows here (Widget-Sent).
    var lines = d.token ? (d.copy ? ['A copy is on its way to ' + d.email + '.'] : []).concat(['If you\'re still here when we answer, you\'ll see it in this window.',
      d.copy ? 'Otherwise the answer arrives by email. Reply to it, or come back here.' : 'Otherwise the answer arrives by email at ' + d.email + '. Reply to it, or come back here.'])
      : d.copy ? ['A copy is on its way to ' + d.email + '.', 'We\'ll answer by email. Just reply to it.']
        : ['We\'ll answer by email at ' + d.email + '. Just reply to it.'];
    var acts = again;
    if (d.token) {
      var openC = h('button', { type: 'button', 'class': 'wbtn' }, ['Open conversation']);
      openC.addEventListener('click', function () { openThread(d.token); });
      acts = h('div', { 'class': 'acts' }, [openC, again]);
    }
    var steps = h('ol', { 'class': 'steps' }, lines.map(function (t, i) {
      return h('li', { 'class': 'st' }, [h('span', { 'aria-hidden': 'true' }, [String(i + 1)]), h('span', {}, [t])]);
    }));
    var meta = [d.ticket, d.topic].filter(Boolean).join(' · ');
    var top = bar((str(cfg.org_name) ? str(cfg.org_name) + ' ' : '') + 'support');
    var v = h('div', { 'class': 'scr' }, [top,
      h('div', { 'class': 'sent', role: 'status' }, [
        h('span', { 'class': 'okc' }, [icon('check')]),
        h('h3', {}, [text(cfg, 'after_send')]),
        h('p', {}, [d.token ? 'We\'ll reply here and by email.' : 'We\'ll reply by email.']),
        d.failed ? h('p', { 'class': 'alert', role: 'alert' }, [d.failed]) : null,
        d.subject ? h('div', { 'class': 'card' }, [meta ? h('small', {}, [meta]) : null, h('b', {}, [d.subject]), h('span', { 'class': 'tag' }, ['Open'])]) : null,
        steps, acts, foot([])])]);
    v.ccTitle = top.ccTitle;
    return v;
  }

  // ── Your conversations (Widget-Conversations) ─────────────────────────────
  function buildList() {
    var top = bar('Your conversations');
    var list = h('div', { 'class': 'list' });
    function update() {
      // No answer yet: rows come from storage, with placeholders where the preview and time will go.
      var items = convList(), waiting = !convData, sk = function (c) { return h('span', { 'class': 'sk ' + c, 'aria-hidden': 'true' }); };
      list.replaceChildren();
      if (waiting) list.setAttribute('aria-busy', 'true'); else list.removeAttribute('aria-busy');
      if (!items.length) { list.appendChild(h('p', { 'class': 'empty' }, ['No conversations yet.'])); return; }
      var org = str(cfg.org_name).charAt(0).toUpperCase() || '?';
      items.forEach(function (c) {
        var news = unread(c), who = c.last_from === 'you' ? 'You: ' : c.last_author ? c.last_author + ': ' : '';
        var it = h('button', { type: 'button', 'class': news ? 'it unread' : 'it' }, [
          h('span', { 'class': 'ava', 'aria-hidden': 'true' }, [c.last_initials || org]),
          h('span', { 'class': 'tx' }, [
            h('span', { 'class': 'r1' }, [h('b', {}, [c.subject || c.label || 'Conversation']), waiting ? sk('skt') : h('time', {}, [ago(c.last_at)])]),
            waiting ? sk('skp') : c.last_kind === 'email' ? h('span', { 'class': 'pre' }, ['Replied by email']) : c.last_preview ? h('span', { 'class': 'pre' }, [who + c.last_preview]) : null,
            h('span', { 'class': 'meta' }, [c.status ? h('span', { 'class': c.status === 'open' ? 'stc open' : 'stc done' }, [STATUS[c.status]]) : null, c.label])]),
          news ? h('span', { 'class': 'dot', 'aria-hidden': 'true' }) : null,
          news ? h('span', { 'class': 'sr' }, [', new reply']) : null]);
        it.addEventListener('click', function () { openThread(c.t); });
        list.appendChild(it);
      });
    }
    update();
    var newBtn = h('button', { type: 'button', 'class': 'wbtn' }, [icon('send'), text(cfg, 'new_button')]);
    newBtn.addEventListener('click', function () { go('new'); });
    var me = remembered();
    var notYou = h('button', { type: 'button', 'class': 'lnk' }, ['Not you?']);
    var fineKids = [h('span', {}, [me ? me.email : '']), notYou], fine = h('div', { 'class': 'fine2' }, fineKids);
    notYou.addEventListener('click', function () { askForget(fine, fineKids, function () { forget(); newView = null; go('home'); }); });
    var v = h('div', { 'class': 'scr thr' }, [top, list, h('div', { 'class': 'lf' }, [newBtn, fine])]);
    v.ccTitle = top.ccTitle;
    v.ccPoll = function poll() { var g = gen; loadConvs(function () { if (g !== gen) return; update(); marks(); later(poll, 30000); }); };
    return v;
  }

  // ── one conversation (Widget-Thread) ──────────────────────────────────────
  function buildThread() {
    var t = threadT, stored = convs().filter(function (c) { return c.t === t; })[0] || {}, known = (convData && convData[t]) || {};
    var sub = function (k) { return [k.label, STATUS[k.status]].filter(Boolean).join(' · '); };
    var top = bar([known.subject || stored.subject || 'Conversation', sub(known.label ? known : stored)], 'list');
    // Bubble shapes until the first answer replaces them.
    var msgs = h('div', { 'class': 'msgs', role: 'log', 'aria-label': 'Messages', tabindex: '0', 'aria-busy': 'true' },
      [['them', 'sk skb big'], ['me', 'sk skb'], ['them', 'sk skb']].map(function (x) { return h('div', { 'class': 'm ' + x[0], 'aria-hidden': 'true' }, [h('span', { 'class': x[1] })]); }));
    var shown = {}, lastDay = null, any = false;
    var alert = h('p', { 'class': 'alert', role: 'alert' });

    function fileChip(f) {
      var b = h('button', { type: 'button', 'class': 'fc' }, [icon('down'), h('span', {}, [f.size ? f.name + ' · ' + kb(f.size) : f.name])]);
      b.addEventListener('click', function () {
        alert.textContent = '';
        fetch(HOST + '/v1/messenger/file', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key, token: t, file_id: f.id }) })
          .then(function (r) { if (!r.ok) throw new Error('refused'); return r.blob(); })
          .then(function (blob) {
            var u = URL.createObjectURL(blob);
            h('a', { href: u, download: f.name }).click();
            setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
          })
          .catch(function () { alert.textContent = 'Could not download ' + f.name + '. Try again.'; });
      });
      return b;
    }
    function node(x) {
      var at = when(x.at), time = at ? hm(at) : '';
      // A message that arrived by email never shows its text here (anyone can type an address).
      if (x.kind === 'email') return h('span', { 'class': 'ev' }, ['Replied by email' + (time ? ' · ' + time : '')]);
      var me = x.from === 'you';
      return h('div', { 'class': me ? 'm me' : 'm them' }, [x.text ? h('p', {}, [x.text]) : null].concat(x.files.map(fileChip), [
        h('span', { 'class': 'by' }, me ? [h('span', { 'class': 'sr' }, ['You, ']), time]
          : [h('span', { 'class': 'ava', 'aria-hidden': 'true' }, [x.initials || '?']), (x.author || 'Team') + (time ? ' · ' + time : '')])]));
    }
    function cleanMsg(x) {
      return { id: line1(x.id, 200), from: x.from === 'you' ? 'you' : 'team', kind: x.kind === 'email' ? 'email' : 'message', at: capStr(x.at, 40),
        text: capStr(x.text, LIMITS.message).replace(/\r\n?/g, '\n').trim(), author: line1(x.author, 60), initials: line1(x.initials, 3),
        files: (Array.isArray(x.files) ? x.files : []).filter(function (f) { return f && str(f.id) && str(f.name); })
          .map(function (f) { return { id: capStr(f.id, 500), name: line1(f.name, 200), size: typeof f.size === 'number' && f.size > 0 ? f.size : 0 }; }) };
    }
    function load(done) {
      var seen = live();
      answer(postJson('/v1/messenger/thread', { key: key, token: t, seen: seen })).then(function (res) {
        var b = res.b;
        if (threadT !== t || screen !== 'thread') return done();
        msgs.removeAttribute('aria-busy');
        if (!b || b.success !== true || !Array.isArray(b.messages)) {
          // Unknown, foreign or deleted: this browser forgets the token.
          if (res.status === 404 && b && b.error === 'not_found') { saveConvs(convs().filter(function (c) { return c.t !== t; })); if (convData) delete convData[t]; }
          if (!any) msgs.replaceChildren(h('p', { 'class': 'empty' }, [res.status === 0 ? 'Could not reach us. Check your connection.' : 'This conversation is not available.']));
          return done();
        }
        var k = b.ticket && typeof b.ticket === 'object' ? b.ticket : {};
        var info = { label: line1(k.label, 40), subject: line1(k.subject, LIMITS.subject), status: STATUS[k.status] ? k.status : 'open' };
        if (info.subject) top.ccLines[0].textContent = info.subject;
        top.ccLines[1].textContent = sub(info);
        if (convData && convData[t]) convData[t] = merge(convData[t], info);
        var nearEnd = !any || msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80, latest = '';
        if (!any) msgs.replaceChildren();
        b.messages.filter(function (x) { return x && typeof x === 'object'; }).map(cleanMsg).forEach(function (x) {
          if (newer(x.at, latest)) latest = x.at;
          if (!x.id || shown[x.id]) return;
          shown[x.id] = true; any = true;
          var at = when(x.at);
          if (at && at.toDateString() !== lastDay) { lastDay = at.toDateString(); msgs.appendChild(h('span', { 'class': 'day' }, [dayLabel(at)])); }
          msgs.appendChild(node(x));
        });
        if (!any) msgs.replaceChildren(h('p', { 'class': 'empty' }, ['No messages yet.']));
        if (nearEnd) msgs.scrollTop = msgs.scrollHeight;
        // Read up to the newest message only when the visitor could see it.
        if (seen && latest) { setRead(t, latest); marks(); }
        done();
      });
    }

    // composer: attach, auto-growing text, send (same file limits as New)
    var files = [], busy = false;
    var ta = h('textarea', { 'class': 'cin', rows: '1', maxlength: String(LIMITS.message), placeholder: 'Write a reply…', 'aria-label': 'Write a reply' });
    function grow() { if (!ta.style) return; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 96) + 'px'; }
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    var fileList = h('ul', { 'class': 'files' }), picker = null, attach = null;
    var showFiles = function () { renderFiles(fileList, files, function () { alert.textContent = ''; attach.focus(); }); };
    if (cfg.files_on !== false) {
      picker = filePicker();
      attach = h('button', { type: 'button', 'class': 'sb att', 'aria-label': 'Attach a file', 'aria-describedby': uid + '-rfiles-hint' }, [icon('clip')]);
      attach.addEventListener('click', function () { picker.click(); });
      picker.addEventListener('change', function () { var problem = takeFiles(files, picker.files); picker.value = ''; showFiles(); alert.textContent = problem; });
    }
    var sendBtn = h('button', { type: 'submit', 'class': 'sb', 'aria-label': 'Send' }, [icon('send')]);
    var comp = h('form', { 'class': 'comp', novalidate: '' }, [attach, h('span', { id: uid + '-rfiles-hint', 'class': 'sr' }, [FILE_HINT]), ta, sendBtn, picker]);
    comp.addEventListener('submit', function (e) { e.preventDefault(); send(); });
    function send() {
      if (busy) return;
      alert.textContent = '';
      var msg = str(ta.value);
      if (!msg) { alert.textContent = 'Write a message.'; ta.focus(); return; }
      var fd = new FormData();
      fd.append('key', key); fd.append('token', t); fd.append('message', msg);
      files.forEach(function (f) { fd.append('files', f, f.name); });
      busy = true; sendBtn.disabled = true; sendBtn.setAttribute('aria-busy', 'true'); sendBtn.replaceChildren(spinner());
      answer(fetch(HOST + '/v1/messenger/reply', { method: 'POST', body: fd, credentials: 'omit' })).then(function (res) {
        busy = false; sendBtn.disabled = false; sendBtn.removeAttribute('aria-busy'); sendBtn.replaceChildren(icon('send'));
        var b = res.b;
        if (!res.status) { alert.textContent = 'Could not reach us. Check your connection and try again.'; return; }
        if (!b || b.success !== true) {
          // Gone (merged, deleted): forget the token, as the thread load does.
          if (res.status === 404 && b && b.error === 'not_found') { saveConvs(convs().filter(function (c) { return c.t !== t; })); if (convData) delete convData[t]; }
          var errs = b && b.errors && typeof b.errors === 'object' ? b.errors : {};
          alert.textContent = typeof errs.message === 'string' ? errs.message : typeof errs.files === 'string' ? errs.files
            : submitErrorText(b, res.status, 'messenger_closed', 'Messages are switched off right now.');
          return;
        }
        ta.value = ''; files.length = 0; showFiles(); grow();
        var note = filesFailed(b), label = line1(b.ticket_id_label, 40);
        if (label) {
          // A closed ticket got a follow-up: the SAME token now points at it. New label, list refreshed,
          // thread shown again from the follow-up.
          var cur = convs().filter(function (c) { return c.t === t; })[0] || { t: t, subject: stored.subject || known.subject || '', read_at: '' };
          cur.label = label;
          addConv(cur);
          convData = null; loadConvs(marks);
          if (screen === 'thread' && threadT === t) { go('thread', true); view.ccComposer.focus(); view.ccAlert.textContent = note; }
          return;
        }
        alert.textContent = note;
        if (screen === 'thread' && threadT === t) { stop(); if (live()) v.ccPoll(); }
      });
    }

    var v = h('div', { 'class': 'scr thr' }, [top, msgs, fileList, alert, comp]);
    v.ccTitle = top.ccTitle; v.ccComposer = ta; v.ccAlert = alert;
    v.ccPoll = function poll() { var g = gen; load(function () { if (g === gen && live()) later(poll, 10000); }); };
    return v;
  }

  // ── start ─────────────────────────────────────────────────────────────────
  function ready(c) {
    cfg = c;
    render();
    api.open = function (s) { opener = document.activeElement; open(s); };
    api.close = close;
    if (pendingOpen) open(pendingOpen);
    // One look at load for the launcher's unread dot; no timers while the panel is closed.
    if (convs().length) loadConvs(marks);
  }

  function start() {
    if (preview) {
      // Settings preview: defaults, open on Home, until the settings page sends values.
      ready({ enabled: true });
      open('home');
      listenPreview(previewParents(script), 'cc-messenger-preview', function (d) {
        cfg = mergeM(cfg, cleanM(d.config));
        render();
      });
      return;
    }
    // Org buttons, also ones added later: one listener on the page.
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-ccm-open]') : null;
      if (!el || !cfg) return;
      e.preventDefault();
      opener = el;
      open(el.getAttribute('data-ccm-open'));
    });
    // Hidden tab: every timer stops; back to visible: the open screen refreshes at once.
    document.addEventListener('visibilitychange', function () {
      stop();
      if (live() && view && view.ccPoll) view.ccPoll();
    });
    fetch(HOST + '/v1/messenger/config?key=' + encodeURIComponent(key), { credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .catch(function () { return null; })
      .then(function (res) {
        var c = res && res.success === true && res.config && typeof res.config === 'object' ? cleanM(res.config) : null;
        if (!c || c.enabled !== true) return; // off or refused: nothing on the page
        ready(c);
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
