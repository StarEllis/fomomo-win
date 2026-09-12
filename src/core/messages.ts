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
  source: "wechat" | "feishu";
  watched: boolean;
  state?: "starting" | "monitoring" | "error";
  error?: string;
}

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
