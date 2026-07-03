// app/captions.js — import a creator-supplied transcript (WebVTT or SRT) and turn
// each timed cue into a real timed CAPTION MOMENT in the existing visual-moments
// system (app/moments.js). Captions are therefore listed in the moments list,
// rendered onto the stage canvas, persisted across preset/template switches, and
// burned into the exported video by exactly the same path as manual title/
// callout/b-roll moments — there is no separate caption pipeline. Pure, DOM-free
// parsing: no network, no automatic transcription. Classic script — exposed on
// window.PDC.captions. Loads after app/moments.js so PDC.moments is available.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  // Parse one WebVTT/SRT timestamp ("hh:mm:ss.mmm" or "mm:ss.mmm"; hours and
  // milliseconds optional, comma tolerated for millis as SRT uses). -> seconds/NaN.
  function parseTimestamp(raw) {
    const s = String(raw == null ? "" : raw).trim();
    const m = s.match(/^(?:(\d+):)?([0-5]?\d):([0-5]\d)(?:[.,](\d{1,3}))?$/);
    if (!m) return NaN;
    const h = m[1] ? Number(m[1]) : 0;
    const min = Number(m[2]);
    const sec = Number(m[3]);
    const ms = m[4] ? Number((m[4] + "00").slice(0, 3)) : 0;
    return h * 3600 + min * 60 + sec + ms / 1000;
  }

  // Strip inline caption markup (<b>, <i>, <c.classname>, <00:00:01.000> timing
  // tags, &amp; entities) down to plain readable text for canvas rendering.
  function stripCueMarkup(text) {
    return String(text)
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .trim();
  }

  // Parse a WebVTT or SRT transcript into { cues: [{start, end, text}], error }.
  // Deliberately lenient so real files load: a leading UTF-8 BOM is stripped, a
  // WEBVTT header is optional (SRT and headerless cue lists parse), the header
  // may share a block with the first cue, cue settings after the end time
  // (line:85% align:center …) are ignored, and NOTE/STYLE/REGION blocks and
  // numeric/identifier lines are skipped. `error` is set only when no usable
  // timed cue can be found at all.
  function parseTranscript(input) {
    // Strip a leading UTF-8 BOM (﻿) and normalize line endings.
    const raw = String(input == null ? "" : input).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const hadHeader = /^\s*WEBVTT\b/.test(raw);
    const blocks = raw.split(/\n[ \t]*\n/);
    const cues = [];
    for (const block of blocks) {
      let lines = block.split("\n").map((l) => l.replace(/\s+$/, ""));
      if (lines.length && /^\s*WEBVTT\b/.test(lines[0])) lines = lines.slice(1);
      if (!lines.length) continue;
      const head = (lines[0] || "").trim();
      if (/^NOTE\b/.test(head) || /^STYLE\b/.test(head) || /^REGION\b/.test(head)) continue;
      const timingIdx = lines.findIndex((l) => l.indexOf("-->") !== -1);
      if (timingIdx === -1) continue;
      const parts = lines[timingIdx].split("-->");
      if (parts.length < 2) continue;
      const start = parseTimestamp(parts[0]);
      const end = parseTimestamp((parts[1].trim().split(/[ \t]+/)[0]) || "");
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const text = stripCueMarkup(lines.slice(timingIdx + 1).join("\n"));
      if (!text) continue;
      cues.push({ start, end, text });
    }
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    if (!cues.length) {
      return {
        cues: [],
        error: hadHeader
          ? "No caption cues were found in that WebVTT file."
          : "That text is not a valid WebVTT/SRT caption file (no timed cues like 00:00:00.000 --> 00:00:03.000 were found).",
      };
    }
    return { cues, error: "" };
  }

  // Caption moments currently on the episode, in start order.
  function captionMoments(episode) {
    const M = PDC.moments;
    return M ? M.listMoments(episode).filter((m) => m.type === "caption") : [];
  }

  // --- Social-context spelling correction --------------------------------
  // Speaker/person names entered via social links are the best cheap signal we
  // have for how names in a transcript SHOULD be spelled. We use them to fix
  // obvious misspellings of those names in imported caption text — no network,
  // no third-party accounts, just the derived handles the creator already gave.

  // Classic Levenshtein edit distance (insert/delete/substitute), used to decide
  // whether a transcript word is a close misspelling of a known name.
  function levenshtein(a, b) {
    a = String(a); b = String(b);
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[n];
  }

  // Make a corrected name echo the misspelled token's capitalization: ALL CAPS
  // stays all caps, a Leading-cap token gets a leading-cap name, else lowercase.
  function matchCase(token, name) {
    if (token.length > 1 && token === token.toUpperCase() && token !== token.toLowerCase()) {
      return name.toUpperCase();
    }
    const first = token.charAt(0);
    if (first !== first.toLowerCase() && first === first.toUpperCase()) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    return name;
  }

  // Candidate name spellings from one handle: the whole alpha handle plus any
  // camelCase / separator sub-words (e.g. "sarah-chen", "sarahChen" -> "sarah",
  // "chen", and "sarahchen"). Only tokens of length >= 3 are usable targets.
  function nameCandidatesFromHandle(handle) {
    const h = String(handle || "");
    const out = new Set();
    const whole = h.replace(/[^A-Za-z]/g, "");
    if (whole.length >= 3) out.add(whole);
    const spaced = h.replace(/([a-z])([A-Z])/g, "$1 $2");
    spaced.split(/[^A-Za-z]+/).forEach((p) => { if (p.length >= 3) out.add(p); });
    return [...out];
  }

  // The known speaker/person names for this episode, derived from the social
  // links the creator entered (only buckets that actually have a link). These
  // are the spellings captions should be normalized toward.
  function speakerNames(episode) {
    const E = PDC.episode, P = PDC.presets;
    if (!E || !P || !P.SPEAKER_BUCKETS) return [];
    const set = new Set();
    P.SPEAKER_BUCKETS.forEach((bucket) => {
      const link = E.getSocialLink ? E.getSocialLink(episode, bucket) : "";
      if (!link) return;
      const handle = E.deriveHandle ? E.deriveHandle(link) : "";
      nameCandidatesFromHandle(handle).forEach((n) => set.add(n));
    });
    return [...set];
  }

  // Normalize obvious misspellings of the known names inside a caption string.
  // Each alphabetic word close (small edit distance, bounded by name length) to
  // a known name — but not already correct — is replaced with the correct name,
  // keeping the original word's capitalization. Exact matches and unrelated
  // words are left untouched, so ordinary transcript text is never mangled.
  function correctSpelling(text, names) {
    const list = (names || []).filter((n) => typeof n === "string" && n.length >= 3);
    if (!list.length) return String(text == null ? "" : text);
    return String(text == null ? "" : text).replace(/[A-Za-z][A-Za-z'’]*/g, function (token) {
      const lower = token.toLowerCase();
      let best = null;
      let bestDist = Infinity;
      for (const name of list) {
        const nl = name.toLowerCase();
        if (nl.length < 3) continue;
        if (lower === nl) return token; // already spelled correctly — leave it
        if (Math.abs(lower.length - nl.length) > 2) continue;
        const maxDist = nl.length <= 4 ? 1 : nl.length <= 7 ? 2 : 3;
        const d = levenshtein(lower, nl);
        if (d >= 1 && d <= maxDist && d < bestDist) { best = name; bestDist = d; }
      }
      return best ? matchCase(token, best) : token;
    });
  }

  // Import a WebVTT/SRT transcript as timed CAPTION MOMENTS on the episode.
  // Replaces any previously-imported caption moments (so re-importing is
  // idempotent) but leaves manual title/callout/image moments — and every other
  // piece of episode state (uploaded media, preset, social links) — untouched.
  // Caption text is first normalized against the speaker names derived from the
  // creator's social links, so obvious name misspellings are corrected in the
  // caption moments that drive both the preview and the exported video.
  // On invalid/empty input it changes NOTHING and returns a creator-readable
  // reason, so a bad file can never wipe the creator's work.
  function importCaptionMoments(episode, text) {
    const parsed = parseTranscript(text);
    if (parsed.error || !parsed.cues.length) {
      return { ok: false, count: 0, corrected: 0, error: parsed.error || "No caption cues were found." };
    }
    const M = PDC.moments;
    if (!M) return { ok: false, count: 0, corrected: 0, error: "Moments system unavailable." };
    const names = speakerNames(episode);
    // Only replace previously-imported caption moments; keep all other moments.
    captionMoments(episode).forEach((m) => M.removeMoment(episode, m.id));
    let count = 0;
    let corrected = 0;
    parsed.cues.forEach((c) => {
      const fixed = correctSpelling(c.text, names);
      if (fixed !== c.text) corrected++;
      if (M.addMoment(episode, { type: "caption", text: fixed, start: c.start, end: c.end })) count++;
    });
    return { ok: count > 0, count, corrected, error: count ? "" : "No usable caption cues were found." };
  }

  PDC.captions = {
    parseTimestamp,
    parseTranscript,
    captionMoments,
    speakerNames,
    correctSpelling,
    importCaptionMoments,
  };
})();
