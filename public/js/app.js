/* ==========================================================================
   IndexFlow — application JavaScript
   --------------------------------------------------------------------------
   Vanilla ES2020. No framework, no bundler, no imports, no network calls.
   Everything is progressive enhancement: every feature here degrades to a
   working server-rendered page if JavaScript is unavailable.

   Security posture:
     • Nothing in this file ever assigns untrusted data to innerHTML.
       All text goes through textContent and all nodes are built explicitly.
     • No eval, no new Function, no dynamic script injection.

   Public surface (window.IndexFlow):
     toast(message, type, options)   show a toast notification
     openModal(id) / closeModal(el)  modal control
     copy(text)                      copy to clipboard, resolves to boolean
     setTheme(theme) / getTheme()    'light' | 'dark' | 'system'
     formatNumber(value, options)    locale number formatting
   ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
     Small helpers
     ====================================================================== */

  var THEME_KEY = 'indexflow.theme';
  var THEMES = ['light', 'dark', 'system'];

  function $(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function $$(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  function on(target, type, handler, options) {
    if (target) target.addEventListener(type, handler, options || false);
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        timer = null;
        fn.apply(self, args);
      }, wait);
    };
  }

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /** Create an element with optional class list and text content (never HTML). */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /* ======================================================================
     Theme controller
     ----------------------------------------------------------------------
     The stored value is one of light | dark | system. `system` is a real
     stored state, not the absence of one, so the CSS can distinguish
     "follow the OS" from "not yet decided".

     Flash-of-wrong-theme is prevented by an inline snippet in
     views/partials/head.ejs that runs before the stylesheet is applied.
     For reference, that snippet is exactly:

       <script>
       (function(){try{var k='indexflow.theme',t=localStorage.getItem(k);
       if(t!=='light'&&t!=='dark'&&t!=='system'){t='system';}
       document.documentElement.setAttribute('data-theme',t);}
       catch(e){document.documentElement.setAttribute('data-theme','system');}})();
       </script>

     Keep the key in both places identical.
     ====================================================================== */

  var Theme = (function () {
    function read() {
      try {
        var stored = window.localStorage.getItem(THEME_KEY);
        return THEMES.indexOf(stored) !== -1 ? stored : 'system';
      } catch (err) {
        return 'system';
      }
    }

    function write(theme) {
      try {
        window.localStorage.setItem(THEME_KEY, theme);
      } catch (err) {
        /* Private browsing or storage disabled — the in-page theme still applies. */
      }
    }

    function systemPrefersDark() {
      return (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
      );
    }

    /** The theme actually being painted right now: 'light' or 'dark'. */
    function resolved() {
      var theme = read();
      if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light';
      return theme;
    }

    function apply(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      syncControls();
    }

    function set(theme) {
      if (THEMES.indexOf(theme) === -1) theme = 'system';
      write(theme);
      apply(theme);
      return theme;
    }

    /** Keep every toggle's accessible name in step with the current state. */
    function syncControls() {
      var stored = read();
      var now = resolved();
      var next = now === 'dark' ? 'light' : 'dark';
      var label = 'Switch to ' + next + ' theme';

      $$('[data-theme-toggle]').forEach(function (control) {
        var explicit = control.getAttribute('data-theme-toggle');
        if (explicit && THEMES.indexOf(explicit) !== -1) {
          control.setAttribute('aria-pressed', String(stored === explicit));
          return;
        }
        control.setAttribute('aria-label', label);
        control.setAttribute('title', label);
      });
    }

    function init() {
      apply(read());

      // A click on [data-theme-toggle] with a value selects that theme;
      // with an empty value it flips between light and dark.
      on(document, 'click', function (event) {
        var control = event.target.closest ? event.target.closest('[data-theme-toggle]') : null;
        if (!control) return;
        event.preventDefault();

        var explicit = control.getAttribute('data-theme-toggle');
        if (explicit && THEMES.indexOf(explicit) !== -1) {
          set(explicit);
        } else {
          set(resolved() === 'dark' ? 'light' : 'dark');
        }
      });

      // While following the OS, react to the OS changing under us.
      if (typeof window.matchMedia === 'function') {
        var query = window.matchMedia('(prefers-color-scheme: dark)');
        var onChange = function () {
          if (read() === 'system') syncControls();
        };
        if (typeof query.addEventListener === 'function') {
          query.addEventListener('change', onChange);
        } else if (typeof query.addListener === 'function') {
          query.addListener(onChange);
        }
      }
    }

    return { init: init, set: set, get: read, resolved: resolved };
  })();

  /* ======================================================================
     Toasts
     ====================================================================== */

  var Toast = (function () {
    var TYPES = { success: 1, error: 1, info: 1, warning: 1 };

    function container() {
      var node = $('.toast-container');
      if (!node) {
        node = el('div', 'toast-container');
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
        node.setAttribute('aria-atomic', 'false');
        document.body.appendChild(node);
      }
      return node;
    }

    function dismiss(toast) {
      if (!toast || toast.dataset.leaving === '1') return;
      toast.dataset.leaving = '1';

      var remove = function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      };

      if (prefersReducedMotion()) {
        remove();
        return;
      }

      toast.classList.add('is-leaving');
      window.setTimeout(remove, 180);
    }

    /**
     * show(message, type, options)
     *   type: success | error | info | warning (default info)
     *   options.duration: ms before auto-dismiss, 0 disables it (default 5200)
     *   options.dismissible: show the close button (default true)
     */
    function show(message, type, options) {
      var text = message === undefined || message === null ? '' : String(message);
      if (!text) return null;

      var opts = options || {};
      var kind = TYPES[type] ? type : 'info';
      var duration = typeof opts.duration === 'number' ? opts.duration : 5200;

      var toast = el('div', 'toast toast-' + kind);
      toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      toast.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');

      // textContent only — a flash message may echo user-supplied values.
      toast.appendChild(el('div', 'toast-message', text));

      if (opts.dismissible !== false) {
        var close = el('button', 'toast-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', 'Dismiss notification');
        on(close, 'click', function () {
          dismiss(toast);
        });
        toast.appendChild(close);
      }

      container().appendChild(toast);

      if (duration > 0) {
        var remaining = duration;
        var startedAt = Date.now();
        var timer = window.setTimeout(function () {
          dismiss(toast);
        }, remaining);

        // Pause on hover and while focus is inside, so a message can be read
        // and its links clicked without racing the timer.
        var pause = function () {
          if (!timer) return;
          window.clearTimeout(timer);
          timer = null;
          remaining = Math.max(1200, remaining - (Date.now() - startedAt));
        };
        var resume = function () {
          if (timer) return;
          startedAt = Date.now();
          timer = window.setTimeout(function () {
            dismiss(toast);
          }, remaining);
        };

        on(toast, 'mouseenter', pause);
        on(toast, 'mouseleave', resume);
        on(toast, 'focusin', pause);
        on(toast, 'focusout', resume);
      }

      return toast;
    }

    /**
     * Replay server-side flash messages rendered as
     *   <div id="flash-data" data-flash='[{"type":"success","message":"..."}]'>
     * The attribute is HTML-escaped JSON produced by EJS; parsing it here keeps
     * message text out of the DOM as markup.
     */
    function replayFlash() {
      var holder = document.getElementById('flash-data');
      if (!holder) return;

      var raw = holder.getAttribute('data-flash');
      if (!raw) return;

      var entries;
      try {
        entries = JSON.parse(raw);
      } catch (err) {
        return;
      }
      if (!Array.isArray(entries)) return;

      entries.forEach(function (entry, index) {
        if (!entry) return;

        var message = typeof entry === 'string' ? entry : entry.message || entry.text;
        var type = typeof entry === 'object' && entry ? entry.type || entry.level : 'info';
        if (!message) return;

        // Accept a couple of common server-side aliases.
        if (type === 'danger') type = 'error';
        if (type === 'warn') type = 'warning';

        window.setTimeout(function () {
          show(message, type, {});
        }, index * 120);
      });
    }

    return { show: show, replayFlash: replayFlash };
  })();

  /* ======================================================================
     Modals
     ----------------------------------------------------------------------
     Markup contract:
       <button data-modal-open="delete-batch">…</button>
       <div class="modal-backdrop" id="delete-batch" role="dialog"
            aria-modal="true" aria-labelledby="delete-batch-title" hidden>
         <div class="modal">… <button data-modal-close>Cancel</button> …</div>
       </div>
     ====================================================================== */

  var Modal = (function () {
    var FOCUSABLE = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    var openStack = [];

    function focusableIn(root) {
      return $$(FOCUSABLE, root).filter(function (node) {
        return node.offsetWidth > 0 || node.offsetHeight > 0 || node === document.activeElement;
      });
    }

    function open(idOrNode, trigger) {
      var backdrop = typeof idOrNode === 'string' ? document.getElementById(idOrNode) : idOrNode;
      if (!backdrop || openStack.indexOf(backdrop) !== -1) return null;

      backdrop.hidden = false;
      backdrop.classList.add('is-open');
      document.body.classList.add('if-modal-open');

      openStack.push(backdrop);
      backdrop._ifReturnFocus = trigger || document.activeElement;

      var panel = $('.modal', backdrop) || backdrop;
      var target = $('[data-modal-autofocus]', panel) || focusableIn(panel)[0] || panel;
      if (target === panel && !panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
      if (target && typeof target.focus === 'function') target.focus();

      return backdrop;
    }

    function close(backdrop) {
      var node = backdrop || openStack[openStack.length - 1];
      if (!node) return;

      node.classList.remove('is-open');
      node.hidden = true;

      var index = openStack.indexOf(node);
      if (index !== -1) openStack.splice(index, 1);
      if (!openStack.length) document.body.classList.remove('if-modal-open');

      var restore = node._ifReturnFocus;
      node._ifReturnFocus = null;
      if (restore && typeof restore.focus === 'function' && document.contains(restore)) {
        restore.focus();
      }
    }

    /** Keep Tab cycling inside the topmost dialog. */
    function trap(event) {
      if (event.key !== 'Tab' || !openStack.length) return;

      var backdrop = openStack[openStack.length - 1];
      var panel = $('.modal', backdrop) || backdrop;
      var items = focusableIn(panel);
      if (!items.length) {
        event.preventDefault();
        panel.focus();
        return;
      }

      var first = items[0];
      var last = items[items.length - 1];
      var active = document.activeElement;

      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function init() {
      // Any element that was left visible server-side stays consistent.
      $$('.modal-backdrop').forEach(function (backdrop) {
        if (!backdrop.classList.contains('is-open')) backdrop.hidden = true;
        if (!backdrop.hasAttribute('role')) backdrop.setAttribute('role', 'dialog');
        if (!backdrop.hasAttribute('aria-modal')) backdrop.setAttribute('aria-modal', 'true');
      });

      on(document, 'click', function (event) {
        if (!event.target.closest) return;

        var opener = event.target.closest('[data-modal-open]');
        if (opener) {
          event.preventDefault();
          open(opener.getAttribute('data-modal-open'), opener);
          return;
        }

        var closer = event.target.closest('[data-modal-close]');
        if (closer) {
          event.preventDefault();
          close(closer.closest('.modal-backdrop'));
          return;
        }

        // Click on the backdrop itself (not the panel) dismisses.
        if (
          event.target.classList &&
          event.target.classList.contains('modal-backdrop') &&
          event.target.classList.contains('is-open')
        ) {
          close(event.target);
        }
      });

      on(document, 'keydown', function (event) {
        if (event.key === 'Escape' && openStack.length) {
          event.preventDefault();
          close();
          return;
        }
        trap(event);
      });
    }

    return { init: init, open: open, close: close };
  })();

  /* ======================================================================
     Dropdowns
     ----------------------------------------------------------------------
       <div class="dropdown">
         <button data-dropdown-toggle aria-expanded="false" aria-haspopup="true">…</button>
         <ul class="dropdown-menu">…</ul>
       </div>
     ====================================================================== */

  function initDropdowns() {
    function menuFor(toggle) {
      var explicit = toggle.getAttribute('data-dropdown-toggle');
      if (explicit) return document.getElementById(explicit);
      var wrapper = toggle.closest('.dropdown');
      return wrapper ? $('.dropdown-menu', wrapper) : null;
    }

    function closeAll(except) {
      $$('.dropdown-menu.is-open').forEach(function (menu) {
        if (menu === except) return;
        menu.classList.remove('is-open');
        var owner = menu.closest('.dropdown');
        var toggle = owner ? $('[data-dropdown-toggle]', owner) : null;
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
      });
    }

    $$('[data-dropdown-toggle]').forEach(function (toggle) {
      if (!toggle.hasAttribute('aria-expanded')) toggle.setAttribute('aria-expanded', 'false');
      if (!toggle.hasAttribute('aria-haspopup')) toggle.setAttribute('aria-haspopup', 'true');
    });

    on(document, 'click', function (event) {
      var toggle = event.target.closest ? event.target.closest('[data-dropdown-toggle]') : null;

      if (toggle) {
        event.preventDefault();
        var menu = menuFor(toggle);
        if (!menu) return;
        var willOpen = !menu.classList.contains('is-open');
        closeAll(menu);
        menu.classList.toggle('is-open', willOpen);
        toggle.setAttribute('aria-expanded', String(willOpen));
        return;
      }

      // Outside click, including clicks on items inside an open menu.
      closeAll(null);
    });

    on(document, 'keydown', function (event) {
      if (event.key !== 'Escape') return;
      var open = $('.dropdown-menu.is-open');
      if (!open) return;

      var owner = open.closest('.dropdown');
      var toggle = owner ? $('[data-dropdown-toggle]', owner) : null;
      closeAll(null);
      if (toggle && typeof toggle.focus === 'function') toggle.focus();
    });
  }

  /* ======================================================================
     Generic collapsible toggles
     ----------------------------------------------------------------------
     Used by the marketing mobile menu and the dashboard sidebar drawer:
       <button data-toggle="mobile-menu" aria-expanded="false" aria-controls="mobile-menu">
       <nav id="mobile-menu" class="nav-mobile">…</nav>
     Adds/removes `is-open` on the target.
     ====================================================================== */

  function initToggles() {
    function target(button) {
      var id = button.getAttribute('data-toggle');
      return id ? document.getElementById(id) : null;
    }

    function setState(button, node, open) {
      node.classList.toggle('is-open', open);
      button.setAttribute('aria-expanded', String(open));
    }

    on(document, 'click', function (event) {
      var button = event.target.closest ? event.target.closest('[data-toggle]') : null;
      if (!button) return;

      var node = target(button);
      if (!node) return;

      event.preventDefault();
      setState(button, node, !node.classList.contains('is-open'));
    });

    // Escape closes any open collapsible and returns focus to its control.
    on(document, 'keydown', function (event) {
      if (event.key !== 'Escape') return;

      $$('[data-toggle]').forEach(function (button) {
        var node = target(button);
        if (node && node.classList.contains('is-open')) {
          setState(button, node, false);
          if (typeof button.focus === 'function') button.focus();
        }
      });
    });

    // Clicking outside an open drawer/menu closes it.
    on(document, 'click', function (event) {
      $$('[data-toggle]').forEach(function (button) {
        var node = target(button);
        if (!node || !node.classList.contains('is-open')) return;
        if (node.contains(event.target) || button.contains(event.target)) return;
        setState(button, node, false);
      });
    });

    $$('[data-toggle]').forEach(function (button) {
      if (!button.hasAttribute('aria-expanded')) button.setAttribute('aria-expanded', 'false');
      var node = target(button);
      if (node && !button.hasAttribute('aria-controls') && node.id) {
        button.setAttribute('aria-controls', node.id);
      }
    });
  }

  /* ======================================================================
     Confirm before destructive actions
     ----------------------------------------------------------------------
     <form data-confirm="Delete this batch? This cannot be undone.">
     <a href="…" data-confirm="Revoke this API key?">
     Server-side authorization is the real control; this only prevents
     accidents.
     ====================================================================== */

  function initConfirm() {
    on(
      document,
      'submit',
      function (event) {
        var form = event.target;
        if (!form || !form.matches || !form.matches('form[data-confirm]')) return;
        if (form.dataset.confirmed === '1') return;

        var message = form.getAttribute('data-confirm') || 'Are you sure?';
        if (!window.confirm(message)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        } else {
          form.dataset.confirmed = '1';
        }
      },
      true
    );

    on(
      document,
      'click',
      function (event) {
        var link = event.target.closest ? event.target.closest('a[data-confirm]') : null;
        if (!link) return;

        var message = link.getAttribute('data-confirm') || 'Are you sure?';
        if (!window.confirm(message)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true
    );
  }

  /* ======================================================================
     Copy to clipboard
     ----------------------------------------------------------------------
     <button data-copy="sc-domain:example.com">Copy</button>
     Falls back to a hidden textarea for non-secure contexts.
     ====================================================================== */

  function copyText(text) {
    var value = String(text === undefined || text === null ? '' : text);

    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(value).then(
        function () {
          return true;
        },
        function () {
          return legacyCopy(value);
        }
      );
    }
    return Promise.resolve(legacyCopy(value));
  }

  function legacyCopy(value) {
    var area = document.createElement('textarea');
    area.value = value; // value, not innerHTML
    area.setAttribute('readonly', 'readonly');
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);

    var ok = false;
    try {
      area.select();
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  function initCopy() {
    on(document, 'click', function (event) {
      var trigger = event.target.closest ? event.target.closest('[data-copy]') : null;
      if (!trigger) return;

      event.preventDefault();

      var text = trigger.getAttribute('data-copy');

      // An empty data-copy means "copy the element's own text".
      if (!text) {
        var sourceId = trigger.getAttribute('data-copy-source');
        var source = sourceId ? document.getElementById(sourceId) : null;
        text = source ? source.textContent : trigger.textContent;
      }

      copyText(text).then(function (ok) {
        if (ok) {
          Toast.show(trigger.getAttribute('data-copy-message') || 'Copied', 'success', {
            duration: 2200
          });
        } else {
          Toast.show('Could not copy — select the text and copy manually.', 'error', {});
        }
      });
    });
  }

  /* ======================================================================
     Form submit guard
     ----------------------------------------------------------------------
     Prevents double submission and shows progress on the submit button:
       <button class="btn btn-primary" data-loading-label="Starting…">Start</button>

     Notes:
       • Does nothing when the browser blocks submission for validation —
         a failed constraint check never fires a submit event.
       • The button is disabled asynchronously, because a synchronously
         disabled submitter is excluded from the form payload.
     ====================================================================== */

  function initSubmitGuard() {
    on(document, 'submit', function (event) {
      var form = event.target;
      if (!form || !form.matches || !form.matches('form')) return;
      if (event.defaultPrevented) return;
      if (form.hasAttribute('data-no-submit-guard')) return;

      // Second attempt while the first is still in flight.
      if (form.dataset.submitting === '1') {
        event.preventDefault();
        return;
      }

      if (typeof form.checkValidity === 'function' && !form.checkValidity()) return;

      form.dataset.submitting = '1';

      var submitter =
        event.submitter ||
        $('button[type="submit"], input[type="submit"]', form);
      if (!submitter) return;

      if (submitter.tagName === 'BUTTON') {
        var label = submitter.getAttribute('data-loading-label');
        submitter.dataset.originalLabel = submitter.textContent;
        submitter.classList.add('is-loading');

        // Rebuild the label with nodes: spinner + text, never innerHTML.
        while (submitter.firstChild) submitter.removeChild(submitter.firstChild);
        var spinner = el('span', 'spinner');
        spinner.setAttribute('aria-hidden', 'true');
        submitter.appendChild(spinner);
        submitter.appendChild(document.createTextNode(label || 'Working…'));
      }

      submitter.setAttribute('aria-busy', 'true');

      window.setTimeout(function () {
        submitter.disabled = true;
      }, 0);

      // If the page is restored from history cache, re-enable everything so a
      // Back navigation does not leave a permanently dead button.
      on(window, 'pageshow', function () {
        form.dataset.submitting = '';
        submitter.disabled = false;
        submitter.removeAttribute('aria-busy');
        submitter.classList.remove('is-loading');
        if (submitter.dataset.originalLabel !== undefined) {
          submitter.textContent = submitter.dataset.originalLabel;
        }
      });
    });
  }

  /* ======================================================================
     Auto-submitting filter forms
     ----------------------------------------------------------------------
     <form data-autosubmit method="get">…</form>
     Text inputs debounce at 600ms; selects and checkboxes submit at once,
     because those are discrete choices rather than typing.
     ====================================================================== */

  function initAutoSubmit() {
    $$('form[data-autosubmit]').forEach(function (form) {
      var submit = function () {
        // Reset pagination whenever a filter changes, otherwise a narrowed
        // result set can land the customer on an empty page 7.
        var page = form.querySelector('input[name="page"]');
        if (page) page.value = '1';

        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          form.submit();
        }
      };

      var debounced = debounce(submit, 600);

      on(form, 'input', function (event) {
        var field = event.target;
        if (!field.matches) return;
        if (field.matches('input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="number"]')) {
          debounced();
        }
      });

      on(form, 'change', function (event) {
        var field = event.target;
        if (!field.matches) return;
        if (field.matches('select, input[type="checkbox"], input[type="radio"], input[type="date"]')) {
          submit();
        }
      });

      // Enter inside a filter field should submit immediately, not wait.
      on(form, 'keydown', function (event) {
        if (event.key === 'Enter' && event.target.matches('input')) {
          event.preventDefault();
          submit();
        }
      });
    });
  }

  /* ======================================================================
     Bulk selection for tables
     ----------------------------------------------------------------------
       <input type="checkbox" data-select-all>
       <input type="checkbox" data-select-row value="…">
       <span data-selection-count>0</span>
       <button data-requires-selection disabled>Start processing</button>
     Scope defaults to the nearest [data-select-scope], form, or table.
     ====================================================================== */

  function initBulkSelect() {
    function scopeOf(node) {
      return (
        node.closest('[data-select-scope]') ||
        node.closest('form') ||
        node.closest('table') ||
        document
      );
    }

    function refresh(scope) {
      var rows = $$('[data-select-row]', scope);
      var selected = rows.filter(function (row) {
        return row.checked;
      });
      var count = selected.length;

      $$('[data-select-all]', scope).forEach(function (master) {
        master.checked = count > 0 && count === rows.length;
        master.indeterminate = count > 0 && count < rows.length;
      });

      $$('[data-selection-count]', scope).forEach(function (node) {
        node.textContent = String(count);
      });

      $$('[data-selection-visible]', scope).forEach(function (node) {
        node.hidden = count === 0;
      });

      $$('[data-requires-selection]', scope).forEach(function (node) {
        if (node.tagName === 'BUTTON' || node.tagName === 'INPUT' || node.tagName === 'SELECT') {
          node.disabled = count === 0;
        } else {
          node.setAttribute('aria-disabled', String(count === 0));
        }
      });

      rows.forEach(function (row) {
        var tr = row.closest('tr');
        if (tr) tr.classList.toggle('is-selected', row.checked);
      });
    }

    on(document, 'change', function (event) {
      var field = event.target;
      if (!field.matches) return;

      if (field.matches('[data-select-all]')) {
        var scope = scopeOf(field);
        var checked = field.checked;
        $$('[data-select-row]', scope).forEach(function (row) {
          if (!row.disabled) row.checked = checked;
        });
        refresh(scope);
        return;
      }

      if (field.matches('[data-select-row]')) {
        refresh(scopeOf(field));
      }
    });

    // Initial pass so server-rendered checked states are reflected.
    var scopes = $$('[data-select-scope]');
    if (!scopes.length && $('[data-select-row]')) scopes = [document];
    scopes.forEach(refresh);
  }

  /* ======================================================================
     Number formatting
     ====================================================================== */

  function formatNumber(value, options) {
    var num = typeof value === 'number' ? value : Number(value);
    if (!isFinite(num)) return '0';

    try {
      return new Intl.NumberFormat(undefined, options || {}).format(num);
    } catch (err) {
      // Manual grouping fallback for very old engines.
      var parts = String(num).split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return parts.join('.');
    }
  }

  /* ======================================================================
     Relative timestamps
     ----------------------------------------------------------------------
     <time datetime="2026-09-04T10:00:00Z" data-relative>…</time>
     Progressive: the server-rendered absolute time stays in the title.
     ====================================================================== */

  function initRelativeTimes() {
    var nodes = $$('time[data-relative][datetime]');
    if (!nodes.length) return;

    var units = [
      ['year', 31536000],
      ['month', 2592000],
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60]
    ];

    var render = function () {
      var now = Date.now();

      nodes.forEach(function (node) {
        var when = Date.parse(node.getAttribute('datetime'));
        if (isNaN(when)) return;

        if (!node.title) node.title = node.textContent.trim();

        var seconds = Math.round((now - when) / 1000);
        var past = seconds >= 0;
        var abs = Math.abs(seconds);

        if (abs < 45) {
          node.textContent = 'just now';
          return;
        }

        for (var i = 0; i < units.length; i += 1) {
          if (abs >= units[i][1]) {
            var qty = Math.round(abs / units[i][1]);
            var unit = units[i][0] + (qty === 1 ? '' : 's');
            node.textContent = past ? qty + ' ' + unit + ' ago' : 'in ' + qty + ' ' + unit;
            return;
          }
        }

        var mins = Math.max(1, Math.round(abs / 60));
        node.textContent = past ? mins + ' min ago' : 'in ' + mins + ' min';
      });
    };

    render();
    window.setInterval(render, 60000);
  }

  /* ======================================================================
     Boot
     ====================================================================== */

  function boot() {
    Theme.init();
    Modal.init();
    initDropdowns();
    initToggles();
    initConfirm();
    initCopy();
    initSubmitGuard();
    initAutoSubmit();
    initBulkSelect();
    initRelativeTimes();
    Toast.replayFlash();
  }

  window.IndexFlow = {
    toast: function (message, type, options) {
      return Toast.show(message, type, options);
    },
    openModal: function (id) {
      return Modal.open(id, document.activeElement);
    },
    closeModal: function (node) {
      return Modal.close(node);
    },
    copy: copyText,
    setTheme: Theme.set,
    getTheme: Theme.get,
    resolvedTheme: Theme.resolved,
    formatNumber: formatNumber
  };

  if (document.readyState === 'loading') {
    on(document, 'DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
