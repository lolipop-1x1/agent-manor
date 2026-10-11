export interface MapPoint { x: number; y: number }
export interface MapSize { width: number; height: number }
export interface MapRect extends MapPoint, MapSize {}
export interface MapCamera extends MapPoint { scale: number }

const worldSize: MapSize = { width: 1000, height: 650 };
const readableSize: MapSize = { width: 160, height: 128 };
const maximumScale = Number.MAX_SAFE_INTEGER / Math.max(worldSize.width, worldSize.height);
const positive = (value: number, fallback: number) => Number.isFinite(value) && value > 0 ? value : fallback;
const dimension = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
const translation = (value: number) => Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value));

/** 相机平移使用屏幕像素，缩放以给定屏幕焦点为中心。 */
export function zoomCamera(camera: MapCamera, factor: number, focus: MapPoint, minScale: number, maxScale: number): MapCamera {
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(focus.x) || !Number.isFinite(focus.y)) return camera;
  const lower = Math.min(maximumScale, positive(minScale, Number.EPSILON));
  const upper = Math.min(maximumScale, Math.max(lower, positive(maxScale, lower)));
  const scale = Math.max(lower, Math.min(upper, camera.scale * factor));
  const ratio = scale / camera.scale;
  return { scale, x: translation(focus.x - (focus.x - camera.x) * ratio), y: translation(focus.y - (focus.y - camera.y) * ratio) };
}

export function panCamera(camera: MapCamera, delta: MapPoint): MapCamera {
  return {
    ...camera,
    x: translation(camera.x + (Number.isFinite(delta.x) ? delta.x : 0)),
    y: translation(camera.y + (Number.isFinite(delta.y) ? delta.y : 0)),
  };
}

export function fitCamera(bounds: MapRect, viewport: MapSize, padding = 12): MapCamera {
  const inset = dimension(padding);
  const scale = Math.min(maximumScale, Math.min(
    Math.max(1, dimension(viewport.width) - inset * 2) / positive(bounds.width, 1),
    Math.max(1, dimension(viewport.height) - inset * 2) / positive(bounds.height, 1),
  ));
  return centerCamera(bounds, viewport, scale);
}

export function locateCamera(bounds: MapRect, viewport: MapSize, minScale: number, maxScale: number, padding = 24): MapCamera {
  const fitted = fitCamera(bounds, viewport, padding);
  const lower = Math.min(maximumScale, positive(minScale, Number.EPSILON));
  const upper = Math.min(maximumScale, Math.max(lower, positive(maxScale, lower)));
  const readable = Math.max(readableSize.width / positive(bounds.width, 1), readableSize.height / positive(bounds.height, 1));
  return centerCamera(bounds, viewport, Math.max(lower, Math.min(upper, Math.max(fitted.scale, readable))));
}

function centerCamera(bounds: MapRect, viewport: MapSize, scale: number): MapCamera {
  return {
    scale,
    x: translation(dimension(viewport.width) / 2 - (bounds.x + bounds.width / 2) * scale),
    y: translation(dimension(viewport.height) / 2 - (bounds.y + bounds.height / 2) * scale),
  };
}

/** 尺寸变化保留视口中心对应的逻辑位置和当前倍率。 */
export function resizeCamera(camera: MapCamera, previous: MapSize, next: MapSize): MapCamera {
  return panCamera(camera, { x: (dimension(next.width) - dimension(previous.width)) / 2, y: (dimension(next.height) - dimension(previous.height)) / 2 });
}

export function projectRect(bounds: MapRect, camera: MapCamera): MapRect {
  return { x: bounds.x * camera.scale + camera.x, y: bounds.y * camera.scale + camera.y, width: bounds.width * camera.scale, height: bounds.height * camera.scale };
}

/** 两类地图共用屏幕间隔，小块保留完整填充以免遮住微小正值。 */
export function mapTileFillRect(rect: MapRect): MapRect {
  const gap = rect.width > 8 && rect.height > 8 ? .5 : 0;
  return { x: rect.x + gap, y: rect.y + gap, width: rect.width - gap * 2, height: rect.height - gap * 2 };
}

/** 返回屏幕内可见部分，标签可据此定位，不使用裁剪后的尺寸改变面积。 */
export function clipRect(bounds: MapRect, viewport: MapSize): MapRect | null {
  const x = Math.max(0, bounds.x);
  const y = Math.max(0, bounds.y);
  const right = Math.min(dimension(viewport.width), bounds.x + bounds.width);
  const bottom = Math.min(dimension(viewport.height), bounds.y + bounds.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
