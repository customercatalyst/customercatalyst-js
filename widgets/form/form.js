/*!
 * CustomerCatalyst support form widget. No dependencies, loaded on customers' pages.
 *   <script src="<host>/v1/form.js" data-key="pk_…" data-target="#cc-support-form" async></script>
 *   <script src="<host>/v1/form.js" data-key="pk_…" data-open="#my-button" async></script>
 * Hosted page (/f/<slug>) uses data-slug + data-mode="hosted"; data-preview="1" disables Send.
 * Separate from the tracking SDK: only global is CustomerCatalystForm. Stores nothing in the
 * browser (no visitor name/email kept; the ccm_ prefix is reserved for Messenger).
 * All org and visitor text goes in with textContent; links only http(s).
 * Served by the Worker together with ../shared/kit.js (helpers both widgets use); this file
 * alone does not run.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || !script.src) return;
  var HOST = new URL(script.src).origin;
  if (!window.CustomerCatalystForm) window.CustomerCatalystForm = { version: '1' };

  var SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

  var attr = function (n) { return script.getAttribute(n); };
  var key = attr('data-key'), slug = attr('data-slug');
  var hosted = attr('data-mode') === 'hosted';
  var preview = attr('data-preview') === '1';
  // /v1/preview runs with neither (nothing saved yet): it waits for the settings page's messages.
  if (key ? !KEY_RE.test(key) : slug ? !SLUG_RE.test(slug) : !preview) return;
  var uid = 'ccf' + Math.random().toString(36).slice(2, 8);

  // The app's placeholder style (*XYZ*, as in the ticket templates). Result goes in as text only.
  function fill(t, vals) {
    return t.split('*REQUESTER_NAME*').join(vals.name).split('*TICKET_NUMBER*').join(vals.ticket).split('*REQUESTER_EMAIL*').join(vals.email);
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
      'select.in{-webkit-appearance:none;appearance:none;padding-right:40px;cursor:pointer;background:#fff ' + CHEVRON + '}' +
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
      '.hd{display:flex;align-items:center;gap:12px;padding:40px 0 28px;width:560px;max-width:100%;box-sizing:border-box}' +
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
    var rows = {}, files = [], busy = false, ts = null, picked = null;
    var invisible = cfg.turnstile_mode === 'invisible';
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

    var topics = validTopics(cfg);
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

    var extra = validFields(cfg);
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
      var picker = filePicker();
      var add = h('button', { type: 'button', 'class': 'cbtn', id: uid + '-files' }, ['Add file']);
      var fhint = h('span', { id: uid + '-files-hint', 'class': 'hint' }, [FILE_HINT]);
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
      var problem = takeFiles(files, list);
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
      ts = turnstile(HOST, invisible, function (st) { if (st.token && alert.textContent === NOT_VERIFIED) alert.textContent = ''; });
      form.appendChild(ts.frame);
      form.appendChild(send);
    }
    var privacy = invisible && safeUrl(cfg.privacy_url);
    form.appendChild(fineLine([invisible ? null : 'Protected by Cloudflare Turnstile', poweredBy(), privacy ? link(privacy, 'Privacy') : null]));

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
      if (!ts.token) {
        if (ts.error) { alert.textContent = NOT_VERIFIED; ts.reset(); }
        else alert.textContent = 'The security check is still running. Try again in a moment.';
        return;
      }
      var fd = submissionData(key ? ['key', key] : ['slug', slug], { name: str(name.value), email: str(email.value), topic: picked && str(picked.id),
        subject: str(subject.value), message: str(message.value) }, extra, rows, files, ts.token);
      busy = true; send.disabled = true; send.setAttribute('aria-busy', 'true'); send.textContent = 'Sending…';
      var finish = function () {
        busy = false; send.disabled = false; send.removeAttribute('aria-busy'); send.textContent = str(cfg.button_text) || 'Send';
        ts.reset(); // single use: ask the frame for a fresh one
      };
      postSubmission(HOST + '/v1/form/submit', fd, { rows: rows, setError: setError, alert: alert, finish: finish, done: done,
        closed: ['form_closed', 'This form is closed right now.'] });
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
        fineLine([poweredBy()])]);
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
        fineLine([poweredBy()])]));
      return;
    }
    slot.replaceChildren(buildForm(cfg, slot, titleId));
  }

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
      // from the framing window on one of the listed settings origins.
      if (preview) {
        listenPreview(previewParents(script), 'cc-form-preview', function (d) {
          var y = window.scrollY;
          cfg = merge(cfg, clean(d.config));
          paint(cfg);
          if (typeof window.scrollTo === 'function') window.scrollTo(0, y || 0);
        });
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
