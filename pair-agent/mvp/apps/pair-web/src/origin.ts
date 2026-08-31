function normalizeWebOrigin(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === '') {
    throw new TypeError(`${label} is required`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be a valid http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`${label} must use http or https`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError(`${label} must not contain credentials`);
  }
  if (url.hash !== '') throw new TypeError(`${label} must not contain a hash`);
  if (url.search !== '') throw new TypeError(`${label} must not contain a query`);
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new TypeError(`${label} must not contain a path`);
  }
  return url.origin;
}

export function normalizeDshWebOrigin(
  value: string | undefined,
  shellOrigin: string,
): string {
  const dshOrigin = normalizeWebOrigin(value, 'DSH Web origin');
  const normalizedShellOrigin = normalizeWebOrigin(shellOrigin, 'Pair Shell origin');
  if (dshOrigin === normalizedShellOrigin) {
    throw new TypeError('DSH Web must use a separate origin from the Pair Shell');
  }
  return dshOrigin;
}

export function normalizeShellOrigin(
  value: string | undefined,
  fallback: string,
): string {
  return normalizeWebOrigin(value?.trim() || fallback, 'Pair Shell origin');
}
