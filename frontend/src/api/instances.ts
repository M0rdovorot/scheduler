import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import { ApiError, unwrap } from './errors'
import type { CreateTaskRequest, Scope, TrackingPatch, UpdateInstanceRequest } from './types'

export const instancesKey = ['instances'] as const

/** Tasks planned in [from, to). */
export function useInstances(from: Date, to: Date) {
  const fromIso = from.toISOString()
  const toIso = to.toISOString()
  return useQuery({
    queryKey: [...instancesKey, fromIso, toIso],
    queryFn: async () =>
      unwrap(await api.GET('/instances', { params: { query: { from: fromIso, to: toIso } } })),
    // Keep showing the previous window while the next one loads.
    placeholderData: (previous) => previous,
  })
}

/** Mutation that refreshes all loaded windows afterwards, whatever the outcome. */
function useInstanceMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: instancesKey }),
  })
}

export function useCreateTask() {
  return useInstanceMutation(async (body: CreateTaskRequest) =>
    unwrap(await api.POST('/tasks', { body })),
  )
}

/**
 * Edits a task. With scope "this" the updated task is returned; with "following"
 * or "all" the series is rewritten, the occurrences are created again (with new
 * ids) when their window is next loaded, and nothing is returned.
 */
export function useUpdateInstance() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      scope = 'this',
      ...body
    }: { id: string; scope?: Scope } & UpdateInstanceRequest) => {
      const { data, error, response } = await api.PATCH('/instances/{id}', {
        params: { path: { id }, query: { scope } },
        body,
      })
      if (!response.ok)
        throw new ApiError(response.status, typeof error === 'object' ? error : undefined)
      return data
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: instancesKey })
      await queryClient.invalidateQueries({ queryKey: seriesKey })
    },
  })
}

export function useDeleteInstance() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, scope = 'this' }: { id: string; scope?: Scope }) => {
      const { response, error } = await api.DELETE('/instances/{id}', {
        params: { path: { id }, query: { scope } },
      })
      if (!response.ok)
        throw new ApiError(response.status, typeof error === 'object' ? error : undefined)
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: instancesKey })
      await queryClient.invalidateQueries({ queryKey: seriesKey })
    },
  })
}

export const seriesKey = ['series'] as const

/** The template of a regular task; disabled while `id` is null. */
export function useSeries(id: string | null) {
  return useQuery({
    queryKey: [...seriesKey, id],
    queryFn: async () => unwrap(await api.GET('/series/{id}', { params: { path: { id: id! } } })),
    enabled: id !== null,
  })
}

/** A tracking action that refreshes the calendar afterwards, whatever the outcome. */
function useTrackingMutation<TVars>(fn: (vars: TVars) => Promise<unknown>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: instancesKey }),
  })
}

/** "Done" in one tap: the fact becomes equal to the plan. */
export function useCompleteInstance() {
  return useTrackingMutation(async (id: string) =>
    unwrap(await api.POST('/instances/{id}/complete', { params: { path: { id } } })),
  )
}

export function useStartInstance() {
  return useTrackingMutation(async (id: string) =>
    unwrap(await api.POST('/instances/{id}/start', { params: { path: { id } } })),
  )
}

export function useStopInstance() {
  return useTrackingMutation(async (id: string) =>
    unwrap(await api.POST('/instances/{id}/stop', { params: { path: { id } } })),
  )
}

export function useUpdateTracking() {
  return useTrackingMutation(async ({ id, ...body }: { id: string } & TrackingPatch) =>
    unwrap(await api.PATCH('/instances/{id}/tracking', { params: { path: { id } }, body })),
  )
}

export function useRescheduleInstance() {
  return useTrackingMutation(
    async ({
      id,
      ...body
    }: {
      id: string
      planned_start: string
      planned_end: string
      comment?: string
    }) => unwrap(await api.POST('/instances/{id}/reschedule', { params: { path: { id } }, body })),
  )
}

export function useCreateUnplanned() {
  return useTrackingMutation(
    async (body: {
      title: string
      description?: string
      category_ids?: string[]
      actual_start?: string
      actual_end?: string
    }) => unwrap(await api.POST('/instances/unplanned', { body })),
  )
}

/** Tasks whose timer is running, from whatever day they were started. */
export function useRunningInstances() {
  return useQuery({
    // Under the "instances" prefix, so that every tracking action refreshes it too.
    queryKey: [...instancesKey, 'running'],
    queryFn: async () => unwrap(await api.GET('/instances/running')),
    refetchInterval: 60_000,
  })
}

/** Statistics of [from, to). Kept under "instances": any change of a task refreshes it. */
export function useStats(from: Date, to: Date, enabled = true) {
  const fromIso = from.toISOString()
  const toIso = to.toISOString()
  return useQuery({
    queryKey: [...instancesKey, 'stats', fromIso, toIso],
    enabled,
    queryFn: async () =>
      unwrap(await api.GET('/stats', { params: { query: { from: fromIso, to: toIso } } })),
    // Keep the previous report on screen (dimmed) while the next one loads.
    placeholderData: (previous) => previous,
  })
}
