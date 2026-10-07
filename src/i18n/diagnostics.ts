import type { MessageDescriptor } from "./types.js";

/** 只有生成端明确附带的产品描述可翻译；外部及旧错误保留原文。 */
export class DiagnosticError extends Error {
  constructor(message: string, readonly messageDescriptor?: MessageDescriptor) { super(message); }
}

export function errorDescriptor(error: unknown): MessageDescriptor | undefined {
  if (!error || typeof error !== "object" || !("messageDescriptor" in error)) return undefined;
  const descriptor = error.messageDescriptor;
  if (!descriptor || typeof descriptor !== "object" || !("key" in descriptor) || typeof descriptor.key !== "string") return undefined;
  return descriptor as MessageDescriptor;
}
