//! Event-routing assertions.

import { FocusManager } from "../index.ts";


export function assertActiveId(
  manager: FocusManager,
  expected: string | null,
  label: string,
): void {
  const actual = manager.activeId;
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

export function assertEvents(
  events: Array<string | null>,
  expected: Array<string | null>,
  label: string,
): void {
  if (events.length !== expected.length) {
    throw new Error(
      `${label}: expected ${expected.length} events, got ${events.length}: ${
        JSON.stringify(events)
      }`,
    );
  }
  for (let i = 0; i < events.length; i++) {
    if (events[i] !== expected[i]) {
      throw new Error(
        `${label}: event ${i} = ${JSON.stringify(events[i])}, expected ${
          JSON.stringify(expected[i])
        }`,
      );
    }
  }
}
