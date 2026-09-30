export function AgentSaveWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 space-y-1">
      {warnings.map((w, i) => (
        <p key={i} className="text-xs text-amber-700 dark:text-amber-300">
          Heads up: {w}
        </p>
      ))}
    </div>
  );
}
