import { useParams } from "@/lib/router";
import { ApprovalDetailCore } from "../components/approval/ApprovalDetailCore";

/**
 * Thin route wrapper. The approval body — data fetch, payload renderer,
 * approve/reject/delete actions, comments, and linked tasks — lives in
 * {@link ApprovalDetailCore} so it can also be hosted inside an Inbox Hub tab
 * (D3). Route mode keeps the full page chrome (breadcrumbs, company route-sync,
 * `?resolved=approved` banner, route navigation).
 */
export function ApprovalDetail() {
  const { approvalId } = useParams<{ approvalId: string }>();
  return <ApprovalDetailCore approvalId={approvalId!} />;
}
