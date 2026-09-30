export const PREVIEW_QUERY_AUTH_PARAM = "aoa_preview_token";

export function getPreviewQueryAuthToken(url: URL) {
  const token = url.searchParams.get(PREVIEW_QUERY_AUTH_PARAM)?.trim() ?? "";
  return token.length > 0 ? token : null;
}

export function stripPreviewQueryAuthParams(url: URL) {
  url.searchParams.delete(PREVIEW_QUERY_AUTH_PARAM);
}
