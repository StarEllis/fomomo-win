/** Messages at the monitoring seam; timestamps are Unix seconds (fractional for Feishu). */
export interface GroupMsg {
  t: "msg";
  group: string;
  time: number;
  sender: string;
  text: string;
  addrs: string[];
  chainHint: string | null;
  backfill: boolean;
}

export interface ContextRow {
  createTime: number;
  sender: string;
  text: string;
}

export interface GroupSummary {
  username: string;
  displayName: string;
  lastTimestamp: number;
  summary: string;
  source: "wechat" | "feishu" | "qq";
  watched: boolean;
  state?: "starting" | "monitoring" | "error";
  error?: string;
}

/**
 * 一个来源当下的监听健康度。群组页据此显示「异常处理」条：failing / error 任一有值就出现，
 * 按钮调对应来源的修复动作。三个监听器各自算自己的。
 */
export interface SourceHealth {
  /** 已选中、应当在监听的群数 */
  watching: number;
  /** 其中处于异常态的群数 */
  failing: number;
  /** 第一条异常原因（直接显示给用户）；连接层面的问题即使一个群都没异常也放这里 */
  error: string | null;
}

export const NO_HEALTH: SourceHealth = { watching: 0, failing: 0, error: null };

/** Small persisted CA context: five rows through the call, then three following rows. */
export const CONTEXT_BEFORE = 5;
export const CONTEXT_AFTER = 3;
/** 运行中新勾选的群：回灌该群最近这么多条消息（含不带地址的普通聊天，只是数量口径）；首批群仍按启动时的时间窗 */
export const RECENT_BACKFILL = 100;

export type MonitorEvent =
  | { t: "heartbeat"; maxTime: number; polls: number }
  | { t: "error"; message: string }
  | { t: "groups" }
  | { t: "context"; msg: GroupMsg; rows: ContextRow[]; call: number };
