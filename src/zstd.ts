import { decompress as fzstdDecompress } from "fzstd";

/**
 * 还原 message_content：
 * - ct==4 且是 bytes → zstd 解压（无字典，标准帧）；解压失败返回 null（让上层回退到原始 bytes 或标注压缩内容）
 * - 其余 bytes → 直接 utf-8
 * - 已是字符串 → 原样返回
 */
export function decompressContent(content: unknown, ct: number | null): string | null {
  if (content == null) return null;
  if (content instanceof Uint8Array) {
    if (ct !== 4) return Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString("utf-8");
    try {
      return Buffer.from(fzstdDecompress(content)).toString("utf-8");
    } catch {
      return null;
    }
  }
  return String(content);
}
