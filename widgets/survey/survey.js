/*
 * NPS survey response page (/s/<token>) and its unsubscribe page (/s/<token>/unsubscribe).
 * Served as /v1/survey.js inside the kit closure (worker widgetJs). The Worker renders the page
 * with the survey's display fields in <script type="application/json" id="cc-survey-data">;
 * nothing from it is ever parsed as HTML (textContent only).
 * Contract: customercatalyst-dev docs/scopes/nps-survey.md §5, supabase/functions/surveys.
 */
var DATA = (function () {
  try { return JSON.parse(document.getElementById('cc-survey-data').textContent) || {}; } catch (e) { return {}; }
})();
var S = DATA.survey && typeof DATA.survey === 'object' ? DATA.survey : {};
var P = palette(S.color);
var ROOT = document.getElementById('cc-survey');
var ORG = capStr(S.org_name, 200).trim();

var FONT = 'Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
var CSS = LOADING_CSS +
  '*{box-sizing:border-box}' +
  'body{margin:0;background:#F3F5F4;font-family:' + FONT + ';color:#13231F;-webkit-font-smoothing:antialiased}' +
  '.wrap{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 16px 24px}' +
  '.card{width:100%;max-width:600px;background:#fff;border:1px solid #E3E8E6;border-radius:14px;padding:28px;box-shadow:0 1px 2px rgba(19,35,31,.04),0 8px 24px rgba(19,35,31,.06)}' +
  '.org{display:flex;align-items:center;gap:12px;margin:0 0 24px;min-height:36px}' +
  '.org img{max-height:36px;max-width:160px;object-fit:contain}' +
  '.mono{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex:none}' +
  '.org span{font-size:15px;font-weight:600;color:#13231F;overflow-wrap:anywhere}' +
  'h1{font-size:20px;line-height:1.4;font-weight:600;margin:0 0 20px;overflow-wrap:anywhere}' +
  'p{font-size:15px;line-height:1.6;color:#3D4C47;margin:0 0 16px;white-space:pre-line;overflow-wrap:anywhere}' +
  '.scale{display:grid;grid-template-columns:repeat(11,1fr);gap:6px}' +
  '.scale button{height:44px;min-width:0;border:1px solid #CFD8D5;border-radius:10px;background:#fff;color:#13231F;font:600 15px/1 ' + FONT + ';cursor:pointer;transition:background .12s,border-color .12s,color .12s}' +
  '.scale button:hover{border-color:' + P.brand + ';background:' + P.soft + '}' +
  '.scale button[aria-pressed="true"]{background:' + P.brand + ';border-color:' + P.brand + ';color:' + P.on + '}' +
  'button:focus-visible,textarea:focus{outline:none;border-color:' + P.brand + ';box-shadow:0 0 0 3px ' + P.ring + '}' +
  '.ends{display:flex;justify-content:space-between;gap:12px;margin:8px 0 0;font-size:12px;color:#5F6B67}' +
  '.step{margin-top:28px}' +
  'label{display:block;font-size:13px;font-weight:600;margin:0 0 8px;overflow-wrap:anywhere}' +
  'textarea{display:block;width:100%;min-height:120px;resize:vertical;padding:12px 14px;border:1px solid #CFD8D5;border-radius:10px;font:15px/1.5 ' + FONT + ';color:#13231F;background:#fff}' +
  'textarea::placeholder{color:#727776}' +
  '.row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}' +
  '.go{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 22px;border:1px solid ' + P.brand + ';border-radius:10px;background:' + P.brand + ';color:' + P.on + ';font:600 15px/1 ' + FONT + ';cursor:pointer}' +
  '.go[disabled]{opacity:.7;cursor:default}' +
  '.note{font-size:13px;color:#5F6B67;min-height:18px}' +
  '.note.err{color:#B42318}' +
  '.fine{margin-top:20px;font-size:12px;color:#5F6B67;text-align:center}' +
  '.fine a{color:inherit;text-decoration:none}.fine a:hover{text-decoration:underline}' +
  '@media (max-width:520px){.wrap{padding:24px 12px 20px}.card{padding:20px}.scale{grid-template-columns:repeat(6,1fr)}h1{font-size:18px}' +
  '.row{flex-direction:column-reverse;align-items:stretch}.go{width:100%}}';

