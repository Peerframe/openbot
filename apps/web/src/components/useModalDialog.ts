// Hook that opens a native modal <dialog> and reports its close or cancel back to React state.
import { useCallback, useEffect, useRef } from "react";

/**
 * Opens a native modal dialog and keeps React state responsible for its lifetime.
 * The browser supplies focus containment and background inertness; OpenBot only
 * bridges the native close/cancel lifecycle back to the owning component.
 */
export function useModalDialog(onClose: () => void) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  const openerRef = useRef<HTMLElement | null>(null);
  onCloseRef.current = onClose;

  const closeDialog = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    onCloseRef.current();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      closeDialog();
    };

    dialog.addEventListener("cancel", handleCancel);
    if (!dialog.open) dialog.showModal();

    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      if (dialog.open) dialog.close();
      if (openerRef.current?.isConnected) openerRef.current.focus();
    };
  }, [closeDialog]);

  return { dialogRef, closeDialog };
}
