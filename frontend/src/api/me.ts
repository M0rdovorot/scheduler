import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import { unwrap } from './errors'
import type { SettingsPatch, User } from './types'

export const meKey = ['me'] as const

export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async () => unwrap(await api.GET('/me')),
    staleTime: Infinity,
  })
}

export function useUpdateSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (patch: SettingsPatch) =>
      unwrap(await api.PATCH('/me/settings', { body: patch })),
    onSuccess: (user: User) => queryClient.setQueryData(meKey, user),
  })
}
