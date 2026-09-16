"use strict";

/**
 * 新币 / 老币回暖提醒的判定（纯函数 + 少量记忆，main.cjs 每次收到 state 调一次）。
 *
 * - new：代币的喊单人数「刚」达到 minKol（达标那条喊单在 FRESH_SEC 内），且链 / 市值满足过滤条件。
 *   链或市值还没到（新币行情一般晚 ~0.5s）就先不判，等下一次 state；超过 FRESH_SEC 仍不满足就算了。
 * - heat：首次喊单超过 OLD_SEC 的老币，HEAT_WINDOW_SEC 内有 ≥ heatKol 个人再喊（最近一条在 FRESH_SEC 内），
 *   同一个币 HEAT_COOLDOWN_SEC 内只提醒一次；链 / 市值过滤同样适用。
 * 第一次调用只记基线不提醒：启动时列表里已经满足条件的币不补弹。
 */

const FRESH_SEC = 10 * 60;
const OLD_SEC = 60 * 60;
const HEAT_WINDOW_SEC = 30 * 60;
const HEAT_COOLDOWN_SEC = 60 * 60;

/** settings.popup → 判定用的条件（缺字段按默认：1 人即提醒、不限链 / 市值、老币 2 人再喊提醒） */
function alertConfig(popup) {
  const p = popup && typeof popup === "object" ? popup : {};
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    minKol: Math.max(1, Math.round(n(p.minKol, 1))),
    mcMin: Math.max(0, n(p.mcMin, 0)),
    mcMax: Math.max(0, n(p.mcMax, 0)),
    chains: Array.isArray(p.chains) ? p.chains.map((c) => String(c).toLowerCase()) : [],
    heatKol: Math.max(0, Math.round(n(p.heatKol, 2))),
  };
}

/** 第 k 个不同喊单人第一次出现的时间（mentions 按时间升序）；不足 k 人 → null */
function kthSenderTime(mentions, k) {
  const seen = new Set();
  for (const m of mentions) {
    if (seen.has(m.sender)) continue;
    seen.add(m.sender);
    if (seen.size === k) return m.time;
  }
  return null;
}

/** 窗口内喊过的不同人数（老币行上的 🔥 也用它） */
function recentSenders(mentions, sinceSec) {
  return new Set(mentions.filter((m) => m.time >= sinceSec).map((m) => m.sender)).size;
}

/** 链 / 市值过滤：true 通过，false 不通过，null 数据还没到 */
function passesFilters(token, cfg) {
  const chain = String(token.market?.chain || token.chainHint || "").toLowerCase();
  if (cfg.chains.length) {
    if (!chain) return null;
    if (!cfg.chains.includes(chain)) return false;
  }
  if (cfg.mcMin > 0 || cfg.mcMax > 0) {
    const mc = token.market?.mc;
    if (typeof mc !== "number" || !Number.isFinite(mc)) return null;
    if (cfg.mcMin > 0 && mc < cfg.mcMin) return false;
    if (cfg.mcMax > 0 && mc > cfg.mcMax) return false;
  }
  return true;
}

function createAlerter() {
  let baseline = true;
  /** address → 已经发过 new 提醒（或启动时就已达标） */
  const newDone = new Set();
  /** address → 上次 heat 提醒的时间（秒） */
  const heatAt = new Map();

  function update(tokens, popup, nowSec = Date.now() / 1000) {
    const cfg = alertConfig(popup);
    const out = [];
    for (const t of Array.isArray(tokens) ? tokens : []) {
      const mentions = Array.isArray(t?.mentions) ? t.mentions : [];
      if (!t?.address || !mentions.length) continue;

      const hot = recentSenders(mentions, nowSec - HEAT_WINDOW_SEC);
      const latest = mentions[mentions.length - 1].time;
      const heatReady = cfg.heatKol > 0 && mentions[0].time < nowSec - OLD_SEC && hot >= cfg.heatKol && latest >= nowSec - FRESH_SEC;
      if (baseline) {
        if (kthSenderTime(mentions, cfg.minKol) !== null) newDone.add(t.address);
        if (heatReady) heatAt.set(t.address, nowSec);
        continue;
      }

      if (!newDone.has(t.address)) {
        const crossed = kthSenderTime(mentions, cfg.minKol);
        if (crossed !== null && crossed >= nowSec - FRESH_SEC) {
          const pass = passesFilters(t, cfg);
          if (pass === true) { newDone.add(t.address); out.push({ kind: "new", token: t }); continue; }
        } else if (crossed !== null) {
          newDone.add(t.address); // 达标太久了（回灌 / 条件刚放宽），不再补弹
        }
      }

      if (heatReady && !(nowSec - (heatAt.get(t.address) ?? -Infinity) < HEAT_COOLDOWN_SEC) && passesFilters(t, cfg) === true) {
        heatAt.set(t.address, nowSec);
        out.push({ kind: "heat", token: t, recent: hot });
      }
    }
    baseline = false;
    return out;
  }

  return { update };
}

module.exports = { createAlerter, alertConfig, recentSenders, passesFilters, HEAT_WINDOW_SEC, OLD_SEC };
