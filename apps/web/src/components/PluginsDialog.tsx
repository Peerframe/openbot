// Plugins dialog (Plugins artboard) over the workspace: choose which Bots use each plugin.
import type { Bot } from "@openbot/domain";
import type { PluginContentScope } from "../plugin-api";
import { CloseIcon } from "./Icons";
import { PluginManager } from "./PluginManagerPanel";
import { useModalDialog } from "./useModalDialog";
import "./PluginsDialog.css";

/**
 * Plugins artboard: a modal over the workspace for choosing which Bots use each plugin. Plugins
 * add capabilities, not authority; confirm-mode tools still ask the Owner on every call.
 */
export function PluginsDialog({
  bots,
  scope,
  onInsertMaterial,
  onManage,
  onClose,
}: {
  bots: Bot[];
  scope?: PluginContentScope | undefined;
  onInsertMaterial?: ((text: string) => void) | undefined;
  onManage?: (() => void) | undefined;
  onClose(): void;
}) {
  const { dialogRef, closeDialog } = useModalDialog(onClose);
  return (
    <dialog
      ref={dialogRef}
      className="plugins-dialog"
      aria-labelledby="plugins-dialog-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <button
        className="plugins-dialog-close"
        type="button"
        aria-label="关闭插件"
        onClick={closeDialog}
      >
        <CloseIcon />
      </button>
      <PluginManager
        bots={bots}
        variant="catalog"
        scope={scope}
        onInsertMaterial={onInsertMaterial}
        onManage={
          onManage
            ? () => {
                closeDialog();
                onManage();
              }
            : undefined
        }
      />
    </dialog>
  );
}
