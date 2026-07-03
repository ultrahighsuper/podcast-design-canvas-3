// app/preview.js
// Composes the preview on a 16:9 canvas by drawing real uploaded video frames
// (ctx.drawImage) into preset layout rects. Hidden <video> elements decode files;
// the canvas is what users and screenshot-based review see — canvas pixels are
// always captured, unlike raw <video> layers in some headless environments.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const { getPreset } = PDC.presets;

  function createPreview(canvasEl) {
    const ctx = canvasEl.getContext("2d");
    const videos = {};
    const videoHost = document.createElement("div");
    videoHost.setAttribute("aria-hidden", "true");
    videoHost.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
    document.body.appendChild(videoHost);
    let playing = false;
    let rafId = 0;
    let episodeRef = null;
    let referenceTime = 0;

    // Videos flagged data-probing are mid duration-probe (normalizeDuration's
    // bounded seek toward the end). Their currentTime is a probe artifact, so
    // the shared timeline must neither read it nor overwrite it — otherwise one
    // loading speaker can drag every other speaker to its end and wedge there
    // (three tracks arriving in rapid succession from link import hit exactly
    // that race; the probe finishes and re-joins the timeline below).
    function syncReferenceTime() {
      const times = Object.values(videos)
        .filter((video) => !video.dataset.probing)
        .map((video) => video.currentTime)
        .filter((time) => Number.isFinite(time))
        .filter((time) => time > 0);
      if (!times.length) return referenceTime;
      const next = Math.min(...times);
      referenceTime = next;
      return next;
    }

    function seekAll(time) {
      if (!Number.isFinite(time)) return;
      Object.values(videos).forEach((video) => {
        if (video.dataset.probing) return; // rejoins the timeline after its probe
        try {
          video.currentTime = time;
        } catch (error) {
          /* not seekable yet */
        }
      });
    }

    function alignPlayback(time) {
      referenceTime = syncReferenceTime();
      const target = Number.isFinite(time) ? Math.min(referenceTime, time) : referenceTime;
      seekAll(target);
      return target;
    }

    function ensureVideo(bucket) {
      let v = videos[bucket];
      if (!v) {
        v = document.createElement("video");
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.setAttribute("playsinline", "");
        v.preload = "auto";
        v.dataset.speaker = bucket;
        v.addEventListener("loadeddata", drawFrame);
        v.addEventListener("canplay", drawFrame);
        videoHost.appendChild(v);
        videos[bucket] = v;
      }
      return v;
    }

    // Recorded WebM (e.g. MediaRecorder output) can report Infinity duration
    // until the element is nudged to its end once. Resolving a real duration
    // lets the scrub bar span the episode and lets export record a full pass.
    // Every path here is bounded — a stuck probe-seek can never wedge loading.
    function normalizeDuration(v, then) {
      if (isFinite(v.duration)) {
        then();
        return;
      }
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        v.removeEventListener("durationchange", onChange);
        try {
          v.currentTime = 0;
        } catch (e) {
          /* not seekable */
        }
        then();
      }
      function onChange() {
        if (isFinite(v.duration)) finish();
      }
      v.addEventListener("durationchange", onChange);
      setTimeout(finish, 3000);
      try {
        v.currentTime = 1e7;
      } catch (e) {
        finish();
      }
    }

    function setSource(bucket, file) {
      return applySource(bucket, URL.createObjectURL(file), true);
    }

    // Same pipeline as setSource, but the <video> loads the URL directly instead
    // of an object URL — used by link import when running over file://, where
    // fetch/XHR cannot read local track bytes but a media subresource load can.
    function setSourceUrl(bucket, url) {
      return applySource(bucket, url, false);
    }

    function applySource(bucket, url, isObjectUrl) {
      const v = ensureVideo(bucket);
      if (v.dataset.objectUrl) URL.revokeObjectURL(v.dataset.objectUrl);
      if (isObjectUrl) v.dataset.objectUrl = url;
      else delete v.dataset.objectUrl;
      // Keep this video off the shared timeline until its duration probe is done
      // — see syncReferenceTime/seekAll. Cleared in the continuation below.
      v.dataset.probing = "1";
      v.src = url;
      v.load();
      v.addEventListener(
        "loadeddata",
        function seekFirstFrame() {
          v.removeEventListener("loadeddata", seekFirstFrame);
          normalizeDuration(v, function () {
            delete v.dataset.probing;
            // Join the shared timeline wherever the other speakers currently are
            // (0 when nothing is playing yet), regardless of where the duration
            // probe happened to leave this element.
            const t = Math.max(0, syncReferenceTime());
            try {
              v.currentTime = t;
            } catch (e) {
              /* not seekable yet */
            }
            drawFrame();
            if (playing) {
              const p = v.play();
              if (p && typeof p.catch === "function") p.catch(function () {});
            }
          });
        },
        { once: true },
      );
      return v;
    }

    function clear(bucket) {
      const v = videos[bucket];
      if (v) {
        if (v.dataset.objectUrl) URL.revokeObjectURL(v.dataset.objectUrl);
        v.remove();
      }
      delete videos[bucket];
    }

    function drawFrame() {
      if (!episodeRef) return;
      const buckets = PDC.episode.assignedBuckets(episodeRef);
      const rects = PDC.templates
        ? PDC.templates.resolveLayout(episodeRef, buckets.length)
        : (getPreset(episodeRef.presetId) || PDC.presets.PRESETS[0]).layout(buckets.length);
      const w = canvasEl.width;
      const h = canvasEl.height;
      const layers = PDC.templates && PDC.templates.resolveLayers ? PDC.templates.resolveLayers(episodeRef) : [];

      ctx.fillStyle = "#05070c";
      ctx.fillRect(0, 0, w, h);

      // Non-video layers with z < 0 render BEHIND the speaker videos (backgrounds
      // and accent blocks); layers with z >= 0 render ABOVE them (framing, title
      // placeholders). Export records this same canvas, so saved layers burn in.
      layers.filter(function (l) { return l.z < 0; }).forEach(function (l) { drawLayer(l, w, h); });

      buckets.forEach(function (bucket, i) {
        const rect = rects[i] || rects[rects.length - 1];
        const x = (rect.x / 100) * w;
        const y = (rect.y / 100) * h;
        const rw = (rect.w / 100) * w;
        const rh = (rect.h / 100) * h;
        const v = videos[bucket];

        ctx.fillStyle = "#000";
        ctx.fillRect(x, y, rw, rh);

        // Clip each speaker to its layout rect so cover-scaled frames cannot bleed
        // into neighboring rows (Stack) or outside their PiP inset (Spotlight).
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, rw, rh);
        ctx.clip();

        if (v && v.videoWidth > 0) {
          const scale = Math.max(rw / v.videoWidth, rh / v.videoHeight);
          const dw = v.videoWidth * scale;
          const dh = v.videoHeight * scale;
          const dx = x + (rw - dw) / 2;
          const dy = y + (rh - dh) / 2;
          ctx.drawImage(v, dx, dy, dw, dh);
        }
        ctx.restore();

        // Spotlight guest feeds are small insets — a light frame makes them read
        // as clearly subordinate picture-in-picture overlays on the host frame.
        if (rw < w * 0.75 && rh < h * 0.75) {
          ctx.strokeStyle = "rgba(255,255,255,0.88)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, rw - 2, rh - 2);
        }

        const label = PDC.episode.speakerName(episodeRef, bucket);
        if (label) {
          ctx.fillStyle = "rgba(8,10,16,0.72)";
          ctx.fillRect(x + 8, y + rh - 28, Math.min(rw - 16, label.length * 9 + 20), 22);
          ctx.fillStyle = "#fff";
          ctx.font = "600 14px system-ui, sans-serif";
          ctx.fillText(label, x + 14, y + rh - 12);
        }
      });

      layers.filter(function (l) { return l.z >= 0; }).forEach(function (l) { drawLayer(l, w, h); });

      drawActiveMoments(w, h);

      canvasEl.dataset.preset = episodeRef.presetId;
      canvasEl.dataset.speakers = String(buckets.length);
      canvasEl.dataset.layers = String(layers.length);
      canvasEl.dataset.caption = (PDC.moments &&
        PDC.moments.activeMoments(episodeRef, referenceTime).some(function (m) { return m.type === "caption"; }))
        ? "1" : "0";
    }

    // A reusable non-video design layer from the selected custom template: a
    // solid "shape" color block, or a "title" placeholder box with text. Drawn
    // in stage-percent geometry so it lands identically in preview and export.
    function drawLayer(layer, w, h) {
      const x = (layer.x / 100) * w;
      const y = (layer.y / 100) * h;
      const rw = (layer.w / 100) * w;
      const rh = (layer.h / 100) * h;
      if (layer.kind === "title") {
        ctx.fillStyle = layer.color || "#0b1020";
        ctx.globalAlpha = 0.86;
        ctx.fillRect(x, y, rw, rh);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, rw - 2, rh - 2);
        const text = layer.text || "Title";
        ctx.fillStyle = "#ffffff";
        ctx.font = "700 " + Math.max(14, Math.round(rh * 0.46)) + "px system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(text, x + Math.round(w * 0.012), y + rh / 2, rw - Math.round(w * 0.024));
      } else {
        ctx.fillStyle = layer.color || "#ff2d95";
        ctx.fillRect(x, y, rw, rh);
      }
    }

    // Timed visual moments are painted straight onto the stage canvas, over the
    // composed layout, ONLY while the reference playback time is inside their
    // scheduled [start, end) range. Because export records this same canvas,
    // whatever is drawn here is burned into the exported video at the same
    // times. Solid backing bars keep the text legible in screenshots over any
    // preset (Split / Stack / Spotlight) or custom template.
    function drawActiveMoments(w, h) {
      if (!PDC.moments || !episodeRef) return;
      const active = PDC.moments.activeMoments(episodeRef, referenceTime);
      if (!active.length) return;
      ctx.save();
      ctx.textBaseline = "middle";
      active.forEach(function (moment) {
        if (moment.type === "title") drawTitleMoment(moment, w, h);
        else if (moment.type === "callout") drawCalloutMoment(moment, w, h);
        else if (moment.type === "caption") drawCaptionMoment(moment, w, h);
        else drawImageMoment(moment, w, h);
      });
      ctx.restore();
    }

    // Caption: an imported-transcript cue rendered as a centered lower subtitle
    // band (distinct from the left-anchored callout and the top title bar), so a
    // full transcript reads like burned-in captions. Export records this canvas,
    // so caption moments burn into the output at their cue times on any layout.
    function drawCaptionMoment(moment, w, h) {
      const lines = String(moment.text).split("\n").slice(0, 3);
      ctx.save();
      ctx.font = "600 " + Math.round(h * 0.045) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const lineH = Math.round(h * 0.058);
      const padX = Math.round(w * 0.022);
      const padY = Math.round(h * 0.016);
      let maxW = 0;
      lines.forEach(function (ln) { maxW = Math.max(maxW, ctx.measureText(ln).width); });
      const boxW = Math.min(Math.round(w * 0.9), Math.round(maxW) + padX * 2);
      const boxH = lines.length * lineH + padY * 2;
      const boxX = Math.round((w - boxW) / 2);
      const boxY = Math.round(h * 0.9) - boxH; // banner bottom sits at ~0.9h, above speaker tags
      ctx.fillStyle = "rgba(5, 7, 12, 0.82)";
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = "#ffffff";
      lines.forEach(function (ln, i) {
        ctx.fillText(ln, w / 2, boxY + padY + lineH * (i + 0.5), boxW - padX * 2);
      });
      ctx.restore();
    }

    // Episode title: a prominent centered bar across the top of the stage with
    // a dark backing and an accent underline, distinct from speaker labels.
    function drawTitleMoment(moment, w, h) {
      const barX = Math.round(w * 0.07);
      const barY = Math.round(h * 0.055);
      const barW = w - barX * 2;
      const barH = Math.round(h * 0.13);
      ctx.fillStyle = "rgba(5, 7, 12, 0.88)";
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = "#6c8cff";
      ctx.fillRect(barX, barY + barH - Math.max(3, Math.round(h * 0.006)), barW, Math.max(3, Math.round(h * 0.006)));
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 " + Math.round(h * 0.062) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(moment.text, w / 2, barY + barH / 2, barW - Math.round(w * 0.04));
    }

    // Callout / reference: a lower-third banner anchored left with an accent
    // edge — visually distinct from the title bar and from speaker name tags.
    function drawCalloutMoment(moment, w, h) {
      ctx.font = "600 " + Math.round(h * 0.046) + "px system-ui, sans-serif";
      const maxTextW = w * 0.7;
      const textW = Math.min(ctx.measureText(moment.text).width, maxTextW);
      const edgeW = Math.max(5, Math.round(w * 0.006));
      const padX = Math.round(w * 0.018);
      const barX = Math.round(w * 0.045);
      const barY = Math.round(h * 0.76);
      const barH = Math.round(h * 0.105);
      const barW = Math.max(Math.round(textW) + edgeW + padX * 2, Math.round(w * 0.34));
      ctx.fillStyle = "rgba(8, 10, 16, 0.9)";
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = "#8a6cff";
      ctx.fillRect(barX, barY, edgeW, barH);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "left";
      ctx.fillText(moment.text, barX + edgeW + padX, barY + barH / 2, maxTextW);
    }

    // B-roll image: a real uploaded PNG, decoded in app/moment-images.js and
    // drawn as a large centered overlay. Export records this same canvas, so
    // the image burns into the output whenever this draw path is active.
    function drawImageMoment(moment, w, h) {
      if (!PDC.momentImages) return;
      const record = PDC.momentImages.get(moment.id);
      if (!record || !record.image) return;
      const img = record.image;
      const maxW = Math.round(w * 0.56);
      const maxH = Math.round(h * 0.52);
      const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
      const dw = Math.round(img.naturalWidth * scale);
      const dh = Math.round(img.naturalHeight * scale);
      const x = Math.round((w - dw) / 2);
      const y = Math.round(h * 0.18);
      const pad = Math.max(10, Math.round(w * 0.012));
      ctx.fillStyle = "rgba(5, 7, 12, 0.78)";
      ctx.fillRect(x - pad, y - pad, dw + pad * 2, dh + pad * 2);
      ctx.drawImage(img, x, y, dw, dh);
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = Math.max(3, Math.round(w * 0.003));
      ctx.strokeRect(x - 1, y - 1, dw + 2, dh + 2);
    }

    function loop() {
      syncReferenceTime();
      drawFrame();
      rafId = requestAnimationFrame(loop);
    }

    function ensureLoop() {
      if (!rafId) rafId = requestAnimationFrame(loop);
    }

    function stopLoop() {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    }

    function render(episode) {
      episodeRef = episode;
      const buckets = PDC.episode.assignedBuckets(episode);
      if (buckets.length) ensureLoop();
      else {
        stopLoop();
        ctx.fillStyle = "#05070c";
        ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
        canvasEl.dataset.preset = "";
        canvasEl.dataset.speakers = "0";
      }
      drawFrame();
      return buckets.length;
    }

    function play() {
      playing = true;
      const targetTime = alignPlayback(0);
      Object.keys(videos).forEach(function (b) {
        const p = videos[b].play();
        if (p && typeof p.catch === "function") p.catch(function () {});
      });
      ensureLoop();
      if (Number.isFinite(targetTime)) {
        seekAll(targetTime);
      }
    }

    function pause() {
      playing = false;
      syncReferenceTime();
      Object.keys(videos).forEach(function (b) {
        videos[b].pause();
      });
    }

    // Restarting after the preview was left seeked far from 0 (e.g. adding a
    // title/callout moment jumps the timeline into its range to preview it
    // immediately) needs the seek-to-0 to actually land before play() is
    // called — issuing play() while a big seek is still in flight can leave a
    // MediaRecorder-sourced video decoder stuck (readyState never advances
    // past HAVE_CURRENT_DATA, currentTime frozen). Every wait is
    // HARD-BOUNDED so a stuck seek can never wedge restart.
    function restart() {
      referenceTime = 0;
      const vids = Object.values(videos);
      Promise.all(
        vids.map(function (v) {
          return new Promise(function (resolve) {
            let done = false;
            function finish() {
              if (done) return;
              done = true;
              v.removeEventListener("seeked", finish);
              resolve();
            }
            v.addEventListener("seeked", finish);
            setTimeout(finish, 800);
            try {
              v.currentTime = 0;
            } catch (e) {
              finish();
            }
          });
        }),
      ).then(play);
    }

    function setMuted(muted) {
      Object.keys(videos).forEach(function (b) {
        videos[b].muted = muted;
      });
    }

    // Longest known speaker duration — the episode timeline the scrubber spans.
    function getDuration() {
      let longest = 0;
      Object.values(videos).forEach(function (v) {
        if (isFinite(v.duration) && v.duration > longest) longest = v.duration;
      });
      return longest;
    }

    function getTime() {
      return referenceTime;
    }

    // Scrub the shared playback timeline to t seconds. Works while playing or
    // paused; the rAF loop keeps compositing, so timed moments show/hide to
    // match the new time on the very next drawn frame.
    function seekTo(t) {
      if (!Number.isFinite(t) || t < 0) return;
      referenceTime = t;
      seekAll(t);
      drawFrame();
    }

    return {
      setSource,
      setSourceUrl,
      clear,
      render,
      play,
      pause,
      restart,
      setMuted,
      isPlaying: function () {
        return playing;
      },
      getDuration,
      getTime,
      seekTo,
      drawFrame,
    };
  }

  PDC.preview = { createPreview };
})();
