// Shared modal dialog frame (DESIGN.md › Dialogs) on a native <dialog>; callers supply the actions.
import { type CSSProperties, type ReactNode, useId } from "react";
import { useModalDialog } from "./useModalDialog";

/**
 * The one dialog frame from DESIGN.md › Dialogs. A native modal `<dialog>` supplies focus
 * containment, Escape and background inertness; callers own every action inside it, so closing
 * never implies confirming.
 */
export function Dialog({
  title,
  intro,
  width = 560,
  onClose,
  footer,
  footerStart,
  className,
  children,
}: {
  title: string;
  intro?: ReactNode;
  width?: number;
  onClose(): void;
  /** Actions at the bottom right: grey 取消 first, then the primary or danger pill. */
  footer?: ReactNode;
  /** Optional quiet link at the bottom left. */
  footerStart?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const { dialogRef, closeDialog } = useModalDialog(onClose);
  const titleId = useId();
  const introId = useId();
  return (
    <dialog
      ref={dialogRef}
      className={["ob-dialog", className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      aria-describedby={intro ? introId : undefined}
      style={{ "--ob-dialog-width": `${width}px` } as CSSProperties}
    >
      <div className="ob-dialog-sheet">
        <button type="button" className="ob-dialog-close" aria-label="关闭" onClick={closeDialog}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
        <header className="ob-dialog-header">
          <h2 id={titleId}>{title}</h2>
          {intro ? <p id={introId}>{intro}</p> : null}
        </header>
        {children}
        {footer || footerStart ? (
          <footer className="ob-dialog-footer">
            {footerStart ?? <span />}
            {footer ? <div className="ob-dialog-actions">{footer}</div> : null}
          </footer>
        ) : null}
      </div>
    </dialog>
  );
}
