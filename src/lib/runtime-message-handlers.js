const ROUTE_MODE_ASYNC = 'async';
const ROUTE_MODE_SYNC = 'sync';
const ROUTE_MODE_FIRE_AND_FORGET = 'fire-and-forget';

/**
 * @typedef {(message: Record<string, unknown>, sender: Record<string, unknown>) => unknown | Promise<unknown>} RuntimeRouteHandler
 * @typedef {{ mode: string, handler: RuntimeRouteHandler }} RuntimeRoute
 */

/** @param {RuntimeRouteHandler} handler */
export function asyncResponse(handler) {
  return { mode: ROUTE_MODE_ASYNC, handler };
}

/** @param {RuntimeRouteHandler} handler */
export function syncResponse(handler) {
  return { mode: ROUTE_MODE_SYNC, handler };
}

/** @param {RuntimeRouteHandler} handler */
export function fireAndForget(handler) {
  return { mode: ROUTE_MODE_FIRE_AND_FORGET, handler };
}

/**
 * @param {{
 *   handlers?: Record<string, RuntimeRoute>,
 *   onUnhandled?: ((message: Record<string, unknown>, sender: Record<string, unknown>) => void) | null,
 *   onError?: ((error: unknown, message: Record<string, unknown>) => void) | null,
 * }} options
 */
export function createRuntimeMessageHandler({
  handlers = {},
  onUnhandled = null,
  onError = null,
} = {}) {
  /**
   * @param {Record<string, unknown>} message
   * @param {Record<string, unknown>} sender
   * @param {(response?: unknown) => void} sendResponse
   */
  return function handleRuntimeMessage(message, sender, sendResponse = () => {}) {
    const messageType = typeof message?.type === 'string' ? message.type : '';
    const route = handlers?.[messageType];
    if (!route) {
      onUnhandled?.(message, sender);
      return false;
    }

    if (route.mode === ROUTE_MODE_SYNC) {
      try {
        sendResponse(route.handler(message, sender));
      } catch (error) {
        onError?.(error, message);
        sendResponse(serializeRuntimeError(error));
      }
      return false;
    }

    if (route.mode === ROUTE_MODE_FIRE_AND_FORGET) {
      try {
        Promise.resolve(route.handler(message, sender)).catch((error) => onError?.(error, message));
      } catch (error) {
        onError?.(error, message);
      }
      return false;
    }

    Promise.resolve()
      .then(() => route.handler(message, sender))
      .then(sendResponse)
      .catch((error) => {
        onError?.(error, message);
        sendResponse(serializeRuntimeError(error));
      });
    return true;
  };
}

/** @param {unknown} error */
export function serializeRuntimeError(error) {
  const runtimeError = /** @type {{ message?: string, code?: string }} */ (error || {});
  return {
    ok: false,
    error: runtimeError?.message ?? String(error),
    ...(runtimeError?.code ? { code: runtimeError.code } : {}),
  };
}
