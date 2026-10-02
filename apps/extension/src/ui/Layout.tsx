import type { ReactNode } from 'react';

export function Layout({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <main className="layout">
      <header>
        <h1>{title}</h1>
      </header>
      {children}
    </main>
  );
}
