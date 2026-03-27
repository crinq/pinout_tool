/** Escape HTML special characters for safe insertion into innerHTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escape a string for use in a RegExp constructor. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Create a modal overlay with standard dismiss behavior.
 * Returns { overlay, modal, close } for attaching content and event handlers.
 * If `toggle` is provided, removes an existing overlay with that selector and returns null.
 */
export function createModal(opts: {
  overlayClass?: string;
  modalClass?: string;
  toggle?: string;
  zIndex?: string;
  modalStyle?: Partial<CSSStyleDeclaration>;
}): { overlay: HTMLDivElement; modal: HTMLDivElement; close: () => void } | null {
  const overlayClass = opts.overlayClass ?? 'settings-overlay';
  const modalClass = opts.modalClass ?? 'settings-modal';

  // Toggle: remove existing and return null
  if (opts.toggle) {
    const existing = document.querySelector(opts.toggle);
    if (existing) { existing.remove(); return null; }
  }

  const overlay = document.createElement('div');
  overlay.className = overlayClass;
  if (opts.zIndex) overlay.style.zIndex = opts.zIndex;

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const modal = document.createElement('div');
  modal.className = modalClass;
  if (opts.modalStyle) {
    for (const [k, v] of Object.entries(opts.modalStyle)) {
      (modal.style as unknown as Record<string, unknown>)[k] = v;
    }
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  return { overlay, modal, close };
}
