export interface Session {
  username: string;
  displayName: string;
  isGroup: boolean;
  unread: number;
  lastTimestamp: number;
  /** 最后一条消息摘要（已解压/去发送者前缀） */
  summary: string;
}

/** 已解出发送者与文本的一条消息（cli read 打印 / readAround 上下文都只用这三项） */
export interface WeChatMessage {
  createTime: number; // Unix 秒
  /** 群消息里的发送者显示名（单聊为空或对方名） */
  sender: string;
  /** 已解压、已格式化的文本内容 */
  text: string;
}