document.head.appendChild(h('style', {}, [CSS]));

function monogram() {
  return h('div', { 'class': 'mono', 'aria-hidden': 'true', style: 'background:' + P.brand + ';color:' + P.on }, [ORG.charAt(0).toUpperCase()]);
}
function header() {
  // Only our own /s/<token>/logo (the Worker serves the private file's bytes); a failed load → monogram.
  var logo = /^\/s\/[A-Za-z0-9_-]{32,128}\/logo$/.test(str(S.logo_url)) ? S.logo_url : '';
  var kids = [];
  if (logo) {
    var img = h('img', { src: logo, alt: '' });
    img.addEventListener('error', function () { if (ORG) img.replaceWith(monogram()); else img.remove(); });
    kids.push(img);
  } else if (ORG) kids.push(monogram());
  if (ORG) kids.push(h('span', {}, [ORG]));
  return kids.length ? h('div', { 'class': 'org' }, kids) : null;
}
function show(kids) {
  var card = h('div', { 'class': 'card' }, kids);
  ROOT.textContent = '';
  ROOT.appendChild(h('div', { 'class': 'wrap' }, [card, fineLine([poweredBy()])]));
  return card;
}
function message(title, body, withOrg) {
  show([withOrg ? header() : null, h('h1', {}, [title]), body ? h('p', {}, [body]) : null]);
}

// POST JSON to our own Worker; resolves { ok, status, b }.
function post(path, body) {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
    .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return { ok: r.ok && !!(b && b.success), status: r.status, b: b }; }); },
      function () { return { ok: false, status: 0, b: null }; });
}
function failText(res) {
  return res.status === 409 ? 'This survey is closed.'
    : res.status === 429 ? 'Too many tries. Wait a minute and try again.'
      : res.status === 0 ? 'Could not reach us. Check your connection and try again.'
        : 'We couldn\'t save your answer. Please try again.';
}

