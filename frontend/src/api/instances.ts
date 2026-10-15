import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import { ApiError, unwrap } from './errors'
import type { CreateTaskRequest, UpdateInstanceRequest } from './types'

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

export function useUpdateInstance() {
  return useInstanceMutation(async ({ id, ...body }: { id: string } & UpdateInstanceRequest) =>
    unwrap(await api.PATCH('/instances/{id}', { params: { path: { id } }, body })),
  )
}

export function useDeleteInstance() {
  return useInstanceMutation(async (id: string) => {
    const { response, error } = await api.DELETE('/instances/{id}', { params: { path: { id } } })
    if (!response.ok) {
      throw new ApiError(response.status, typeof error === 'object' ? error : undefined)
    }
  })
}
