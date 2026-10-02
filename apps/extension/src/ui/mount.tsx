import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

/** Mounts a page component into `#root`; throws loudly if the host page is malformed. */
export function mount(element: ReactElement): void {
  const container = document.getElementById('root');
  if (container === null) {
    throw new Error('Heed page is missing its #root element');
  }
  createRoot(container).render(<StrictMode>{element}</StrictMode>);
}
