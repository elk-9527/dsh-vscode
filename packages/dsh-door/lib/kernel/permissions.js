/**
 * Compatibility adapter for the permissionPresets service.
 *
 * DSH 0.1 exposed selectFor(permissionState(session)); DSH 0.2 exposes a
 * process-level catalog().  Both lines retain current(session), resolve(name)
 * and set(session, name).  Keep the shape switch here so the TCP/JSON-RPC
 * bridge never needs to know which kernel generation it is serving.
 */

import {
  DOOR_ERR_NO_SESSION,
  DOOR_ERR_UNKNOWN_PRESET,
  permissionError,
  permissionPayload,
  settledPermission,
} from '../permission.js';

/** Return the supported permission service generation, or undefined. */
export function permissionApiKind(service) {
  if (
    service &&
    typeof service.catalog === 'function' &&
    typeof service.current === 'function' &&
    typeof service.set === 'function'
  ) {
    return 'catalog';
  }
  if (
    service &&
    typeof service.selectFor === 'function' &&
    typeof service.permissionState === 'function' &&
    typeof service.current === 'function' &&
    typeof service.set === 'function'
  ) {
    return 'select-for';
  }
  return undefined;
}

function catalogFor(service, kind, session) {
  if (kind === 'catalog') {
    const catalog = service.catalog() || {};
    return {
      options: catalog.options,
      defaultPreset: catalog.defaultPreset ?? service.defaultPreset,
    };
  }
  const selected = service.selectFor(service.permissionState(session)) || {};
  return {
    options: selected.options,
    defaultPreset: service.defaultPreset,
  };
}

/**
 * Wrap a kernel permission service as the two actions exposed by dsh-acp-door.
 * Returns undefined when the service is missing or belongs to an unknown API
 * generation.  The caller can then leave the rest of the bridge available.
 */
export function createPermissionHandler(ctx, diag = () => {}) {
  const service = ctx?.permissionPresets;
  const kind = permissionApiKind(service);
  if (!kind) {
    diag(
      service
        ? 'permissionPresets 服务存在，但接口版本无法识别，权限方法将明确返回“不支持”'
        : '该内核没有 permissionPresets 服务，权限方法将明确返回“不支持”',
    );
    return undefined;
  }

  const sessionOf = (id) => {
    const session = ctx.sessions?.get?.(id);
    if (!session) {
      throw permissionError(
        DOOR_ERR_NO_SESSION,
        `这个内核里没有会话 ${id}（可能它是别的内核建的，或已被关闭）`,
      );
    }
    return session;
  };

  const read = (session) => {
    const catalog = catalogFor(service, kind, session);
    return permissionPayload({
      currentValue: service.current(session),
      options: catalog.options,
      defaultPreset: catalog.defaultPreset,
    });
  };

  return {
    kind,
    async get(id) {
      return read(sessionOf(id));
    },
    async set(id, value) {
      const session = sessionOf(id);
      try {
        if (typeof service.resolve === 'function') {
          service.resolve(value);
        } else {
          const options = catalogFor(service, kind, session).options;
          if (!Array.isArray(options) || !options.some((item) => item?.value === value)) {
            throw new Error(`permission: unknown preset "${value}"`);
          }
        }
      } catch (error) {
        throw permissionError(
          DOOR_ERR_UNKNOWN_PRESET,
          error && error.message ? error.message : String(error),
        );
      }
      await service.set(session, value);
      const payload = read(session);
      payload.currentValue = settledPermission(payload.currentValue, value);
      return payload;
    },
  };
}
