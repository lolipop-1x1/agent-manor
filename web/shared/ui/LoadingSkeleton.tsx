export function LoadingSkeleton({ variant = "list", label }: { variant?: "list" | "profile"; label: string }) {
  return <div className={`loading-skeleton loading-skeleton--${variant}`} role="status" aria-label={label}>
    <div aria-hidden="true">{Array.from({ length: variant === "list" ? 5 : 3 }, (_, index) => <div className="loading-skeleton-group" key={index}>
      <i className="loading-skeleton-title" />
      {variant === "list" ? <i className="loading-skeleton-meta" /> : <>
        <div className="loading-skeleton-metric"><i /><i /></div>
        <div className="loading-skeleton-metric"><i /><i /></div>
        <div className="loading-skeleton-metric"><i /><i /></div>
      </>}
    </div>)}</div>
  </div>;
}