function answerPage() {
  var token = DATA.token;
  var picked = Number.isInteger(S.score) ? S.score : null;
  var fromLink = new URL(location.href).searchParams.get('score');
  var linkScore = /^(10|[0-9])$/.test(fromLink || '') ? Number(fromLink) : null;
  // A reload must not re-send an old score over one changed on the page.
  if (fromLink !== null) history.replaceState(null, '', location.pathname);

  var qId = 'cc-q';
  var buttons = [];
  var scale = h('div', { 'class': 'scale', role: 'group', 'aria-labelledby': qId });
  for (var i = 0; i <= 10; i++) {
    (function (n) {
      var b = h('button', { type: 'button', 'aria-pressed': 'false', 'aria-label': n + (n === 0 ? ', not at all likely' : n === 10 ? ', extremely likely' : '') }, [String(n)]);
      b.addEventListener('click', function () { pick(n, true); });
      buttons.push(b);
      scale.appendChild(b);
    })(i);
  }
  var note = h('div', { 'class': 'note', role: 'status', 'aria-live': 'polite' });
  var cId = 'cc-comment';
  var comment = h('textarea', { id: cId, maxlength: '2000', placeholder: 'Tell us a bit more (optional)' });
  comment.value = capStr(S.comment, 2000);
  var go = h('button', { type: 'button', 'class': 'go' }, ['Submit']);
  var step = h('div', { 'class': 'step' }, [
    h('label', { 'for': cId }, [str(S.comment_question) || 'What is the main reason for your score?']),
    comment,
    h('div', { 'class': 'row' }, [note, go]),
  ]);
  step.hidden = true;

  show([
    header(),
    h('h1', { id: qId }, [str(S.question) || 'How likely are you to recommend ' + (ORG || 'us') + ' to a friend or colleague?']),
    scale,
    h('div', { 'class': 'ends', 'aria-hidden': 'true' }, [h('span', {}, ['Not at all likely']), h('span', {}, ['Extremely likely'])]),
    step,
  ]);

  var seq = 0;
  function pick(n, save) {
    picked = n;
    buttons.forEach(function (b, j) { b.setAttribute('aria-pressed', j === n ? 'true' : 'false'); });
    step.hidden = false;
    if (!save) return;
    // Saved at once (the email click, or a change here); the comment comes with Submit.
    var mine = ++seq;
    note.className = 'note';
    note.textContent = 'Saving…';
    post('/v1/survey/answer', { token: token, score: n }).then(function (res) {
      if (mine !== seq) return;
      note.className = res.ok ? 'note' : 'note err';
      note.textContent = res.ok ? 'Your score is saved.' : failText(res);
    });
  }

  go.addEventListener('click', function () {
    if (picked === null) { note.className = 'note err'; note.textContent = 'Choose a score first.'; return; }
    go.disabled = true;
    go.textContent = '';
    go.appendChild(spinner());
    go.appendChild(document.createTextNode('Sending'));
    seq++;
    note.textContent = '';
    post('/v1/survey/answer', { token: token, score: picked, comment: comment.value.slice(0, 2000) }).then(function (res) {
      go.disabled = false;
      go.textContent = 'Submit';
      if (!res.ok) { note.className = 'note err'; note.textContent = failText(res); return; }
      message(str(S.thank_you_title) || 'Thank you!', str(S.thank_you_body), true);
    });
  });

  if (linkScore !== null) {
    // Shown at once, saved only after the page has been visible for 1.5 s: mail link scanners
    // open the link (some run scripts) but are never "visible" that long. A click saves at once.
    pick(linkScore, false);
    var timer = null;
    var arm = function () {
      clearTimeout(timer);
      timer = null;
      if (document.visibilityState === 'visible') timer = setTimeout(function () { if (seq === 0) pick(linkScore, true); }, 1500);
    };
    document.addEventListener('visibilitychange', arm);
    arm();
  } else if (picked !== null) pick(picked, false);
}

function unsubscribePage() {
  var note = h('div', { 'class': 'note', role: 'status', 'aria-live': 'polite' });
  var go = h('button', { type: 'button', 'class': 'go' }, ['Unsubscribe']);
  show([
    header(),
    h('h1', {}, ['Unsubscribe from surveys']),
    h('p', {}, ['You will no longer receive feedback surveys from ' + (ORG || 'this organization') + '.']),
    h('div', { 'class': 'row' }, [note, go]),
  ]);
  go.addEventListener('click', function () {
    go.disabled = true;
    go.textContent = '';
    go.appendChild(spinner());
    go.appendChild(document.createTextNode('Unsubscribing'));
    post('/v1/survey/unsubscribe', { token: DATA.token }).then(function (res) {
      if (res.ok) return message('You\'re unsubscribed', 'You won\'t receive surveys from ' + (str(res.b.org_name) || ORG || 'this organization') + ' anymore.', true);
      go.disabled = false;
      go.textContent = 'Unsubscribe';
      note.className = 'note err';
      note.textContent = res.status === 429 ? 'Too many tries. Wait a minute and try again.' : 'Something went wrong. Please try again.';
    });
  });
}

if (DATA.state === 'invalid') message('This link is not valid', 'Check that you opened the whole link from the email.', false);
else if (DATA.state !== 'ok') message('Something went wrong', 'Please try again in a moment.', false);
else if (DATA.mode === 'unsubscribe') unsubscribePage();
else if (S.answered === true) message('You\'ve already answered — thank you', str(S.thank_you_body), true);
else if (S.open !== true) message('This survey is closed', 'Thank you for your interest.', true);
else answerPage();
