import type { DestinationStream } from 'pino';

/** In-memory log destination for tests. */
export interface LogCapture {
  readonly destination: DestinationStream;
  text(): string;
  records(): Record<string, unknown>[];
}

export function createLogCapture(): LogCapture {
  const chunks: string[] = [];
  return {
    destination: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    text: () => chunks.join(''),
    records: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
