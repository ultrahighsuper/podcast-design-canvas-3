// app/editor.js — the custom-layout editor. Renders one draggable, resizable
// frame per assigned speaker AND per non-video design layer (shape / title) as
// absolutely-positioned overlays on top of the composed canvas. Positions are
// kept in PERCENT of the stage so they map back to the same rects/layers the
// preview and export consume. Each drag/resize/z-change/add/remove reports the
// new rects + layers via onChange, which the app feeds to the live preview as a
// draft layout. Classic script on window.PDC.editor.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  function createEditor(opts) {
    const overlay = opts.overlayEl;
    const onChange = opts.onChange || function () {};
    let rects = {}; // bucket -> {x,y,w,h} in percent
    let layers = []; // [{ id, kind, x, y, w, h, z, color, text }]
    let layerSeq = 0;
    let open = false;

    function emit() {
      onChange(
        JSON.parse(JSON.stringify(rects)),
        layers.map(function (l) { return Object.assign({}, l); }),
      );
    }

    function clampRect(r) {
      let w = Math.max(8, Math.min(100, r.w));
      let h = Math.max(8, Math.min(100, r.h));
      let x = Math.max(0, Math.min(100 - w, r.x));
      let y = Math.max(0, Math.min(100 - h, r.y));
      return { x, y, w, h };
    }

    function place(frame, r) {
      frame.style.left = r.x + "%";
      frame.style.top = r.y + "%";
      frame.style.width = r.w + "%";
      frame.style.height = r.h + "%";
    }

    // Generic drag/resize wiring for any frame backed by a {x,y,w,h} model,
    // read via getRect and written via setRect. Used by both speaker frames and
    // layer frames so they behave identically.
    function attachDrag(frame, handle, getRect, setRect) {
      function startDrag(mode, e) {
        e.preventDefault();
        e.stopPropagation();
        const start = { x: e.clientX, y: e.clientY };
        const base = getRect();
        const b = { x: base.x, y: base.y, w: base.w, h: base.h };
        const W = overlay.clientWidth || 1;
        const H = overlay.clientHeight || 1;
        function move(ev) {
          const dxp = ((ev.clientX - start.x) / W) * 100;
          const dyp = ((ev.clientY - start.y) / H) * 100;
          const next = mode === "resize"
            ? clampRect({ x: b.x, y: b.y, w: b.w + dxp, h: b.h + dyp })
            : clampRect({ x: b.x + dxp, y: b.y + dyp, w: b.w, h: b.h });
          setRect(next);
          place(frame, next);
          emit();
        }
        function up() {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          emit();
        }
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      }
      frame.addEventListener("mousedown", function (e) {
        if (e.target === handle) return;
        if (e.target.closest && (e.target.closest(".edit-frame-tools") || e.target.closest(".edit-layer-tools"))) return;
        startDrag("move", e);
      });
      handle.addEventListener("mousedown", function (e) { startDrag("resize", e); });
    }

    function buildSpeakerFrame(bucket, initialRect, labelFor) {
      rects[bucket] = clampRect(initialRect || { x: 0, y: 0, w: 50, h: 50 });
      const frame = document.createElement("div");
      frame.className = "edit-frame";
      frame.dataset.frameBucket = bucket;
      place(frame, rects[bucket]);
      const tag = document.createElement("span");
      tag.className = "edit-frame-label";
      tag.textContent = labelFor ? labelFor(bucket) : bucket;
      frame.appendChild(tag);
      const handle = document.createElement("span");
      handle.className = "edit-frame-resize";
      handle.dataset.resizeBucket = bucket;
      frame.appendChild(handle);

      // Click-based nudge controls so a frame can be positioned/resized without a
      // freeform drag gesture (drag/resize still work for fine control).
      const tools = document.createElement("div");
      tools.className = "edit-frame-tools";
      const STEP = 8;
      const buttons = [
        ["left", "◀", -STEP, 0, 0, 0],
        ["right", "▶", STEP, 0, 0, 0],
        ["up", "▲", 0, -STEP, 0, 0],
        ["down", "▼", 0, STEP, 0, 0],
        ["smaller", "－", 0, 0, -STEP, -STEP],
        ["larger", "＋", 0, 0, STEP, STEP],
      ];
      buttons.forEach(function (b) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "edit-nudge";
        btn.dataset.nudge = bucket + ":" + b[0];
        btn.textContent = b[1];
        btn.setAttribute("aria-label", b[0] + " " + bucket);
        btn.addEventListener("mousedown", function (e) { e.stopPropagation(); });
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          const cur = rects[bucket];
          rects[bucket] = clampRect({ x: cur.x + b[2], y: cur.y + b[3], w: cur.w + b[4], h: cur.h + b[5] });
          place(frame, rects[bucket]);
          emit();
        });
        tools.appendChild(btn);
      });
      frame.appendChild(tools);

      attachDrag(frame, handle,
        function () { return rects[bucket]; },
        function (r) { rects[bucket] = r; });
      overlay.appendChild(frame);
    }

    function buildLayerFrame(layer) {
      const frame = document.createElement("div");
      frame.className = "edit-frame edit-layer edit-layer-" + layer.kind;
      frame.dataset.layerId = layer.id;
      frame.dataset.layerKind = layer.kind;
      if (layer.kind === "shape") frame.style.background = layer.color;
      place(frame, layer);
      const tag = document.createElement("span");
      tag.className = "edit-frame-label";
      tag.textContent = layer.kind === "title" ? "Title layer" : "Shape layer";
      frame.appendChild(tag);
      const handle = document.createElement("span");
      handle.className = "edit-frame-resize";
      frame.appendChild(handle);

      const tools = document.createElement("div");
      tools.className = "edit-layer-tools";
      const zbtn = document.createElement("button");
      zbtn.type = "button";
      zbtn.className = "edit-layer-z";
      zbtn.dataset.layerZ = layer.id;
      function syncZ() {
        zbtn.textContent = layer.z < 0 ? "Behind" : "Front";
        zbtn.setAttribute("aria-label", (layer.z < 0 ? "Bring in front of speakers: " : "Send behind speakers: ") + layer.id);
        frame.dataset.layerZ = layer.z < 0 ? "behind" : "front";
      }
      syncZ();
      zbtn.addEventListener("mousedown", function (e) { e.stopPropagation(); });
      zbtn.addEventListener("click", function (e) {
        e.stopPropagation();
        layer.z = layer.z < 0 ? 1 : -1;
        syncZ();
        emit();
      });
      tools.appendChild(zbtn);

      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "edit-layer-remove";
      rm.dataset.layerRemove = layer.id;
      rm.textContent = "✕";
      rm.setAttribute("aria-label", "Remove layer " + layer.id);
      rm.addEventListener("mousedown", function (e) { e.stopPropagation(); });
      rm.addEventListener("click", function (e) {
        e.stopPropagation();
        const i = layers.indexOf(layer);
        if (i !== -1) layers.splice(i, 1);
        frame.remove();
        emit();
      });
      tools.appendChild(rm);
      frame.appendChild(tools);

      attachDrag(frame, handle,
        function () { return { x: layer.x, y: layer.y, w: layer.w, h: layer.h }; },
        function (r) { layer.x = r.x; layer.y = r.y; layer.w = r.w; layer.h = r.h; });
      overlay.appendChild(frame);
    }

    // Add a new non-video layer with sensible defaults for its kind. A shape
    // starts BEHIND the speakers (a background/accent block); a title starts in
    // FRONT (a caption/title placeholder over the video). Both are editable.
    function addLayer(kind) {
      kind = kind === "title" ? "title" : "shape";
      const isTitle = kind === "title";
      const layer = {
        id: "layer-" + ++layerSeq,
        kind,
        x: isTitle ? 18 : 8,
        y: isTitle ? 10 : 14,
        w: isTitle ? 64 : 42,
        h: isTitle ? 16 : 34,
        z: isTitle ? 1 : -1,
        color: isTitle ? "#0b1020" : "#ff2d95",
        text: isTitle ? "Title" : "",
      };
      layers.push(layer);
      buildLayerFrame(layer);
      emit();
      return layer;
    }

    function buildSpeakers(buckets, initialRects, labelFor) {
      buckets.forEach(function (bucket, i) {
        buildSpeakerFrame(bucket, initialRects[i], labelFor);
      });
    }

    function buildLayers(initialLayers) {
      (initialLayers || []).forEach(function (l) {
        const layer = {
          id: "layer-" + ++layerSeq,
          kind: l.kind === "title" ? "title" : "shape",
          x: l.x, y: l.y, w: l.w, h: l.h,
          z: Number.isFinite(Number(l.z)) ? Number(l.z) : l.kind === "title" ? 1 : -1,
          color: typeof l.color === "string" ? l.color : l.kind === "title" ? "#0b1020" : "#ff2d95",
          text: l.kind === "title" ? (l.text || "Title") : "",
        };
        layers.push(layer);
        buildLayerFrame(layer);
      });
    }

    return {
      open: function (buckets, initialRects, labelFor, initialLayers) {
        open = true;
        overlay.hidden = false;
        overlay.innerHTML = "";
        rects = {};
        layers = [];
        layerSeq = 0;
        buildSpeakers(buckets, initialRects, labelFor);
        buildLayers(initialLayers);
        emit();
      },
      close: function () {
        open = false;
        overlay.hidden = true;
        overlay.innerHTML = "";
        layers = [];
      },
      isOpen: function () {
        return open;
      },
      addLayer: addLayer,
      getRects: function () {
        return JSON.parse(JSON.stringify(rects));
      },
      getLayers: function () {
        return layers.map(function (l) { return Object.assign({}, l); });
      },
    };
  }

  PDC.editor = { createEditor };
})();
