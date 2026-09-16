// 市值 K 线（canvas 自绘），移植自 macOS 版 CandleChart.swift：
// 各分辨率分别缓存，只画当前那档；滚轮以光标为中心缩放，横向滚轮 / 拖动平移，双击复位，悬停十字线；
// 基准虚线 = 首次喊单那根的 open；喊单标记贴在所在蜡烛 low 下方、可点击；底部 18% 画成交量。
// 可见范围变化 → 按当前分辨率（多要一屏、250ms 防抖）向 sidecar 要数据。
(() => {
  const STEP = { "1s": 1, "5s": 5, "15s": 15, "30s": 30, "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "12h": 43200, "1d": 86400 };
  const CHOICES = ["1s", "15s", "30s", "1m", "5m", "15m", "1h", "4h", "1d"];
  const UP = "#3ddc84", DOWN = "#ff5b5b", ACCENT = "#24c47c", FAINT = "#6b777a";
  const PAD = { l: 8, r: 60, t: 10, b: 22 };
  const VOL_FRAC = 0.18, BUBBLE = 16;
  const nowS = () => Date.now() / 1000;

  class CandleChart {
    /** onRequest({resolution, from, to}) 要数据；onCallTap(call) 点了喊单标记 */
    constructor(canvas, { onRequest, onCallTap }) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.onRequest = onRequest;
      this.onCallTap = onCallTap;
      this.klines = new Map();
      this.resolution = "1m";
      this.firstCall = 0;
      this.selectedCall = null;
      this.t0 = 0; this.t1 = 1;
      this.untouched = true; this.follow = true;
      this.hover = null; this.drag = null;
      this.last = null; this.debounce = null;
      this.lastTick = nowS();
      new ResizeObserver(() => this.draw()).observe(canvas);
      canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
      canvas.addEventListener("pointerdown", (e) => this.onDown(e));
      canvas.addEventListener("pointermove", (e) => this.onMove(e));
      canvas.addEventListener("pointerup", (e) => { this.drag = null; canvas.releasePointerCapture?.(e.pointerId); });
      canvas.addEventListener("pointerleave", () => { this.hover = null; this.draw(); });
      canvas.addEventListener("dblclick", () => this.resetRange());
      setInterval(() => this.tick(), 1000);
    }

    get step() { return STEP[this.resolution] || 60; }
    get current() { return this.klines.get(this.resolution) || null; }

    /** 换币 / 链从未知变已知：清空缓存重来 */
    reset(firstCall) {
      this.klines.clear();
      this.firstCall = firstCall || 0;
      this.selectedCall = null;
      this.last = null;
      this.resetRange();
    }

    setResolution(r) {
      if (!STEP[r] || r === this.resolution) return;
      this.resolution = r;
      this.last = null;
      this.resetRange();
    }

    setKline(k) {
      this.klines.set(k.resolution, { bars: k.bars || [], covered: Array.isArray(k.covered) && k.covered.length === 2 ? k.covered : [k.bars?.[0]?.[0] ?? 0, (k.bars?.at(-1)?.[0] ?? 0) + (STEP[k.resolution] || 60)], calls: k.calls || [], error: k.error || null });
      this.fitToData();
      this.draw();
    }

    /** 实时成交推来的一根：同 t 替换，更晚则追加；该档没缓存就忽略（sidecar 只推已缓存档的末端） */
    mergeBar(resolution, bar) {
      const k = this.klines.get(resolution);
      if (!k || !Array.isArray(bar)) return;
      const lastBar = k.bars.at(-1);
      if (lastBar && lastBar[0] === bar[0]) k.bars[k.bars.length - 1] = bar;
      else if (!lastBar || lastBar[0] < bar[0]) k.bars.push(bar);
      else return;
      k.covered = [k.covered[0], Math.max(k.covered[1], bar[0] + (STEP[resolution] || 60))];
      if (resolution === this.resolution) this.draw();
    }

    setSelectedCall(c) { this.selectedCall = c; this.draw(); }

    /** 默认可见：最近 ~80 根到现在；首次喊单在这个窗口附近（≤240 根前）就从喊单前 5 根开始 */
    resetRange() {
      const now = nowS(), step = this.step;
      let start = now - 80 * step;
      if (this.firstCall > 0 && now - this.firstCall <= 240 * step) start = Math.min(start, this.firstCall - 5 * step);
      this.t0 = start;
      this.t1 = now + Math.max((now - start) * 0.03, 2 * step);
      this.untouched = true; this.follow = true; this.lastTick = now;
      this.fitToData();
      this.draw();
      this.request();
    }

    fitToData() {
      const k = this.current, f = k?.bars[0];
      if (!this.untouched || !k || !f || k.covered[0] > this.t0 || f[0] <= this.t0 + (this.t1 - this.t0) * 0.3) return;
      this.t0 = f[0] - 2 * this.step;
    }

    tick() {
      const now = nowS(), dt = now - this.lastTick;
      this.lastTick = now;
      if (!this.follow || dt <= 0) return;
      this.t0 += dt; this.t1 += dt;
      this.draw();
      const k = this.current;
      if (k && k.covered[1] < this.t1 - this.step) this.request();
    }

    request() {
      const step = this.step, span = this.t1 - this.t0;
      const req = { resolution: this.resolution, from: Math.floor((this.t0 - span) / step) * step, to: Math.floor(Math.min(nowS(), this.t1 + step)) };
      const l = this.last;
      if (l && l.resolution === req.resolution && l.from <= req.from && l.to >= req.to - step) return;
      clearTimeout(this.debounce);
      if (!l) { this.last = req; this.onRequest(req); return; }
      this.debounce = setTimeout(() => { this.last = req; this.onRequest(req); }, 250);
    }

    // ---------- 交互 ----------

    local(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    get size() { return { w: this.canvas.clientWidth, h: this.canvas.clientHeight }; }
    get plot() { const { w, h } = this.size; return { x: PAD.l, y: PAD.t, w: Math.max(1, w - PAD.l - PAD.r), h: Math.max(1, h - PAD.t - PAD.b) }; }
    x(t) { const p = this.plot; return p.x + (t - this.t0) / Math.max(this.t1 - this.t0, 1) * p.w; }
    tAt(px) { const p = this.plot; return this.t0 + (px - p.x) / Math.max(p.w, 1) * (this.t1 - this.t0); }

    onWheel(e) {
      e.preventDefault();
      const dx = e.shiftKey ? e.deltaY : e.deltaX, dy = e.shiftKey ? 0 : e.deltaY;
      if (Math.abs(dx) > Math.abs(dy)) this.pan(-dx);
      else if (dy) this.zoom(Math.exp(dy * 0.0015), this.local(e).x);
    }
    onDown(e) {
      const p = this.local(e);
      const hit = this.bubbles().find((b) => Math.abs(b.cx - p.x) <= BUBBLE / 2 + 3 && Math.abs(b.cy - p.y) <= BUBBLE / 2 + 3);
      if (hit) { this.selectedCall = hit.call; this.draw(); this.onCallTap?.(hit.call); return; }
      this.drag = { x: p.x, t0: this.t0, t1: this.t1 };
      this.canvas.setPointerCapture?.(e.pointerId);
    }
    onMove(e) {
      const p = this.local(e);
      if (this.drag) {
        const d = this.drag, dt = (p.x - d.x) / Math.max(this.plot.w, 1) * (d.t1 - d.t0);
        this.t0 = d.t0 - dt; this.t1 = d.t1 - dt;
        this.rangeChanged();
        return;
      }
      this.hover = p;
      const onBubble = this.bubbles().some((b) => Math.abs(b.cx - p.x) <= BUBBLE / 2 + 3 && Math.abs(b.cy - p.y) <= BUBBLE / 2 + 3);
      this.canvas.style.cursor = onBubble ? "pointer" : "crosshair";
      this.draw();
    }
    pan(dxPx) {
      const dt = dxPx / Math.max(this.plot.w, 1) * (this.t1 - this.t0);
      this.t0 -= dt; this.t1 -= dt;
      this.rangeChanged();
    }
    zoom(factor, px) {
      const anchor = this.tAt(px);
      let span = (this.t1 - this.t0) * factor;
      span = Math.min(Math.max(span, 12 * this.step), 400 * this.step);
      const ratio = (anchor - this.t0) / Math.max(this.t1 - this.t0, 1);
      this.t0 = anchor - span * ratio;
      this.t1 = this.t0 + span;
      this.rangeChanged();
    }
    rangeChanged() {
      this.untouched = false;
      const now = nowS(), span = this.t1 - this.t0;
      if (this.t1 > now + span * 0.5) { this.t1 = now + span * 0.5; this.t0 = this.t1 - span; }
      this.follow = this.t1 >= now;
      this.lastTick = now;
      this.draw();
      this.request();
    }

    // ---------- 绘制 ----------

    /** 价格轴：可见蜡烛 + 基准一起定上下界；draw 与标记命中共用 */
    scale() {
      const k = this.current;
      if (!k) return null;
      const step = this.step;
      const vis = k.bars.filter((b) => b[0] + step >= this.t0 && b[0] <= this.t1);
      if (!vis.length) return null;
      let lo = Math.min(...vis.map((b) => b[3])), hi = Math.max(...vis.map((b) => b[2]));
      // 基准 = 首次喊单时刻的 open：当前档没拉到那么早就用覆盖到它的最细一档
      let src = k.covered[0] <= this.firstCall ? { k, step } : null;
      if (!src) for (const [r, kk] of this.klines) if (kk.covered[0] <= this.firstCall && (!src || STEP[r] < src.step)) src = { k: kk, step: STEP[r] };
      const baseBar = src?.k.bars.find((b) => b[0] + src.step > this.firstCall);
      const base = this.firstCall > 0 && baseBar ? baseBar[1] : null;
      if (base != null) { lo = Math.min(lo, base); hi = Math.max(hi, base); }
      const span = Math.max(hi - lo, hi * 0.005, 1e-12);
      lo -= span * 0.06; hi += span * 0.06;
      const p = this.plot, pr = { x: p.x, y: p.y, w: p.w, h: p.h * (1 - VOL_FRAC) - 4 };
      return { vis, lo, hi, base, pr, y: (v) => pr.y + pr.h - (v - lo) / (hi - lo) * pr.h };
    }

    /** 喊单标记位置：挂在所在蜡烛（没有就最近一根）的 low 下方 6px；叠住往下堆 */
    bubbles(s = this.scale()) {
      if (!s) return [];
      const step = this.step, out = [];
      const calls = ((this.current || this.klines.values().next().value)?.calls || []).slice().sort((a, b) => a[0] - b[0]);
      for (const c of calls) {
        if (c[0] < this.t0 || c[0] > this.t1) continue;
        const bar = s.vis.find((b) => b[0] <= c[0] && c[0] < b[0] + step) || s.vis.reduce((m, b) => Math.abs(b[0] - c[0]) < Math.abs(m[0] - c[0]) ? b : m);
        const cx = this.x(bar[0] + step / 2);
        let cy = s.y(bar[3]) + 6 + BUBBLE / 2;
        while (out.some((o) => Math.abs(o.cx - cx) < BUBBLE && Math.abs(o.cy - cy) < BUBBLE)) cy += BUBBLE + 2;
        cy = Math.min(cy, this.plot.y + this.plot.h - BUBBLE / 2);
        out.push({ cx, cy, call: { t: c[0], sender: c[1], group: c[2] } });
      }
      return out;
    }

    draw() {
      const c = this.canvas, dpr = window.devicePixelRatio || 1, { w, h } = this.size;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const k = this.current, step = this.step;
      if (!k) { this.empty("加载 K 线…"); this.xAxis(); return; }
      const s = this.scale();
      if (!s) {
        if (k.error && !k.bars.length) this.empty("K 线拉取失败 · " + k.error);
        else this.empty(k.covered[0] > this.t1 || k.covered[1] < this.t0 ? "加载 K 线…" : "此区间没有成交");
        this.xAxis();
        return;
      }
      const { vis, lo, hi, base, pr, y } = s, p = this.plot;
      ctx.font = "9px 'Cascadia Mono', Consolas, monospace";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 4; i++) {
        const v = lo + (hi - lo) * i / 4, yy = Math.round(y(v)) + 0.5;
        ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pr.x, yy); ctx.lineTo(pr.x + pr.w, yy); ctx.stroke();
        ctx.fillStyle = FAINT; ctx.fillText(fmt.compact(v), pr.x + pr.w + 6, yy);
      }
      this.xAxis();
      if (base != null) {
        ctx.strokeStyle = "rgba(255,255,255,.2)"; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(pr.x, y(base)); ctx.lineTo(pr.x + pr.w, y(base)); ctx.stroke();
        ctx.setLineDash([]);
      }
      const vmax = Math.max(...vis.map((b) => b[5]), 1e-9);
      const bw = Math.max(1, step / Math.max(this.t1 - this.t0, 1) * p.w), body = Math.max(1, bw * 0.7);
      const volTop = p.y + p.h * (1 - VOL_FRAC), volH = p.h * VOL_FRAC;
      ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
      for (const b of vis) {
        const cx = this.x(b[0] + step / 2), col = b[4] >= b[1] ? UP : DOWN;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = Math.max(1, Math.min(1.5, body * 0.15));
        ctx.beginPath(); ctx.moveTo(cx, y(b[2])); ctx.lineTo(cx, y(b[3])); ctx.stroke();
        const top = y(Math.max(b[1], b[4])), bot = y(Math.min(b[1], b[4]));
        ctx.fillRect(cx - body / 2, top, body, Math.max(1, bot - top));
        const vh = b[5] / vmax * volH;
        ctx.globalAlpha = 0.35; ctx.fillRect(cx - body / 2, volTop + volH - vh, body, vh); ctx.globalAlpha = 1;
      }
      ctx.restore();
      this.drawBubbles(s);
      this.drawHover(s);
    }

    drawBubbles(s) {
      const ctx = this.ctx, sel = this.selectedCall;
      for (const b of this.bubbles(s)) {
        const on = sel && sel.t === b.call.t && sel.sender === b.call.sender && sel.group === b.call.group;
        ctx.beginPath(); ctx.arc(b.cx, b.cy, BUBBLE / 2, 0, Math.PI * 2);
        if (on) { ctx.fillStyle = ACCENT; ctx.fill(); }
        else { ctx.fillStyle = "#141618"; ctx.fill(); ctx.strokeStyle = "rgba(36,196,124,.8)"; ctx.lineWidth = 1.2; ctx.stroke(); }
        ctx.fillStyle = on ? "#04140c" : ACCENT;
        ctx.font = "bold 9px 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(String(b.call.sender || "?").slice(0, 1), b.cx, b.cy + 0.5);
        ctx.textAlign = "left";
      }
    }

    drawHover(s) {
      const h = this.hover, p = this.plot, step = this.step;
      if (!h || h.x < p.x || h.x > p.x + p.w || h.y < p.y || h.y > p.y + p.h) return;
      const near = s.vis.reduce((m, b) => Math.abs(this.x(b[0] + step / 2) - h.x) < Math.abs(this.x(m[0] + step / 2) - h.x) ? b : m);
      const ctx = this.ctx, hx = this.x(near[0] + step / 2);
      ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, s.pr.y); ctx.lineTo(hx, p.y + p.h); ctx.moveTo(s.pr.x, h.y); ctx.lineTo(s.pr.x + s.pr.w, h.y); ctx.stroke();
      const d = new Date(near[0] * 1000), two = (n) => String(n).padStart(2, "0");
      const time = step < 60 ? `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` : `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
      const change = s.base ? "  喊后 " + fmt.pct((near[4] / s.base - 1) * 100) : "";
      const text = `O ${fmt.compact(near[1])}  H ${fmt.compact(near[2])}  L ${fmt.compact(near[3])}  C ${fmt.compact(near[4])}${change}  ${time}`;
      ctx.font = "500 10px 'Cascadia Mono', Consolas, monospace";
      const tw = ctx.measureText(text).width;
      const bx = Math.min(Math.max(p.x, hx - tw / 2 - 6), p.x + p.w - tw - 12);
      ctx.fillStyle = "rgba(26,27,31,.96)";
      ctx.beginPath(); ctx.roundRect(bx, p.y + 2, tw + 12, 18, 5); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(text, bx + 6, p.y + 11);
    }

    xAxis() {
      const ctx = this.ctx, p = this.plot, span = this.t1 - this.t0, two = (n) => String(n).padStart(2, "0");
      ctx.font = "9px 'Cascadia Mono', Consolas, monospace"; ctx.fillStyle = FAINT; ctx.textBaseline = "top";
      for (let i = 0; i <= 4; i++) {
        const t = this.t0 + span * i / 4, d = new Date(t * 1000);
        const label = span > 86400 * 2 ? `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}` : span < 600 ? `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` : `${two(d.getHours())}:${two(d.getMinutes())}`;
        const w = ctx.measureText(label).width;
        ctx.fillText(label, Math.min(Math.max(this.x(t) - w / 2, p.x), p.x + p.w - w), p.y + p.h + 6);
      }
    }

    empty(msg) {
      const ctx = this.ctx, { w, h } = this.size;
      ctx.font = "11px 'Segoe UI', sans-serif"; ctx.fillStyle = "rgba(255,255,255,.3)"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(msg, w / 2, h / 2);
      ctx.textAlign = "left";
    }
  }

  window.CandleChart = CandleChart;
  window.CandleChart.CHOICES = CHOICES;
})();
