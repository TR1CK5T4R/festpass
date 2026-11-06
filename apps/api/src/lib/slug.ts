/** "MAIT Alumni Cell!" -> "mait-alumni-cell" (lowercase letters, digits and single hyphens). */
export function slugify(text: string, maxLength = 60): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
}
