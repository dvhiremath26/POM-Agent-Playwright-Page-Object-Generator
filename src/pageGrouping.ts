/** Convert logical screen names to safe, stable folder/class identities, never arbitrary paths. */
export function pageGroupSlug(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 100 || !/^[a-zA-Z][a-zA-Z0-9 _-]*$/.test(value.trim())) return undefined;
  const slug = value.trim().replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/(?:[ _-]+)?Page$/i, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  if (!slug || slug.length > 64 || /^(?:base|con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug)) return undefined;
  return slug;
}
