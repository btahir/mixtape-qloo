"use client";
import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
/** Focus-trapped side sheet, full-height on phones. */
export function Sheet({
  title,
  open,
  onOpenChange,
  children,
  footer,
  finalFocus,
  onCloseComplete,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  footer?: ReactNode;
  finalFocus?: () => HTMLElement | null | boolean;
  onCloseComplete?: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} onOpenChangeComplete={(value) => { if (!value) onCloseComplete?.(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop" />
        <Dialog.Popup className="sheet" finalFocus={finalFocus}>
          <div className="sheet-header">
          <div className="sheet-top">
            <Dialog.Close className="sheet-close" aria-label="Close">
              ×
            </Dialog.Close>
          </div>
          <Dialog.Title>{title}</Dialog.Title>
          </div>
          <div className="sheet-content">{children}</div>
          {footer && <div className="sheet-footer">{footer}</div>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
