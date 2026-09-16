// 悬浮窗与详情卡共用的格式化 / 小工具（口径对齐 macOS 版 Model.swift 的 Fmt / FomoFrontRank）
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v) => typeof v === "number" && isFinite(v);

  function compact(v) {
    if (!num(v)) return "—";
    const a = Math.abs(v);
    const f = (x, s) => x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2) + s;
    if (a >= 1e9) return "$" + f(a / 1e9, "B");
    if (a >= 1e6) return "$" + f(a / 1e6, "M");
    if (a >= 1e3) return "$" + f(a / 1e3, "K");
    return "$" + a.toFixed(0);
  }

  function pct(v, approx = false) {
    if (!num(v)) return "—";
    const a = Math.abs(v), arrow = v >= 0 ? "▲" : "▼", pre = approx ? "≈" : "";
    if (a < 100) return pre + arrow + a.toFixed(1) + "%";
    if (a < 1000) return pre + arrow + a.toFixed(0) + "%";
    const x = 1 + v / 100;
    return pre + arrow + (x < 100 ? x.toFixed(1) : x.toFixed(0)) + "x";
  }

  const nowS = () => Date.now() / 1000;
  function ago(ts) {
    const s = Math.max(0, Math.floor(nowS() - Number(ts || 0)));
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.floor(s / 60) + "分钟";
    if (s < 86400) return Math.floor(s / 3600) + "小时";
    return Math.floor(s / 86400) + "天";
  }
  function agoShort(ts) {
    const s = Math.max(0, Math.floor(nowS() - Number(ts || 0)));
    if (s < 60) return s + "秒";
    if (s < 3600) return Math.floor(s / 60) + "分";
    if (s < 86400) return Math.floor(s / 3600) + "时";
    return Math.floor(s / 86400) + "天";
  }
  const clock = (ts) => new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  function followers(n) {
    if (n >= 10000) return (n / 10000).toFixed(1) + "万粉";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K粉";
    return n + "粉";
  }
  function joined(ts) {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}年${d.getMonth() + 1}月加入`;
  }

  const FRONT_RANK_BASIS = "fomo 全站前 50 名持仓合计 ÷ gmgn 前排前 50 名持仓合计（仅排除 pool 地址；燃烧 / 交易所钱包 / dev 保留）";
  function frontRankText(fr) {
    if (!fr || !num(fr.ratio) || !fr.fomo || !fr.gmgn) return "—";
    const r = fr.ratio;
    const p = r >= 10 ? r.toFixed(0) + "x" : (r * 100).toFixed(r >= 1 ? 0 : 1) + "%";
    return fr.fomo.n < 50 || fr.gmgn.n < 50 ? `${p} ·${Math.min(fr.fomo.n, fr.gmgn.n)}` : p;
  }
  function frontRankHelp(fr) {
    if (!fr) return FRONT_RANK_BASIS + "\n还没拿到（焦点币每 15s 刷，主面板行排队刷）";
    const lines = [FRONT_RANK_BASIS];
    if (fr.fomo && fr.gmgn) lines.push(`fomo 前 ${fr.fomo.n} 名 ${compact(fr.fomo.amount)} ÷ gmgn 前 ${fr.gmgn.n} 名 ${compact(fr.gmgn.amount)}` + (fr.gmgn.pools > 0 ? `（跳过 ${fr.gmgn.pools} 个 pool）` : ""));
    if (fr.why) lines.push("不可用：" + fr.why);
    lines.push("更新 " + clock(fr.at));
    return lines.join("\n");
  }
  /** 前排比例配色：≥75% 红 / ≥50% 橙 / ≥25% 琥珀 / 其余灰；没数淡灰 */
  function frontRankClass(ratio) {
    if (!num(ratio)) return "fr-none";
    if (ratio >= 0.75) return "fr-hi";
    if (ratio >= 0.5) return "fr-mid";
    if (ratio >= 0.25) return "fr-lo";
    return "fr-min";
  }

  const CHAIN_NAMES = { robinhood: "RH", bsc: "BSC", sol: "SOL", eth: "ETH", base: "BASE", monad: "MON" };
  const chainOf = (t) => String(t?.market?.chain || t?.chainHint || "").toLowerCase();
  const chainLabel = (c) => CHAIN_NAMES[c] || (c ? c.toUpperCase().slice(0, 4) : "?");
  const shortAddr = (s) => !s ? "—" : s.length < 15 ? s : s.slice(0, 6) + "…" + s.slice(-4);

  /** 由字符串派生的头像渐变（与 Swift Token.avatarColors 同一思路：稳定哈希取色） */
  const PALETTE = [["#19f0a0", "#0b8f63"], ["#6aa8ff", "#3b5bdb"], ["#ffb86b", "#e8590c"], ["#f783ac", "#c2255c"], ["#b197fc", "#6741d9"], ["#63e6be", "#0ca678"], ["#ffd43b", "#f08c00"], ["#74c0fc", "#1c7ed6"]];
  function avatarColors(seed) {
    let h = 0;
    for (const ch of String(seed || "")) h = (h * 31 + ch.codePointAt(0)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
  }
  function avatar(url, seed, size) {
    const [a, b] = avatarColors(seed);
    const letter = esc(String(seed || "?").slice(0, 1).toUpperCase());
    const fallback = `<span class="av" style="width:${size}px;height:${size}px;background:linear-gradient(135deg,${a},${b});font-size:${Math.round(size * 0.45)}px">${letter}</span>`;
    if (!url) return fallback;
    return `<span class="av" style="width:${size}px;height:${size}px;background:linear-gradient(135deg,${a},${b});font-size:${Math.round(size * 0.45)}px">${letter}<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()"/></span>`;
  }

  window.fmt = { esc, num, compact, pct, ago, agoShort, clock, followers, joined, frontRankText, frontRankHelp, frontRankClass, chainOf, chainLabel, shortAddr, avatar, avatarColors };
})();
