import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import { ApiError, unwrap } from './errors'
import type { PartnerAccess } from './types'

export const partnersKey = ['partners'] as const
export const busyKey = ['partner-busy'] as const
export const freeTimeKey = ['free-time'] as const

export function usePartners() {
  return useQuery({
    queryKey: partnersKey,
    queryFn: async () => unwrap(await api.GET('/partners')),
  })
}

/** Creating an invite changes nothing the client shows, so there is nothing to refresh. */
export function useCreateInvite() {
  return useMutation({
    mutationFn: async () => unwrap(await api.POST('/partners/invites')),
  })
}

export function useAcceptInvite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (token: string) =>
      unwrap(await api.POST('/partners/invites/accept', { body: { token } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: partnersKey }),
  })
}

export function useSetPartnerAccess() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string } & PartnerAccess) =>
      unwrap(await api.PUT('/partners/{id}/access', { params: { path: { id } }, body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: partnersKey }),
  })
}

export function useRemovePartner() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { response, error } = await api.DELETE('/partners/{id}', { params: { path: { id } } })
      if (!response.ok) {
        throw new ApiError(response.status, typeof error === 'object' ? error : undefined)
      }
    },
    // The busy time and the free time that were loaded may include the one who left.
    onSettled: async () => {
      queryClient.removeQueries({ queryKey: busyKey })
      queryClient.removeQueries({ queryKey: freeTimeKey })
      await queryClient.invalidateQueries({ queryKey: partnersKey })
    },
  })
}

/** What a partner is busy with in [from, to), as the partner allows it to be seen. */
export function usePartnerBusy(id: string, from: Date, to: Date) {
  const fromIso = from.toISOString()
  const toIso = to.toISOString()
  return useQuery({
    queryKey: [...busyKey, id, fromIso, toIso],
    queryFn: async () =>
      unwrap(
        await api.GET('/partners/{id}/busy', {
          params: { path: { id }, query: { from: fromIso, to: toIso } },
        }),
      ),
    placeholderData: (previous) => previous,
  })
}

/** Free time of the user and the chosen partners in [from, to). */
export function useFreeTime(
  withIds: readonly string[],
  from: Date,
  to: Date,
  minMinutes: number,
  enabled = true,
) {
  const fromIso = from.toISOString()
  const toIso = to.toISOString()
  return useQuery({
    queryKey: [...freeTimeKey, [...withIds].sort().join(','), fromIso, toIso, minMinutes],
    queryFn: async () =>
      unwrap(
        await api.GET('/free-time', {
          params: {
            query: { from: fromIso, to: toIso, with: [...withIds], min_minutes: minMinutes },
          },
        }),
      ),
    enabled,
    placeholderData: (previous) => previous,
  })
}
