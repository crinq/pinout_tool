export { escapeHtml, escapeRegex } from '../ts_lib/src/utils';
import { createModal as _createModal } from '../ts_lib/src/utils';

/**
 * Create a modal overlay with standard dismiss behavior.
 * Wraps ts_lib's createModal with app-specific defaults (settings-overlay/settings-modal).
 */
export function createModal(opts: {
  overlayClass?: string;
  modalClass?: string;
  toggle?: string;
  zIndex?: string;
  modalStyle?: Partial<CSSStyleDeclaration>;
}): { overlay: HTMLDivElement; modal: HTMLDivElement; close: () => void } | null {
  return _createModal({
    overlayClass: opts.overlayClass ?? 'settings-overlay',
    modalClass: opts.modalClass ?? 'settings-modal',
    toggle: opts.toggle,
    zIndex: opts.zIndex,
    modalStyle: opts.modalStyle,
  });
}
