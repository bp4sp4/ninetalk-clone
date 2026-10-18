import type { ReactNode } from "react";

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold md:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {children}
    </header>
  );
}

export function PanelSkeleton() {
  return (
    <div className="card space-y-3 p-5" aria-busy>
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="h-9 animate-pulse rounded-lg bg-black/5" />
      ))}
    </div>
  );
}
