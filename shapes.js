// Soft flat shapes, generated from a seed so each day gets its own.
// Tapping them makes them wobble into a slightly different shape.
window.Shapes = (() => {
  const SVG = "http://www.w3.org/2000/svg";
  const DURATION = 900; // tap wobble
  const MORPH = 650; // changing day

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rng(seed) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Points around a circle, pushed in and out a little.
  // turn: where the first point sits; keeping it lets a shape wobble in place.
  function blobPoints(rand, cx, cy, r, n, wobble, turn = rand() * Math.PI * 2) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = turn + (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.35;
      const rr = r * (1 - wobble / 2 + rand() * wobble);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    return pts;
  }

  // Closed Catmull-Rom spline through the points, as cubic Béziers.
  function pathOf(pts) {
    const n = pts.length;
    const f = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    let d = `M${f(pts[0])}`;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${f(c1)} ${f(c2)} ${f(p2)}`;
    }
    return d + "Z";
  }

  // Three overlapping shapes: sand, terracotta, and a small olive accent.
  // The order of rand() calls defines each day's layout: keep it as it is.
  function layout(rand) {
    const shape = (cls, cx, cy, r, n, w) => {
      const s = { cls, cx, cy, r, n, w, turn: rand() * Math.PI * 2 };
      s.pts = blobPoints(rand, cx, cy, r, n, w, s.turn);
      return s;
    };
    const terra = shape("shape-terra", 58 + rand() * 8, 50 + rand() * 6, 34, 6, 0.32);
    const sand = shape("shape-sand", 22 + rand() * 8, 71 + rand() * 5, 20, 5, 0.35);
    const ax = 88 + rand() * 12, ay = 22 + rand() * 14;
    const accent = shape("shape-olive", ax, ay, 9 + rand() * 3, 5, 0.3);
    rand(); // used to pick olive or blush; still drawn so the layout stays the same
    return [sand, terra, accent]; // drawing order
  }

  // Static markup, for places that don't need to move.
  function art(seed) {
    const paths = layout(rng(hash(seed))).map((s) => `<path class="${s.cls}" d="${pathOf(s.pts)}"/>`);
    return `<svg viewBox="0 0 120 100" xmlns="${SVG}">${paths.join("")}</svg>`;
  }

  // Interactive version: draws into `el` and wobbles when tapped.
  function mount(el, seed) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 120 100");
    const blobs = layout(rng(hash(seed))).map((s) => {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("class", s.cls);
      path.setAttribute("d", pathOf(s.pts));
      svg.append(path);
      return { spec: s, pts: s.pts, path };
    });
    el.replaceChildren(svg);
    if (el._shapes) cancelAnimationFrame(el._shapes.frame);
    el._shapes = { svg, blobs, seed, rand: rng(hash(seed) ^ Date.now()), frame: 0 };
    if (!el._shapesBound) {
      el._shapesBound = true;
      el.addEventListener("click", () => poke(el));
    }
  }

  // Shows the shapes for `seed`; if others are already there, they turn into the new ones.
  function show(el, seed) {
    const st = el._shapes;
    if (!st) return mount(el, seed);
    if (st.seed === seed) return;
    const next = layout(rng(hash(seed)));
    const tweens = st.blobs.map((b, i) => polarTween(b.pts, b.spec, next[i].pts, next[i]));
    st.blobs.forEach((b, i) => {
      b.spec = next[i];
      b.path.setAttribute("class", next[i].cls);
    });
    st.seed = seed;
    st.rand = rng(hash(seed) ^ Date.now());
    animate(st, (i, k) => tweens[i](k), MORPH, backOut, 45);
  }

  // Moves each point around its shape's centre (angle and distance) instead of in a
  // straight line, matching every point with the nearest one of the new shape.
  // A straight line can pass through the centre and make a shape vanish for a moment.
  function polarTween(fromPts, fromSpec, toPts, toSpec) {
    const polar = (pts, c) => pts.map(([x, y]) => [Math.atan2(y - c.cy, x - c.cx), Math.hypot(x - c.cx, y - c.cy)]);
    const a = polar(fromPts, fromSpec);
    const b = polar(toPts, toSpec);
    const n = b.length;
    const wrap = (d) => Math.atan2(Math.sin(d), Math.cos(d)); // shortest turn, -π..π
    let shift = 0, best = Infinity;
    for (let s = 0; s < n; s++) {
      let cost = 0;
      for (let j = 0; j < n; j++) cost += wrap(b[(j + s) % n][0] - a[j][0]) ** 2;
      if (cost < best) { best = cost; shift = s; }
    }
    const pairs = a.map((p, j) => {
      const q = b[(j + shift) % n];
      return { a0: p[0], da: wrap(q[0] - p[0]), r0: p[1], dr: q[1] - p[1] };
    });
    return (k) => {
      const cx = fromSpec.cx + (toSpec.cx - fromSpec.cx) * k;
      const cy = fromSpec.cy + (toSpec.cy - fromSpec.cy) * k;
      return pairs.map(({ a0, da, r0, dr }) => {
        const ang = a0 + da * k, r = Math.max(0, r0 + dr * k);
        return [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r];
      });
    };
  }

  // Springy ease that overshoots a little and settles.
  const elastic = (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);
  // Smooth start, a small overshoot at the end.
  const backOut = (t) => {
    const c = 1.4;
    const u = t - 1;
    return 1 + (c + 1) * u * u * u + c * u * u;
  };

  // Runs `at(i, k)` (shape i's points at progress k) over time. The big shape leads and
  // the small ones follow `lag` ms later, so they move like a little group.
  function animate(st, at, duration, ease, lag) {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    cancelAnimationFrame(st.frame);
    const start = performance.now();
    const total = duration + lag * 3;
    const step = (now) => {
      const elapsed = reduce ? total : now - start;
      st.blobs.forEach((b, i) => {
        const delay = i === 1 ? 0 : lag * (i + 1);
        b.pts = at(i, ease(Math.max(0, Math.min(1, (elapsed - delay) / duration))));
        b.path.setAttribute("d", pathOf(b.pts));
      });
      if (elapsed < total) st.frame = requestAnimationFrame(step);
    };
    st.frame = requestAnimationFrame(step);
  }

  function poke(el) {
    const st = el._shapes;
    if (!st) return;
    const from = st.blobs.map((b) => b.pts.map((p) => p.slice()));
    const to = st.blobs.map(({ spec: s }) =>
      // Same place, never bigger: only the outline changes, so the spacing stays as it was.
      blobPoints(st.rand, s.cx, s.cy, s.r * (0.9 + st.rand() * 0.1), s.n, s.w, s.turn + (st.rand() - 0.5) * 0.5)
    );

    st.svg.classList.remove("poke");
    void st.svg.getBoundingClientRect(); // restart the squish
    st.svg.classList.add("poke");
    const lerp = (i, k) => from[i].map((p, j) => [p[0] + (to[i][j][0] - p[0]) * k, p[1] + (to[i][j][1] - p[1]) * k]);
    animate(st, lerp, DURATION, elastic, 70);
  }

  return { art, mount, show, poke };
})();
