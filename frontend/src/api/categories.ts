import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import { ApiError, unwrap } from './errors'

export const categoriesKey = ['categories'] as const

export function useCategories() {
  return useQuery({
    queryKey: categoriesKey,
    queryFn: async () => unwrap(await api.GET('/categories')),
  })
}

/** Mutation that refreshes the category list afterwards, whatever the outcome. */
function useCategoryMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: categoriesKey }),
  })
}

export function useCreateCategory() {
  return useCategoryMutation(
    async (body: { name: string; color: string; parent_id?: string | null }) =>
      unwrap(
        await api.POST('/categories', {
          body: { name: body.name, color: body.color, parent_id: body.parent_id ?? undefined },
        }),
      ),
  )
}

export function useUpdateCategory() {
  return useCategoryMutation(
    async ({ id, ...body }: { id: string; name?: string; color?: string }) =>
      unwrap(await api.PATCH('/categories/{id}', { params: { path: { id } }, body })),
  )
}

export function useMoveCategory() {
  return useCategoryMutation(async ({ id, parentId }: { id: string; parentId: string | null }) =>
    unwrap(
      await api.POST('/categories/{id}/move', {
        params: { path: { id } },
        body: { parent_id: parentId ?? undefined },
      }),
    ),
  )
}

export function useArchiveCategory() {
  return useCategoryMutation(async (id: string) =>
    unwrap(await api.POST('/categories/{id}/archive', { params: { path: { id } } })),
  )
}

export function useUnarchiveCategory() {
  return useCategoryMutation(async (id: string) =>
    unwrap(await api.POST('/categories/{id}/unarchive', { params: { path: { id } } })),
  )
}

export function useDeleteCategory() {
  return useCategoryMutation(async (id: string) => {
    const { response, error } = await api.DELETE('/categories/{id}', {
      params: { path: { id } },
    })
    if (!response.ok) {
      throw new ApiError(response.status, typeof error === 'object' ? error : undefined)
    }
  })
}
