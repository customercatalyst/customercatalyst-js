/*!
 * CustomerCatalyst support form widget. No dependencies, loaded on customers' pages.
 *   <script src="<host>/v1/form.js" data-key="pk_…" data-target="#cc-support-form" async></script>
 *   <script src="<host>/v1/form.js" data-key="pk_…" data-open="#my-button" async></script>
 * Hosted page (/f/<slug>) uses data-slug + data-mode="hosted"; data-preview="1" disables Send.
 * Separate from the tracking SDK: only global is CustomerCatalystForm. Stores nothing in the
 * browser (no visitor name/email kept; the ccm_ prefix is reserved for Messenger).
 * All org and visitor text goes in with textContent; links only http(s).
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || !script.src) return;
  var HOST = new URL(script.src).origin;
  if (!window.CustomerCatalystForm) window.CustomerCatalystForm = { version: '1' };

  // Mirrors the messenger function (and _shared/attachments.ts ATTACHMENT_MIME);
  // change both together. The server checks again; this only saves a wasted upload.
  var LIMITS = { fileBytes: 10 * 1024 * 1024, files: 10, totalBytes: 25 * 1024 * 1024,
    name: 200, email: 254, subject: 200, message: 20000, short: 500, long: 5000 };
  var KINDS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt'];
  var KEY_RE = /^pk_[A-Za-z0-9]{16,64}$/;
  var SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  var attr = function (n) { return script.getAttribute(n); };
  var key = attr('data-key'), slug = attr('data-slug');
  var hosted = attr('data-mode') === 'hosted';
  var preview = attr('data-preview') === '1';
  // /v1/preview runs with neither (nothing saved yet): it waits for the settings page's messages.
  if (key ? !KEY_RE.test(key) : slug ? !SLUG_RE.test(slug) : !preview) return;
  var uid = 'ccf' + Math.random().toString(36).slice(2, 8);

  // ── small helpers ─────────────────────────────────────────────────────────
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    for (var k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function str(v) { return typeof v === 'string' ? v.trim() : ''; }
  function safeUrl(u) {
    u = str(u);
    if (u.indexOf('//') === 0) u = 'https:' + u; // Bubble file URLs are protocol-relative
    try { var x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch (e) { return null; }
  }
  function link(href, label, cls) {
    return h('a', { href: href, target: '_blank', rel: 'noopener noreferrer', 'class': cls }, [label]);
  }
  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  // The app's placeholder style (*XYZ*, as in the ticket templates). Result goes in as text only.
  function fill(t, vals) {
    return t.split('*REQUESTER_NAME*').join(vals.name).split('*TICKET_NUMBER*').join(vals.ticket).split('*REQUESTER_EMAIL*').join(vals.email);
  }

  // Colours: the org's colour on buttons, a darkened copy for text, so both stay at 4.5:1.
  function rgb(hex) { return [1, 3, 5].map(function (i) { return parseInt(hex.slice(i, i + 2), 16); }); }
  function hex(c) { return '#' + c.map(function (v) { return ('0' + Math.round(v).toString(16)).slice(-2); }).join(''); }
  function lum(c) {
    c = c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  // Text/icon on anything filled with the org colour: white or near-black, whichever contrasts more.
  function onColor(c) { return contrast(c, [255, 255, 255]) >= contrast(c, [19, 35, 31]) ? '#ffffff' : '#13231F'; }
  function mix(c, d, t) { return c.map(function (v, i) { return v + (d[i] - v) * t; }); }
  function palette(color) {
    var c = /^#[0-9a-f]{6}$/i.test(str(color)) ? str(color) : /^#[0-9a-f]{3}$/i.test(str(color)) ? '#' + str(color).slice(1).replace(/./g, '$&$&') : '#0E6B5C';
    var brand = rgb(c), white = [255, 255, 255];
    var tint = mix(white, brand, 0.1), soft = mix(white, brand, 0.05), ink = brand;
    for (var i = 0; i < 20 && contrast(ink, tint) < 4.5; i++) ink = mix(ink, [0, 0, 0], 0.12);
    return { brand: hex(brand), on: onColor(brand), ink: hex(ink), tint: hex(tint), soft: hex(soft), ring: 'rgba(' + brand.join(',') + ',.15)' };
  }

  // Values follow the owner's designs (Form-Embedded / Form-Hosted), except field/chip borders
  // placeholders (#727776, 4.5:1 on white). Field borders stay the design's light #CFD8D5 (owner's
  // call). Focus (owner: subtle): 1px border in the org colour + a soft 3px ring at 15%. Corners scale
  // inputs, buttons and boxes; chips are always pills.
  function css(cfg) {
    var p = palette(cfg.color), k = cfg.corners === 'square' ? 0 : cfg.corners === 'pill' ? 2 : 1;
    var R = ['4px', '10px', '22px'][k], CARD = ['4px', '14px', '20px'][k], BOX = ['4px', '10px', '14px'][k];
    var AREA = ['4px', '10px', '18px'][k], SEND = ['4px', '10px', '999px'][k];
    var font = cfg.font === 'inter' ? 'Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif' : 'inherit';
    // ponytail: Inter is used when installed, not downloaded (no third-party font
    // request from customers' pages). Self-host it from the Worker if owners ask.
    return ':host{all:initial;display:block;font-family:' + font + ';color:#13231F;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}' +
      '*{box-sizing:border-box}[hidden]{display:none!important}' +
      'a{color:' + p.ink + '}' +
      '.f{background:#fff;border:1px solid #E3DED3;border-radius:' + CARD + ';padding:28px;display:flex;flex-direction:column;gap:16px;text-align:left}' +
      '.t{margin:0;font-size:26px;font-weight:600;line-height:1.2;letter-spacing:-.01em;color:#13231F;outline:none}' +
      'p{margin:0;color:#3D4C47;line-height:1.55}' +
      '.help,.ans{background:' + p.soft + ';border-radius:' + BOX + ';padding:11px 14px;font-size:14px;line-height:1.5;color:#2E3D39}' +
      '.ans a,.help a{white-space:nowrap}' +
      '.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px}' +
      '.fld{display:flex;flex-direction:column;gap:6px;min-width:0;border:0;margin:0;padding:0}' +
      'fieldset.fld{gap:10px}legend{padding:0;margin:0 0 10px}' +
      'label,.lb{font-size:13px;font-weight:600;color:#13231F}' +
      '.req{color:#B42318}.hint{font-size:12px;color:#5F6B67}.em{font-size:12.5px;color:#B42318}' +
      '.in{height:44px;width:100%;border:1px solid #CFD8D5;border-radius:' + R + ';padding:0 12px;font:inherit;font-size:15px;color:#13231F;background:#fff;margin:0}' +
      '.in::placeholder{color:#727776}.in:focus{border-color:' + p.brand + ';outline:none;box-shadow:0 0 0 3px ' + p.ring + '}' +
      // Own chevron, 13px in from the right; text never runs under it.
      'select.in{-webkit-appearance:none;appearance:none;padding-right:40px;cursor:pointer;background:#fff url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath d=%27M1 1.5l5 5 5-5%27 fill=%27none%27 stroke=%27%235F6B67%27 stroke-width=%271.6%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E") no-repeat right 13px center}' +
      'textarea.in{height:130px;padding:10px 12px;resize:vertical;line-height:1.5;border-radius:' + AREA + '}' +
      '.in[aria-invalid=true]{border-color:#B42318}' +
      'button:focus-visible,a:focus-visible,.chip input:focus-visible+span,.check input:focus-visible{outline:none;box-shadow:0 0 0 3px ' + p.ring + '}' +
      '.chip input:focus-visible+span,.cbtn:focus-visible,.btn:focus-visible{border-color:' + p.brand + '}a:focus-visible{border-radius:3px}' +
      '.chips{display:flex;gap:8px;flex-wrap:wrap}' +
      '.chip{position:relative;display:inline-flex}.chip input{position:absolute;opacity:0;width:1px;height:1px;margin:0}' +
      '.chip span,.cbtn{display:inline-flex;align-items:center;height:36px;padding:0 14px;border-radius:999px;border:1px solid #CFD8D5;background:#fff;font:inherit;font-weight:500;font-size:14px;color:#2E3D39;cursor:pointer;white-space:nowrap}' +
      '.chip input:checked+span{border-color:' + p.ink + ';background:' + p.tint + ';color:' + p.ink + '}' +
      '.chip span:hover,.cbtn:hover{border-color:#9FB0AB}' +
      '.check{display:flex;gap:10px;align-items:center;min-height:36px;font-weight:500;font-size:14px}.check input{width:18px;height:18px;margin:0;accent-color:' + p.brand + '}' +
      '.drop{border:1.5px dashed #CFD8D5;border-radius:' + BOX + ';padding:14px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;font-size:14px;color:#3D4C47}' +
      '.files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 180px}' +
      '.files li{display:flex;align-items:center;gap:4px;min-width:0}.files li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.empty{color:#5F6B67}' +
      '.rm{flex:none;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:#5F6B67;font-size:18px;line-height:1;cursor:pointer}.rm:hover{background:#F1F4F3;color:#13231F}' +
      '.send{height:48px;width:100%;border-radius:' + SEND + ';background:' + p.brand + ';color:' + p.on + ';border:0;font:inherit;font-weight:600;font-size:15px;cursor:pointer;margin-top:4px}' +
      '.send:hover{filter:brightness(.94)}.send[aria-busy=true]{opacity:.75;cursor:progress}' +
      '.send[data-preview]{cursor:default;filter:none}' +
      '.sendrow{display:flex;flex-direction:column;gap:6px}.note{font-size:12px;color:#5F6B67;text-align:center}.alert{font-size:14px;color:#B42318}.alert:empty{display:none}' +
      // One centred line; it may only break between the parts (at the dot), never inside one.
      '.fine{text-align:center;font-size:12px;line-height:1.6;color:#5F6B67}.fine>span{white-space:nowrap}' +
      '.fine a{color:inherit;text-decoration:none}.fine a:hover{text-decoration:underline}' +
      '.ts{border:0;width:100%;height:70px;display:block}.ts.inv{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}' +
      '.done{padding:36px 32px;align-items:center;text-align:center}.done .t{font-size:24px}.done p{font-size:15px;line-height:1.6}' +
      '.ok{width:60px;height:60px;border-radius:50%;background:' + p.tint + ';color:' + p.ink + ';display:grid;place-items:center;font-size:28px;font-weight:700;line-height:1}' +
      '.pill{display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:999px;background:#F1F4F8;color:#13231F;font-weight:600;font-size:13px}' +
      '.sum{width:100%;border:1px solid #EDF0EF;border-radius:12px;text-align:left;display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px 14px;padding:16px;margin:0;font-size:14px}' +
      '.sum dt{color:#5F6B67}.sum dd{margin:0;color:#13231F;white-space:pre-wrap;overflow-wrap:anywhere;max-height:12em;overflow:auto}' +
      '.acts{display:flex;gap:12px;flex-wrap:wrap;justify-content:center}' +
      '.btn{height:44px;padding:0 18px;border-radius:' + R.replace('22px', '999px') + ';border:1px solid #CFD8D5;background:#fff;color:#13231F;font:inherit;font-weight:600;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;text-decoration:none}' +
      '.btn.primary{background:' + p.brand + ';color:' + p.on + ';border-color:' + p.brand + '}' +
      '.page{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:0 16px 48px;background:#F3F5F4}' +
      '.hd{display:flex;align-items:center;gap:12px;padding:40px 0 28px;max-width:560px}' +
      '.hd b{display:block;font-size:18px;color:#13231F}.hd small{display:block;font-size:13px;color:#56645F;font-weight:400}' +
      '.lg{flex:none;width:44px;height:44px;border-radius:10px;object-fit:contain;background:' + p.brand + ';color:' + p.on + ';display:grid;place-items:center;font-weight:700;font-size:18px}' +
      'img.lg{background:#fff;border:1px solid #E3E9E7}' +
      '.card{width:560px;max-width:100%}.card .f{border-color:#E3E9E7}.foot{margin-top:24px;font-size:12px;color:#5F6B67}' +
      '@media (max-width:480px){.f{padding:20px}.done{padding:28px 20px}.hd{padding:24px 0 20px}.sum{grid-template-columns:minmax(0,1fr);gap:2px}.sum dd{margin-bottom:8px}}' +
      'dialog{border:0;padding:0;width:min(560px,calc(100% - 32px));max-height:calc(100% - 32px);overflow:auto;border-radius:' + CARD + ';background:transparent}' +
      'dialog::backdrop{background:rgba(15,23,21,.5)}dialog .f{border:0}' +
      '.x{position:absolute;top:10px;right:10px;width:36px;height:36px;border:0;border-radius:8px;background:transparent;color:#3D4C47;font-size:22px;cursor:pointer;z-index:1}';
  }

  // ── the form ──────────────────────────────────────────────────────────────
  function buildForm(cfg, slot, titleId) {
    var rows = {}, files = [], token = null, tsError = false, busy = false, iframe = null, picked = null;
    var invisible = cfg.turnstile_mode === 'invisible';
    var NOT_VERIFIED = 'We couldn\'t verify this browser. Please try again.';
    var form = h('form', { 'class': 'f', novalidate: '', 'aria-labelledby': titleId });

    function row(name, label, control, required, hint) {
      var id = uid + '-' + name, wrap = h('div', { 'class': 'fld' });
      control.setAttribute('id', id);
      if (required) control.setAttribute('aria-required', 'true');
      var lab = h('label', { 'for': id }, [label, required ? h('span', { 'class': 'req', 'aria-hidden': 'true' }, [' *']) : null]);
      var hintEl = hint ? h('span', { id: id + '-hint', 'class': 'hint' }, [hint]) : null;
      if (control.getAttribute('type') === 'checkbox') { lab.setAttribute('class', 'check'); lab.insertBefore(control, lab.firstChild); wrap.appendChild(lab); }
      else { wrap.appendChild(lab); if (hintEl) wrap.appendChild(hintEl); wrap.appendChild(control); }
      if (hintEl && control.getAttribute('type') === 'checkbox') wrap.appendChild(hintEl);
      if (hintEl) control.setAttribute('aria-describedby', id + '-hint');
      var err = h('span', { id: id + '-err', 'class': 'em' }); err.hidden = true;
      wrap.appendChild(err);
      rows[name] = { wrap: wrap, controls: [control], err: err, hint: hintEl && id + '-hint', required: required };
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
    var input = function (max, type) { return h('input', { 'class': 'in', type: type || 'text', maxlength: String(max) }); };
    var textarea = function (max) { return h('textarea', { 'class': 'in', maxlength: String(max), rows: '5' }); };

    var title = h('h2', { id: titleId, tabindex: '-1', 'class': 't' }, [str(cfg.title) || 'Contact support']);
    form.appendChild(title);
    slot.ccTitle = title;
    form.appendChild(h('p', {}, [str(cfg.description) || 'Tell us what happened. We\'ll reply by email.']));
    var help = safeUrl(cfg.help_site_url);
    if (help && cfg.help_mode === 'link') {
      form.appendChild(h('div', { 'class': 'help' }, ['Looking for an answer? Search ', link(help, new URL(help).hostname + new URL(help).pathname.replace(/\/$/, ''))]));
    }

    var name = input(LIMITS.name), email = input(LIMITS.email, 'email');
    name.setAttribute('autocomplete', 'name'); email.setAttribute('autocomplete', 'email');
    form.appendChild(h('div', { 'class': 'two' }, [row('name', 'Name', name, true), row('email', 'Email', email, true)]));

    var topics = (Array.isArray(cfg.topics) ? cfg.topics : []).filter(function (t) { return t && str(t.id) && str(t.name); });
    if (topics.length) {
      var answer = h('div', { 'class': 'ans', 'aria-live': 'polite' }); answer.hidden = true;
      var legend = h('legend', { 'class': 'lb' }, ['What is it about?', h('span', { 'class': 'req', 'aria-hidden': 'true' }, [' *'])]);
      var chips = h('div', { 'class': 'chips' });
      var set = h('fieldset', { 'class': 'fld' }, [legend, chips]);
      var radios = topics.map(function (t) {
        var rb = h('input', { type: 'radio', name: uid + '-topic', value: str(t.id) });
        rb.addEventListener('change', function () {
          picked = t; setError('topic', '');
          answer.replaceChildren();
          var art = safeUrl(t.article_url);
          if (str(t.short_text)) answer.appendChild(document.createTextNode(str(t.short_text) + ' '));
          if (art) answer.appendChild(link(art, 'Read the article ↗'));
          answer.hidden = !(str(t.short_text) || art);
        });
        chips.appendChild(h('label', { 'class': 'chip' }, [rb, h('span', {}, [str(t.name)])]));
        return rb;
      });
      var terr = h('span', { id: uid + '-topic-err', 'class': 'em' }); terr.hidden = true;
      set.appendChild(answer); // the picked topic's answer sits right under the chips
      set.appendChild(terr);
      rows.topic = { wrap: set, controls: radios, err: terr, required: true };
      form.appendChild(set);
    }

    var subject = input(LIMITS.subject);
    form.appendChild(row('subject', 'Subject', subject, true));

    var extra = (Array.isArray(cfg.fields) ? cfg.fields : []).filter(function (f) { return f && str(f.id) && str(f.label); });
    extra.forEach(function (f) {
      var c, kind = f.kind;
      if (kind === 'long') c = textarea(LIMITS.long);
      else if (kind === 'checkbox') c = h('input', { type: 'checkbox' });
      else if (kind === 'list') {
        c = h('select', { 'class': 'in' }, [h('option', { value: '' }, ['Choose…'])]);
        (Array.isArray(f.options) ? f.options : []).forEach(function (o) { if (str(o)) c.appendChild(h('option', { value: str(o) }, [str(o)])); });
      } else c = input(LIMITS.short);
      if (!f.required && kind !== 'checkbox' && kind !== 'list') c.setAttribute('placeholder', 'Optional');
      form.appendChild(row('field_' + str(f.id), str(f.label), c, !!f.required, str(f.hint)));
    });

    var message = textarea(LIMITS.message);
    form.appendChild(row('message', 'Message', message, true));

    // Files: our own list so a visitor can add in several goes and remove one.
    var fileList = h('ul', { 'class': 'files' });
    if (cfg.files_on !== false) {
      var picker = h('input', { type: 'file', multiple: '', accept: KINDS.map(function (k) { return '.' + k; }).join(','), tabindex: '-1', 'aria-hidden': 'true' });
      picker.hidden = true;
      var add = h('button', { type: 'button', 'class': 'cbtn', id: uid + '-files' }, ['Add file']);
      var fhint = h('span', { id: uid + '-files-hint', 'class': 'hint' }, ['Images, PDF, CSV, text and Office files · up to 10 MB each, 10 files, 25 MB in total']);
      var ferr = h('span', { id: uid + '-files-err', 'class': 'em' }); ferr.hidden = true;
      add.setAttribute('aria-describedby', uid + '-files-hint');
      add.addEventListener('click', function () { picker.click(); });
      picker.addEventListener('change', function () { addFiles(picker.files); picker.value = ''; });
      form.appendChild(h('div', { 'class': 'fld' }, [
        h('span', { 'class': 'lb', id: uid + '-files-lb' }, ['Files']),
        h('div', { 'class': 'drop' }, [fileList, add, picker]), fhint, ferr]));
      renderFiles();
      rows.files = { controls: [add], err: ferr, hint: uid + '-files-hint' };
    }
    function addFiles(list) {
      var problem = '';
      Array.prototype.forEach.call(list || [], function (f) {
        var ext = (f.name.lastIndexOf('.') > 0 ? f.name.slice(f.name.lastIndexOf('.') + 1) : '').toLowerCase();
        var total = files.reduce(function (s, x) { return s + x.size; }, 0);
        if (KINDS.indexOf(ext) === -1) problem = problem || f.name + ' can\'t be sent. Use images, PDF, CSV, text or Office files.';
        else if (f.size > LIMITS.fileBytes) problem = problem || f.name + ' is over 10 MB.';
        else if (files.length >= LIMITS.files) problem = problem || 'Up to 10 files.';
        else if (total + f.size > LIMITS.totalBytes) problem = problem || 'Files can add up to 25 MB in total.';
        else files.push(f);
      });
      renderFiles(); setError('files', problem);
    }
    function renderFiles() {
      fileList.replaceChildren();
      if (!files.length) fileList.appendChild(h('li', { 'class': 'empty' }, ['No files added']));
      files.forEach(function (f, i) {
        var rm = h('button', { type: 'button', 'class': 'rm', 'aria-label': 'Remove ' + f.name }, ['×']);
        rm.addEventListener('click', function () { files.splice(i, 1); renderFiles(); setError('files', ''); rows.files.controls[0].focus(); });
        fileList.appendChild(h('li', {}, [h('span', {}, [f.name + ' · ' + kb(f.size)]), rm]));
      });
    }

    var alert = h('p', { 'class': 'alert', role: 'alert' });
    var send = h('button', { type: 'submit', 'class': 'send' }, [str(cfg.button_text) || 'Send']);
    form.appendChild(alert);
    if (preview) {
      // Looks like the real button; only the note says it is off.
      send.disabled = true; send.setAttribute('data-preview', '');
      form.appendChild(h('div', { 'class': 'sendrow' }, [send, h('p', { 'class': 'note' }, ['Preview: sending is turned off here.'])]));
    } else {
      // Turnstile runs in a frame on our host; the token comes back by postMessage.
      // Invisible mode: the frame takes no space and is hidden from assistive tech.
      iframe = h('iframe', { 'class': invisible ? 'ts inv' : 'ts', title: 'Security check', tabindex: invisible ? '-1' : null, 'aria-hidden': invisible ? 'true' : null,
        src: HOST + '/v1/turnstile?origin=' + encodeURIComponent(location.origin) });
      window.addEventListener('message', function (e) {
        if (e.origin !== HOST || !iframe || e.source !== iframe.contentWindow || !e.data) return;
        var d = e.data;
        if (d.type !== 'cc-turnstile') return;
        token = typeof d.token === 'string' && d.token ? d.token : null;
        tsError = !!d.error;
        if (token && alert.textContent === NOT_VERIFIED) alert.textContent = '';
      });
      form.appendChild(iframe);
      form.appendChild(send);
    }
    var privacy = invisible && safeUrl(cfg.privacy_url);
    var parts = [invisible ? null : 'Protected by Cloudflare Turnstile', link('https://customercatalyst.io', 'Powered by CustomerCatalyst'),
      privacy ? link(privacy, 'Privacy') : null].filter(Boolean);
    var fine = h('div', { 'class': 'fine' });
    parts.forEach(function (x, i) { if (i) fine.appendChild(document.createTextNode(' · ')); fine.appendChild(h('span', {}, [x])); });
    form.appendChild(fine);

    function validate() {
      var bad = [];
      function need(n, ok, msg) { setError(n, ok ? '' : msg); if (!ok) bad.push(n); }
      need('name', str(name.value), 'Add your name.');
      need('email', EMAIL_RE.test(str(email.value)), str(email.value) ? 'Check the email address, like name@company.com.' : 'Add your email.');
      if (rows.topic) need('topic', !!picked, 'Pick a topic.');
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
      if (!token) {
        if (tsError) { alert.textContent = NOT_VERIFIED; iframe.contentWindow.postMessage({ type: 'cc-turnstile-reset' }, HOST); }
        else alert.textContent = 'The security check is still running. Try again in a moment.';
        return;
      }
      var fd = new FormData();
      fd.append(key ? 'key' : 'slug', key || slug);
      fd.append('name', str(name.value)); fd.append('email', str(email.value));
      if (picked) fd.append('topic', str(picked.id));
      fd.append('subject', str(subject.value)); fd.append('message', str(message.value));
      extra.forEach(function (f) {
        var c = rows['field_' + str(f.id)].controls[0];
        fd.append('field_' + str(f.id), f.kind === 'checkbox' ? (c.checked ? 'yes' : 'no') : str(c.value));
      });
      files.forEach(function (f) { fd.append('files', f, f.name); });
      fd.append('turnstile_token', token);
      busy = true; send.disabled = true; send.setAttribute('aria-busy', 'true'); send.textContent = 'Sending…';
      var finish = function () {
        busy = false; send.disabled = false; send.removeAttribute('aria-busy'); send.textContent = str(cfg.button_text) || 'Send';
        token = null; // single use: ask the frame for a fresh one
        if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'cc-turnstile-reset' }, HOST);
      };
      fetch(HOST + '/v1/form/submit', { method: 'POST', body: fd, credentials: 'omit' })
        .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return { status: r.status, b: b }; }); })
        .then(function (res) {
          finish();
          var b = res.b;
          if (b && b.success) return done(b);
          var errs = b && b.errors && typeof b.errors === 'object' ? b.errors : null, first = null;
          if (errs) for (var n in errs) if (rows[n] && typeof errs[n] === 'string') { setError(n, errs[n]); first = first || n; }
          if (first) { rows[first].controls[0].focus(); return; }
          alert.textContent = res.status === 429 ? 'Too many messages. Wait a minute and try again.'
            : b && b.error === 'form_closed' ? 'This form is closed right now.'
              : b && (b.error === 'turnstile_failed' || b.error === 'turnstile_required') ? NOT_VERIFIED
              : 'Something went wrong and your message was not sent. Try again in a moment.';
        }, function () { finish(); alert.textContent = 'Could not reach us. Check your connection and try again.'; });
    });

    function done(b) {
      var vals = { name: str(b.name) || str(name.value), ticket: str(b.ticket_id_label), email: str(b.email) || str(email.value) };
      var go = cfg.after_send === 'redirect' && safeUrl(cfg.redirect_url);
      if (go) { location.assign(go); return; }
      var head = h('h2', { tabindex: '-1', id: titleId, 'class': 't' }, ['We\'ve got it.']);
      var sum = h('dl', { 'class': 'sum' });
      [['Topic', picked && str(picked.name)], ['Subject', str(subject.value)], ['Message', str(message.value)]].forEach(function (p) {
        if (p[1]) { sum.appendChild(h('dt', {}, [p[0]])); sum.appendChild(h('dd', {}, [p[1]])); }
      });
      var again = h('button', { type: 'button', 'class': 'btn' }, ['Send another request']);
      again.addEventListener('click', function () { mountForm(cfg, slot, titleId); });
      var view = h('div', { 'class': 'f done', role: 'status' }, [
        h('span', { 'class': 'ok', 'aria-hidden': 'true' }, ['✓']), head,
        vals.ticket ? h('span', { 'class': 'pill' }, [vals.ticket]) : null,
        h('p', {}, [fill(str(cfg.thank_you_text) || 'Thanks, *REQUESTER_NAME*. Your request is *TICKET_NUMBER*. We\'ll reply by email.', vals)]),
        sum, h('div', { 'class': 'acts' }, [again, help ? link(help, 'Visit help site', 'btn primary') : null]),
        h('div', { 'class': 'fine' }, [link('https://customercatalyst.io', 'Powered by CustomerCatalyst')])]);
      slot.replaceChildren(view);
      head.focus();
    }
    return form;
  }

  // Help mode "first": the help site, then the form only when the visitor asks for it.
  function mountForm(cfg, slot, titleId) {
    var help = safeUrl(cfg.help_site_url);
    if (help && cfg.help_mode === 'first' && !slot.ccShownHelp) {
      slot.ccShownHelp = true;
      var go = h('button', { type: 'button', 'class': 'btn' }, ['Contact support']);
      go.addEventListener('click', function () { mountForm(cfg, slot, titleId); var t = slot.ccTitle; if (t) t.focus(); });
      slot.replaceChildren(h('div', { 'class': 'f' }, [h('h2', { id: titleId, 'class': 't' }, [str(cfg.title) || 'Contact support']),
        h('p', {}, ['Most answers are on our help site.']),
        h('div', { 'class': 'acts' }, [link(help, 'Visit help site', 'btn primary'), go]),
        h('div', { 'class': 'fine' }, [link('https://customercatalyst.io', 'Powered by CustomerCatalyst')])]));
      return;
    }
    slot.replaceChildren(buildForm(cfg, slot, titleId));
  }

  // Every config, fetched or sent by the settings preview, goes through here: known keys
  // only, each with its type, strings capped. Meaning (hex, http(s), enums) is checked where used.
  var STR = ['org_name', 'color', 'logo_url', 'corners', 'font', 'title', 'description', 'button_text', 'help_site_url',
    'help_mode', 'after_send', 'thank_you_text', 'redirect_url', 'turnstile_mode', 'privacy_url'];
  function clean(c) {
    var out = {};
    if (!c || typeof c !== 'object') return out;
    var s = function (v, max) { return typeof v === 'string' ? v.slice(0, max || 2000) : ''; };
    var list = function (v, fn) { return Array.isArray(v) ? v.slice(0, 100).filter(function (x) { return x && typeof x === 'object'; }).map(fn) : undefined; };
    STR.forEach(function (k) { if (k in c) out[k] = s(c[k]); });
    // Page header texts: one short line each.
    ['page_title', 'page_subtitle'].forEach(function (k) { if (k in c) out[k] = s(c[k], 120).replace(/[\r\n\t]+/g, ' '); });
    if ('enabled' in c) out.enabled = c.enabled === true;
    if ('files_on' in c) out.files_on = c.files_on !== false;
    var topics = list(c.topics, function (t) { return { id: s(t.id, 100), name: s(t.name, 200), short_text: s(t.short_text), article_url: s(t.article_url) }; });
    if (topics) out.topics = topics;
    var fields = list(c.fields, function (f) {
      return { id: s(f.id, 100), label: s(f.label, 200), hint: s(f.hint, 500), kind: s(f.kind, 20), required: f.required === true,
        options: Array.isArray(f.options) ? f.options.slice(0, 100).map(function (o) { return s(o, 200); }) : [] };
    });
    if (fields) out.fields = fields;
    return out;
  }
  function merge(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }

  function shadow(parent, cfg) {
    var host = h('div', { 'data-cc-form': '' });
    parent.appendChild(host);
    var root = host.attachShadow({ mode: 'open' });
    root.appendChild(h('style', {}, [css(cfg || {})]));
    return root;
  }

  function closed(target, cfg) {
    var root = shadow(target, cfg);
    root.appendChild(h('div', { 'class': 'page' }, [h('div', { 'class': 'hd' }),
      h('div', { 'class': 'card f', role: 'status' }, [h('h1', { 'class': 't' }, [cfg ? 'This form is closed right now.' : 'This form is not available.']),
        h('p', {}, [cfg && str(cfg.org_name) ? 'Please contact ' + str(cfg.org_name) + ' another way.' : 'Check the link and try again.'])]),
      h('div', { 'class': 'foot' }, ['Powered by CustomerCatalyst'])]));
  }

  function start() {
    var target = null, opener = null;
    try { target = attr('data-target') && document.querySelector(attr('data-target')); opener = attr('data-open') && document.querySelector(attr('data-open')); } catch (e) { /* bad selector */ }
    if (!target && !opener) return;
    var got = key || slug
      ? fetch(HOST + '/v1/form/config?' + (key ? 'key=' + encodeURIComponent(key) : 'slug=' + encodeURIComponent(slug)), { credentials: 'omit' })
        .then(function (r) { return r.json(); })
        .catch(function () { return null; })
      : Promise.resolve({ success: true, config: {} }); // /v1/preview: defaults until the settings page sends values
    got.then(function (res) {
      var cfg = res && res.success === true && res.config && typeof res.config === 'object' ? clean(res.config) : null;
      if (!cfg || (cfg.enabled !== true && !preview)) { if (hosted && target) closed(target, cfg); return; }
      var titleId = uid + '-title';
      if (opener) return popup(opener, cfg, titleId);
      var root = null;
      paint(cfg);
      // Live settings preview: the Bubble page that frames us sends unsaved values.
      // Preview only (Send is disabled there, nothing reaches the server), and only
      // from the framing window itself.
      if (preview && window.parent && window.parent !== window) {
        window.addEventListener('message', function (e) {
          if (e.source !== window.parent || !e.data || e.data.type !== 'cc-form-preview') return;
          var y = window.scrollY;
          cfg = merge(cfg, clean(e.data.config));
          paint(cfg);
          if (typeof window.scrollTo === 'function') window.scrollTo(0, y || 0);
        });
        // Handshake: the settings page may (re)create this frame after it last sent values;
        // tell it we're listening so it sends them again. Carries no data, so any origin may hear it.
        window.parent.postMessage({ type: 'cc-form-preview-ready' }, '*');
      }
      function paint(cfg) {
        if (!root) root = shadow(target, cfg);
        else root.replaceChildren(h('style', {}, [css(cfg)]));
        var slot = h('div');
        if (hosted) {
          var org = str(cfg.org_name), logo = safeUrl(cfg.logo_url);
          var pageTitle = str(cfg.page_title) || (org ? org + ' ' : '') + 'support';
          document.title = pageTitle;
          root.appendChild(h('div', { 'class': 'page' }, [
            h('div', { 'class': 'hd' }, [logo ? h('img', { 'class': 'lg', src: logo, alt: '' }) : h('span', { 'class': 'lg', 'aria-hidden': 'true' }, [org.charAt(0).toUpperCase() || '?']),
              h('div', {}, [h('b', {}, [pageTitle]), h('small', {}, [str(cfg.page_subtitle) || 'We\'ll reply by email.'])])]),
            h('div', { 'class': 'card' }, [slot])]));
        } else root.appendChild(slot);
        mountForm(cfg, slot, titleId);
      }
    });
  }

  // Popup from the org's own button: a native modal <dialog> (inert page behind,
  // Esc closes), labelled by the form title, focus back on the button after.
  function popup(opener, cfg, titleId) {
    var root = shadow(document.body, cfg), slot = h('div');
    var x = h('button', { type: 'button', 'class': 'btn x', 'aria-label': 'Close' }, ['×']);
    var dialog = h('dialog', { 'aria-labelledby': titleId, 'aria-modal': 'true' }, [x, slot]);
    root.appendChild(dialog);
    opener.setAttribute('aria-haspopup', 'dialog');
    x.addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('close', function () { opener.focus(); });
    opener.addEventListener('click', function (e) {
      e.preventDefault();
      if (!slot.firstChild) mountForm(cfg, slot, titleId); // Turnstile loads on first open, not on page load
      if (!dialog.open) dialog.showModal();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
