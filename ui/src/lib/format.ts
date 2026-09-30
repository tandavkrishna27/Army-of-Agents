/**
 * Render a byte count as a human-readable size string.
 *
 * Shared by memory components that render uploaded file sizes.
 *
 * Note: `components/workspace/workspace-utils.tsx` has a separate `formatBytes`
 * with different formatting (stops at MB, no GB tier). The two are deliberately
 * NOT unified — workspace renders agent-output diffs where bytes are always
 * present and large; memory renders user-uploaded files where sub-1KB is real
 * and GB is plausible. If you find yourself "fixing" one to match the other,
 * stop and check the call sites.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
