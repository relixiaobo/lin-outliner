import { describe, expect, test } from 'bun:test';
import { isRendererPermissionAllowed, RENDERER_ALLOWED_PERMISSIONS } from '../../src/main/rendererPermissions';

describe('renderer permissions', () => {
  test('allows only sanitized clipboard writes and HTML fullscreen', () => {
    expect(RENDERER_ALLOWED_PERMISSIONS).toEqual(['clipboard-sanitized-write', 'fullscreen']);
    expect(isRendererPermissionAllowed('clipboard-sanitized-write')).toBe(true);
    expect(isRendererPermissionAllowed('fullscreen')).toBe(true);

    expect(isRendererPermissionAllowed('geolocation')).toBe(false);
    expect(isRendererPermissionAllowed('media')).toBe(false);
    expect(isRendererPermissionAllowed('notifications')).toBe(false);
    expect(isRendererPermissionAllowed('openExternal')).toBe(false);
  });
});
