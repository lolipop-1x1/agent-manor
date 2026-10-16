import { DiagnosticError } from "../../i18n/diagnostics.js";

const descriptors = {
  invalid: { key: "diagnostics.history.adapters.doubaoWork.cacheInvalid" },
  unsupported: { key: "diagnostics.history.adapters.doubaoWork.cacheUnsupported" },
  limit: { key: "diagnostics.history.adapters.doubaoWork.cacheLimit" },
  missing: { key: "diagnostics.history.adapters.doubaoWork.cacheDependencyMissing" },
  changed: { key: "diagnostics.history.adapters.doubaoWork.cacheChanged" },
};

/** 在自产错误的生成点分类；原始格式细节保留在 message 和上层 cause 中。 */
export function cacheFailure(kind: keyof typeof descriptors, message: string, cause?: unknown): DiagnosticError {
  const failure = new DiagnosticError(message, descriptors[kind]);
  if (cause !== undefined) Object.defineProperty(failure, "cause", { value: cause });
  return failure;
}
