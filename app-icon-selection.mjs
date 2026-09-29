const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico']);
const RASTER_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

function iconExtension(src) {
  const pathname = String(src || '').split(/[?#]/, 1)[0].toLowerCase();
  const match = pathname.match(/\.[a-z0-9]+$/);
  return match?.[0] || '';
}

function iconFormatRank(icon) {
  const type = String(icon?.type || '').trim().toLowerCase();
  const extension = iconExtension(icon?.src);
  if (type === 'image/svg+xml' || extension === '.svg') return 0;
  if (RASTER_TYPES.has(type) || RASTER_EXTENSIONS.has(extension)) return 2;
  return 1;
}

function iconMaxSize(icon) {
  return Math.max(
    0,
    ...String(icon?.sizes || '')
      .split(/\s+/)
      .map(size => Number((size.match(/\d+/) || [0])[0])),
  );
}

export function preferredManifestIconSource(manifest) {
  const icons = Array.isArray(manifest?.icons) ? manifest.icons : [];
  return icons
    .filter(icon => icon && typeof icon === 'object' && icon.src)
    .map((icon, index) => ({
      src: String(icon.src),
      formatRank: iconFormatRank(icon),
      maxSize: iconMaxSize(icon),
      index,
    }))
    .sort((a, b) => b.formatRank - a.formatRank || b.maxSize - a.maxSize || a.index - b.index)[0]?.src || null;
}
