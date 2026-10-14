import type { components } from './schema.gen'

type ErrorBody = components['schemas']['Error']

/** A non-2xx answer from the API. */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly field?: string

  constructor(status: number, body?: Partial<ErrorBody>) {
    super(body?.message ?? `Request failed with status ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.code = body?.code
    this.field = body?.field
  }
}

/** Returns the data of an openapi-fetch result or throws ApiError. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.data !== undefined) return result.data
  const body = typeof result.error === 'object' ? (result.error as Partial<ErrorBody>) : undefined
  throw new ApiError(result.response.status, body ?? undefined)
}
