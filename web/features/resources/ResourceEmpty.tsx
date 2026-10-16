import type { ReactNode } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";

export function ResourceEmpty({ children }: { children: ReactNode }) {
  return <div className="resource-empty"><MagnifyingGlass size={24} /><span>{children}</span></div>;
}
