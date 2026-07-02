// app/captions.js — creator-supplied caption import (WebVTT). Pure, DOM-free
// model: parsed caption cues live ON THE EPISODE (episode.captions), so switching
// Split/Stack/Spotlight or applying a saved template keeps the captions attached
// and rendered over the new layout. The preview draws the active cue straight
// onto the stage canvas each frame, and because export records that same canvas,
// captions are burned into the exported video at the same cue times. This module
// only IMPORTS a user-provided .vtt file — no automatic transcription, no speaker
// diarization, no caption-style editing (all out of scope for this step).
// Classic script — exposed on window.PDC.captions.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  // Parse a single WebVTT timestamp ("HH:MM:SS.mmm" or "MM:SS.mmm", with "." or
  // "," as the millisecond separator) into seconds. Returns NaN when it is not a
  // valid timestamp so the caller can skip a malformed cue rather than trust it.
  function parseTimestamp(raw) {
    const s = String(raw == null ? "" : raw).trim();
    const m = s.match(/^(?:(\d+):)?([0-5]?\d):([0-5]\d)(?:[.,](\d{1,3}))?$/);
    if (!m) return NaN;
    const hh = m[1] ? Number(m[1]) : 0;
    const mm = Number(m[2]);
    const ss = Number(m[3]);
    const ms = m[4] ? Number((m[4] + "00").slice(0, 3)) : 0;
    return hh * 3600 + mm * 60 + ss + ms / 1000;
  }

  // Parse WebVTT text into ordered, validated cues: [{ start, end, text }].
  // Blank-line-separated blocks; a block is a cue when it contains a "-->"
  // timing line (header "WEBVTT" and "NOTE"/"STYLE"/"REGION" blocks have none
  // and are skipped). Cue settings after the end timestamp (align:, line:, ...)
  // and simple inline tags (<b>, <c.classname>) are stripped. Cues with an
  // unparseable time or end<=start are dropped rather than shown at the wrong
  // moment. Never throws — malformed input yields whatever valid cues remain.
  function parseVtt(text) {
    const raw = String(text == null ? "" : text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const blocks = raw.split(/\n{2,}/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split("\n");
      const timingIdx = lines.findIndex((l) => l.indexOf("-->") !== -1);
      if (timingIdx === -1) continue;
      const parts = lines[timingIdx].split("-->");
      if (parts.length < 2) continue;
      const start = parseTimestamp(parts[0]);
      const end = parseTimestamp((parts[1].trim().split(/\s+/)[0]) || "");
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const cueText = lines
        .slice(timingIdx + 1)
        .join("\n")
        .replace(/<[^>]+>/g, "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!cueText) continue;
      cues.push({ start, end, text: cueText });
    }
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    return cues;
  }

  function setCaptions(episode, name, cues) {
    episode.captions = {
      name: String(name == null ? "captions.vtt" : name).trim() || "captions.vtt",
      cues: Array.isArray(cues) ? cues.slice() : [],
    };
    return episode.captions;
  }

  function clearCaptions(episode) {
    episode.captions = null;
    return episode;
  }

  function getCaptions(episode) {
    return (episode && episode.captions) || null;
  }

  function hasCaptions(episode) {
    const c = getCaptions(episode);
    return !!(c && c.cues && c.cues.length);
  }

  // Parse + attach a .vtt file's text to the episode in one call. Returns
  // { ok, count } on success or { ok:false, error } (leaving any existing
  // captions untouched) when the file holds no usable cues.
  function importVtt(episode, name, text) {
    const cues = parseVtt(text);
    if (!cues.length) {
      return { ok: false, count: 0, error: "No caption cues found — upload a valid WebVTT (.vtt) file." };
    }
    setCaptions(episode, name, cues);
    return { ok: true, count: cues.length };
  }

  // Cues scheduled over time t (seconds): start inclusive, end exclusive — a
  // 0:00–0:03 cue is visible at exactly 0.0 and gone at exactly 3.0. Mirrors the
  // moments [start, end) convention so both read consistently on the timeline.
  function activeCues(episode, tSeconds) {
    if (!hasCaptions(episode)) return [];
    const t = Number(tSeconds);
    if (!Number.isFinite(t)) return [];
    return episode.captions.cues.filter((c) => t >= c.start && t < c.end);
  }

  // The caption text to display at time t: active cues joined line-by-line
  // (usually one cue), or "" when nothing is scheduled at that moment.
  function activeText(episode, tSeconds) {
    return activeCues(episode, tSeconds)
      .map((c) => c.text)
      .join("\n");
  }

  PDC.captions = {
    parseTimestamp,
    parseVtt,
    setCaptions,
    clearCaptions,
    getCaptions,
    hasCaptions,
    importVtt,
    activeCues,
    activeText,
  };
})();
