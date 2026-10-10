// Portal slot that puts a settings section's primary action in the dialog header.
import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

/** The settings dialog header's right-hand slot (artboards: 新建例行任务, 配对新主机, …). */
export const SettingsActionSlot = createContext<HTMLElement | null>(null);

/** Renders a section's primary action into the dialog header, next to the title. */
export function SettingsHeaderAction({ children }: { children: ReactNode }) {
  const slot = useContext(SettingsActionSlot);
  return slot ? createPortal(children, slot) : null;
}
