import React, { useEffect, useRef } from 'react';

// Professional Modal with Tailwind animations, focus trap and accessible controls
export default function Modal({
  show,
  title,
  description = '',
  headerIcon = null,
  size = 'md',
  onClose,
  children,
  closeOnBackdrop = true,
  footer = null,
  className = '',
}) {
  const dialogRef = useRef(null);
  const previouslyFocusedRef = useRef(null);
  const onCloseRef = useRef(onClose);
  // keep latest onClose in a ref so effect doesn't need it as dep
  onCloseRef.current = onClose;

  // map size to max width
  const sizeClasses = {
    sm: 'max-w-sm',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-6xl',
    xxl: 'max-w-[96vw]',
  };

  useEffect(() => {
    if (!show) return;
    previouslyFocusedRef.current = document.activeElement;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // when opened, move focus to first focusable element inside dialog
    const setInitialFocus = () => {
      const el = dialogRef.current;
      if (!el) return;
      const focusable = el.querySelectorAll('a[href], button:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])');
      if (focusable && focusable.length) {
        try { focusable[0].focus(); } catch (e) {}
      } else {
        // fallback: focus dialog container
        try { el.focus(); } catch (e) {}
      }
    };

    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current && onCloseRef.current();
      } else if (e.key === 'Tab') {
        const el = dialogRef.current;
        if (!el) return;
        const focusable = el.querySelectorAll('a[href], button:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])');
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
    };

    // small timeout to allow DOM to render
    const t = setTimeout(setInitialFocus, 40);
    document.addEventListener('keydown', handleKey);

    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prev;
      try { previouslyFocusedRef.current && previouslyFocusedRef.current.focus(); } catch (e) {}
    };
  }, [show]);

  if (!show) return null;

  return (
    <div
      className={`app-modal-root fixed inset-0 z-50 flex items-center justify-center px-3 py-3 sm:px-6 sm:py-6 ${className}`.trim()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      {/* Backdrop (click to close) */}
      <div
        onClick={(e) => { if (!closeOnBackdrop) return; if (onClose) onClose(); }}
        className="app-modal-backdrop absolute inset-0 bg-black/55 backdrop-blur-sm transition-opacity duration-300 z-40"
      />

      {/* Modal Panel */}
      <div
        className={`app-modal-shell ${sizeClasses[size] || sizeClasses.md} w-full relative transform transition-all duration-300 ease-out will-change-transform z-50`}
        style={{ zIndex: 60 }}
      >
        <div
          ref={dialogRef}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          className="app-modal-panel mx-auto max-h-[calc(100vh-1.5rem)] overflow-hidden rounded-2xl bg-white shadow-2xl border border-gray-100 transform transition-all duration-350 ease-out sm:max-h-[calc(100vh-3rem)]"
          style={{ boxShadow: '0 10px 40px rgba(2,6,23,0.14)' }}
        >

          {/* Header */}
          <div className="app-modal-header flex items-center justify-between gap-3 px-4 py-3 bg-gradient-to-b from-white to-gray-50 border-b border-gray-100 sm:gap-4 sm:px-[24px] sm:py-[16px]">
            <div className="flex min-w-0 items-center gap-3 sm:gap-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-green-50 text-green-700 font-bold sm:h-10 sm:w-10">
                {headerIcon || ((title || '').charAt(0) || '')}
              </div>
              <div className="min-w-0">
                <h2 id="modal-title" className="break-words text-base font-semibold text-gray-900 sm:text-lg">{title}</h2>
                {description ? <p className="mt-0.5 text-sm text-gray-500">{description}</p> : null}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                aria-label="Close"
                className="inline-flex items-center justify-center rounded-md p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="app-modal-body max-h-[calc(100vh-8rem)] overflow-auto p-4 custom-scrollbar sm:max-h-[72vh] sm:p-[24px]">
            <div className="motion-safe:animate-fade-slide-up">
              {children}
            </div>
          </div>

          {/* Footer */}
          {footer ? (
            <div className="app-modal-footer flex items-center justify-end gap-3 px-[24px] py-[16px] bg-gray-50 border-t">
              {footer}
            </div>
          ) : null}

        </div>
      </div>
    </div>
  );
}
