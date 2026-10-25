/**
 * Reject DOM-script actuation at the real extension document entry point.
 * Native keyboard activation still produces trusted button clicks. This is
 * not a boundary against browser debugging or operating-system automation.
 * @param {Document} document
 */
export function installTrustedUiEventBoundary(document) {
  const pendingSubmissions = new WeakMap();
  const eventTypes = ['click', 'keydown', 'input', 'change', 'submit', 'invalid', 'visibilitychange'];

  function block(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function guard(event) {
    if (event.isTrusted !== true) {
      block(event);
      return;
    }

    if (event.type === 'click') {
      const button = event.target?.closest?.('button, input');
      if (button?.form && ['submit', 'image'].includes(button.type)) {
        const form = button.form;
        const activation = { button, event };
        pendingSubmissions.set(form, activation);
        // The default submit happens after click listeners and their microtasks,
        // but before the next task. Invalid or canceled clicks must not leave a
        // permission for a later script-driven requestSubmit().
        setTimeout(() => {
          if (pendingSubmissions.get(form) === activation) pendingSubmissions.delete(form);
        }, 0);
      }
    } else if (event.type === 'invalid') {
      if (event.target?.form) pendingSubmissions.delete(event.target.form);
    } else if (event.type === 'submit') {
      const activation = pendingSubmissions.get(event.target);
      pendingSubmissions.delete(event.target);
      // requestSubmit() itself creates a trusted event without a user gesture.
      if (!activation || activation.event.defaultPrevented
        || event.submitter !== activation.button || activation.button.disabled
        || activation.button.form !== event.target) block(event);
    }
  }

  for (const type of eventTypes) document.addEventListener(type, guard, true);
  document.defaultView?.addEventListener('pagehide', guard, true);
  return () => {
    for (const type of eventTypes) document.removeEventListener(type, guard, true);
    document.defaultView?.removeEventListener('pagehide', guard, true);
  };
}
