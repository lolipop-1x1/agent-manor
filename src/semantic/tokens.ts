/** 统一采用 UTF-8 字节估算；不是提供方实测 token，包含每个输入的固定预留。 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3) + 4;
}
