export interface RoutableItem {
  id: string;
  type: string;
  suggestedDepartmentId: string | null;
  departmentId: string | null;
}

export function recommendDepartment(
  items: RoutableItem[],
  departments: Array<{ id: string; name: string }>,
): { departmentId: string; departmentName: string; itemCount: number } | null {
  const counts = new Map<string, number>();
  for (const it of items) {
    if (it.type !== "task") continue;
    const dept = it.departmentId ?? it.suggestedDepartmentId;
    if (!dept) continue;
    counts.set(dept, (counts.get(dept) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  // Highest count wins; tie-break by departments[] order (stable, deterministic).
  let best: { departmentId: string; count: number } | null = null;
  for (const d of departments) {
    const c = counts.get(d.id) ?? 0;
    if (c > 0 && (best === null || c > best.count)) best = { departmentId: d.id, count: c };
  }
  // Fall back to any counted dept not in `departments` (deterministic by id).
  if (best === null) {
    const [departmentId, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const name = departments.find((d) => d.id === departmentId)?.name ?? departmentId;
    return { departmentId, departmentName: name, itemCount: count };
  }
  const name = departments.find((d) => d.id === best!.departmentId)?.name ?? best!.departmentId;
  return { departmentId: best.departmentId, departmentName: name, itemCount: best.count };
}
