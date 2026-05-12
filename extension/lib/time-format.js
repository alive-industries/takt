// Shared time-input helpers used by the on-issue timer editor and the
// My Time inline duration editor. Loaded as a plain (non-module) script so
// the same file works both as a content script and from extension pages.
//
// Parsing model — "Toggl-style" digit buffer:
//
//   The user types only digits. The digits are packed right-to-left as
//   HHMMSS, so:
//
//     "30"      -> 00:00:30   (30 seconds)
//     "130"     -> 00:01:30   (1 min 30 sec)
//     "3000"    -> 00:30:00   (30 minutes)        <-- what we want
//     "13000"   -> 01:30:00   (1h 30m)
//     "130000"  -> 13:00:00   (13 hours)
//
// Pasting a colon-formatted string (e.g. "1:30:00") is also accepted on
// commit, but as the user types the value is rewritten to canonical
// HH:MM:SS form so what they see is always what gets saved.

(function (root) {
  'use strict';

  // Cap to 8 digits so HH never exceeds 4 digits. Anything past that is
  // almost certainly a paste accident.
  const MAX_DIGITS = 8;

  function digitsToParts(digits) {
    digits = String(digits || '').replace(/\D/g, '').slice(-MAX_DIGITS);
    if (!digits) return { h: 0, m: 0, s: 0 };
    const ss = digits.slice(-2);
    const mm = digits.slice(-4, -2);
    const hh = digits.slice(0, -4);
    return {
      s: ss ? parseInt(ss, 10) : 0,
      m: mm ? parseInt(mm, 10) : 0,
      h: hh ? parseInt(hh, 10) : 0,
    };
  }

  function partsToMs(parts) {
    const { h, m, s } = parts;
    return ((h * 60 + m) * 60 + s) * 1000;
  }

  // Canonical display: always HH:MM:SS with zero-padding. Matches the
  // running timer's display so the user sees the same shape everywhere.
  function partsToDisplay(parts) {
    const hh = String(parts.h).padStart(2, '0');
    const mm = String(parts.m).padStart(2, '0');
    const ss = String(parts.s).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function partsValid(parts) {
    return (
      Number.isFinite(parts.h) && parts.h >= 0 &&
      Number.isFinite(parts.m) && parts.m >= 0 && parts.m < 60 &&
      Number.isFinite(parts.s) && parts.s >= 0 && parts.s < 60
    );
  }

  // Convert an arbitrary user input string to milliseconds, or null if it
  // can't be parsed. Accepts both colon-formatted ("1:30:00", "30:00") and
  // bare digits ("3000").
  function parseToMs(input) {
    const s = String(input == null ? '' : input).trim();
    if (s === '') return 0;

    if (s.includes(':')) {
      const segs = s.split(':');
      if (segs.length < 1 || segs.length > 3) return null;
      const nums = segs.map((p) => (p === '' ? 0 : Number(p)));
      if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
      let h = 0, m = 0, sec = 0;
      if (nums.length === 3) [h, m, sec] = nums;
      else if (nums.length === 2) [m, sec] = nums;
      else [sec] = nums;
      if (!partsValid({ h, m, s: sec })) return null;
      return partsToMs({ h, m, s: sec });
    }

    // Bare digits path. Anything non-digit is rejected (no decimals — we
    // don't want "1.5" silently interpreted as 1 hour 30 min, which is a
    // different mental model from the digit-buffer one).
    if (!/^\d+$/.test(s)) return null;
    const parts = digitsToParts(s);
    if (!partsValid(parts)) return null;
    return partsToMs(parts);
  }

  function formatMs(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return partsToDisplay({ h, m, s });
  }

  // Convert an existing formatted value or ms to the digit buffer used by
  // the input. We strip leading zeros except the last one so the user can
  // see how many digits they've actually typed.
  function msToDigits(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    // Build from largest non-zero unit downwards so backspace feels natural.
    let buf;
    if (h > 0) buf = `${h}${String(m).padStart(2, '0')}${String(s).padStart(2, '0')}`;
    else if (m > 0) buf = `${m}${String(s).padStart(2, '0')}`;
    else buf = `${s}`;
    return buf;
  }

  /**
   * Attach digit-only, auto-formatting behaviour to an <input>.
   *
   * The input value is rewritten on every keystroke to canonical
   * HH:MM:SS form. The internal "digit buffer" is the input value with
   * colons stripped; backspace just shortens the buffer from the right.
   *
   * options:
   *   initialMs?: number   — seed the input with this duration on attach
   */
  function bindTimeInput(input, options) {
    options = options || {};

    // Seed value
    if (typeof options.initialMs === 'number') {
      input.value = formatMs(options.initialMs);
    } else if (input.value) {
      // Normalise whatever was preset
      const ms = parseToMs(input.value);
      input.value = ms == null ? '00:00:00' : formatMs(ms);
    } else {
      input.value = '00:00:00';
    }

    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');

    function reformat() {
      const digits = input.value.replace(/\D/g, '').slice(-MAX_DIGITS);
      const parts = digitsToParts(digits);
      input.value = partsToDisplay(parts);
      // Keep cursor at the end — easiest UX with right-justified digit buffer.
      try {
        input.setSelectionRange(input.value.length, input.value.length);
      } catch { /* not all input types support selection */ }
    }

    // Block any non-digit single-character key. Allow navigation/edit keys.
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // copy/paste/etc.
      if (e.key.length === 1 && !/^\d$/.test(e.key)) {
        e.preventDefault();
      }
    }

    // 'input' fires after paste / backspace / typing. Reformat from the
    // resulting raw digits.
    function onInput() {
      reformat();
    }

    function onFocus() {
      // Select all so a fresh user type replaces, but for now let the
      // standard "edit a digit buffer by appending/backspacing" pattern
      // work — just place the cursor at the end.
      try {
        input.setSelectionRange(input.value.length, input.value.length);
      } catch { /* */ }
    }

    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('input', onInput);
    input.addEventListener('focus', onFocus);

    // Public accessor: read the parsed ms at any time.
    return {
      getMs() {
        return parseToMs(input.value);
      },
      setMs(ms) {
        input.value = formatMs(ms);
      },
      detach() {
        input.removeEventListener('keydown', onKeyDown);
        input.removeEventListener('input', onInput);
        input.removeEventListener('focus', onFocus);
      },
    };
  }

  root.TaktTime = {
    parseToMs,
    formatMs,
    msToDigits,
    digitsToParts,
    partsToMs,
    partsToDisplay,
    partsValid,
    bindTimeInput,
  };
})(typeof self !== 'undefined' ? self : this);
