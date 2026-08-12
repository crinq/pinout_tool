export { escapeHtml, escapeRegex } from '../ts_lib/src/utils';
import { createModal as _createModal } from '../ts_lib/src/utils';
import type { LogicalPin } from './types';

/**
 * Whether a pin is a general-purpose I/O the user can freely spend.
 *
 * CubeMX `MonoIO` pins (VREF+, PDR_ON, NJTRST, DNU, the MP1 DDR bus) are
 * fixed-function pads, not general I/O: they can still carry their dedicated
 * signal if a constraint asks for it, but they are not part of the free-pin
 * budget and are drawn like power pins rather than spendable I/O.
 */
export function isGeneralPurposePin(pin: LogicalPin): boolean {
  return pin.isAssignable && pin.type !== 'MonoIO';
}

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
