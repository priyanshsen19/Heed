import { PROBLEM_CATALOG, problemTypeFor, type ErrorCode, type ProblemDetails } from '@heed/shared';

export function buildProblemForTest(code: ErrorCode, status: number): ProblemDetails {
  return {
    type: problemTypeFor(code),
    title: PROBLEM_CATALOG[code].title,
    status,
    code,
    requestId: 'srv-req-0001',
  };
}
