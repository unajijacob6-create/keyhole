// The hero: a keyhole drawn with the base58 characters of a live code hash, with a feed inside the
// aperture. One <pre>, textContent only, rAF at ≤ 30 fps, paused when hidden or off-screen,
// final frame only under prefers-reduced-motion. Rules: docs/DESIGN.md §2 "Motion".
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ASPECT = 1.75; // row height / column width for line-height 1.05 at 0.6em advance

interface Grid {
  cols: number;
  rows: number;
  /** 0 = outside, 1 = plate (hash characters), 2 = aperture */
  mask: Uint8Array;
  /** Rows (with start col and width) inside the circle that hold feed lines. */
  feedRows: { row: number; start: number; width: number }[];
}

export function buildGrid(cols: number): Grid {
  const big = cols >= 60;
  const R = big ? 20 : 12.5; // aperture circle radius, in columns
  const cy = Math.ceil(R / ASPECT) + 3;
  const rows = cy + Math.ceil(R / ASPECT) + (big ? 9 : 7);
  const mask = new Uint8Array(cols * rows);
  const cx = (cols - 1) / 2;
  const slotTop = cy + Math.round((R / ASPECT) * 0.55);
  const slotBottom = rows - 3;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Plate: a rounded rectangle with a 1-row / 2-column margin.
      const mx = Math.max(0, Math.abs(c - cx) - (cols / 2 - 2 - 3));
      const my = Math.max(0, (Math.abs(r - (rows - 1) / 2) - (rows / 2 - 1 - 2)) * ASPECT);
      const plate = Math.hypot(mx, my) <= 3 && Math.abs(c - cx) <= cols / 2 - 2 && Math.abs(r - (rows - 1) / 2) <= rows / 2 - 1;
      if (!plate) continue;
      const dx = c - cx;
      const dy = (r - cy) * ASPECT;
      const inCircle = Math.hypot(dx, dy) <= R;
      const t = (r - slotTop) / Math.max(1, slotBottom - slotTop);
      const half = (big ? 6 : 4) + t * (big ? 4 : 2);
      const inSlot = r >= slotTop && r <= slotBottom && Math.abs(dx) <= half;
      mask[r * cols + c] = inCircle || inSlot ? 2 : 1;
    }
  }
  const feedRows: Grid["feedRows"] = [];
  const nLines = big ? 6 : 4;
  for (let i = 0; i < nLines; i++) {
    const row = cy - Math.floor(nLines / 2) + i;
    let start = -1,
      end = -1;
    for (let c = 0; c < cols; c++) if (mask[row * cols + c] === 2) (start = start < 0 ? c : start), (end = c);
    feedRows.push({ row, start: start + 1, width: Math.max(0, end - start - 1) });
  }
  return { cols, rows, mask, feedRows };
}

function fit(line: string, width: number): string {
  return line.length > width ? line.slice(0, Math.max(0, width - 1)) + "…" : line.padEnd(width, " ");
}

export function renderFrame(g: Grid, hash: string, feed: string[], resolveAt: Float32Array | null, t: number, rand: () => number = Math.random): string {
  const out: string[] = [];
  const h = hash || B58;
  let k = 0;
  const feedAt = new Map(g.feedRows.map((f, i) => [f.row, { ...f, text: fit(feed[i] ?? "", f.width) }]));
  for (let r = 0; r < g.rows; r++) {
    let line = "";
    const fr = feedAt.get(r);
    for (let c = 0; c < g.cols; c++) {
      const m = g.mask[r * g.cols + c];
      if (m === 1) {
        const ch = h[k++ % h.length];
        line += resolveAt && t < resolveAt[r * g.cols + c] ? B58[Math.floor(rand() * 58)] : ch;
      } else if (m === 2 && fr && c >= fr.start && c < fr.start + fr.width) {
        line += resolveAt && t < 0.9 ? " " : fr.text[c - fr.start];
      } else line += " ";
    }
    out.push(line.replace(/\s+$/, ""));
  }
  return out.join("\n");
}

export interface Hero {
  setHash(hash: string, label: string): void;
  setFeed(lines: string[]): void;
}

export function mountHero(pre: HTMLPreElement, caption: HTMLElement): Hero {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = matchMedia("(max-width: 480px)");
  let grid = buildGrid(small.matches ? 36 : 72);
  let hash = "";
  let feed: string[] = [];
  let resolveAt: Float32Array | null = null;
  let start = 0;
  let visible = true;
  let raf = 0;
  let last = 0;

  const draw = (now: number) => {
    const t = (now - start) / 1000;
    pre.textContent = renderFrame(grid, hash, feed, resolveAt, t);
    if (resolveAt && t > 1.2) resolveAt = null;
  };
  const loop = (now: number) => {
    raf = 0;
    if (!visible || document.hidden) return;
    if (now - last >= 1000 / 30) {
      last = now;
      draw(now);
    }
    if (resolveAt) raf = requestAnimationFrame(loop);
  };
  const kick = () => {
    if (reduce) return draw(performance.now());
    if (!raf) raf = requestAnimationFrame(loop);
  };
  const animateIn = () => {
    if (reduce) {
      resolveAt = null;
      return draw(performance.now());
    }
    resolveAt = new Float32Array(grid.cols * grid.rows);
    for (let i = 0; i < resolveAt.length; i++) resolveAt[i] = Math.random() * 1.0;
    start = performance.now();
    kick();
  };
  small.addEventListener("change", () => {
    grid = buildGrid(small.matches ? 36 : 72);
    draw(performance.now());
  });
  new IntersectionObserver((e) => {
    visible = e[0].isIntersecting;
    if (visible) kick();
  }).observe(pre);
  document.addEventListener("visibilitychange", () => !document.hidden && kick());
  draw(performance.now());
  return {
    setHash(h, label) {
      const first = !hash;
      hash = h;
      caption.textContent = `Characters: code hash ${h.slice(0, 8)}… of ${label}, fetched live from mainnet.`;
      if (first) animateIn();
      else draw(performance.now());
    },
    setFeed(lines) {
      feed = lines;
      if (!resolveAt) draw(performance.now());
    },
  };
}
