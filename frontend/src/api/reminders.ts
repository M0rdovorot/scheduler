import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import { unwrap } from './errors'
import type { GlobalReminders, ReminderOverride, ReminderScope } from './types'

export const remindersKey = ['reminders'] as const

export function useGlobalReminders() {
  return useQuery({
    queryKey: [...remindersKey, 'global'],
    queryFn: async () => unwrap(await api.GET('/reminders/global')),
  })
}

/** The settings of a category, a series, an occurrence or a habit, and what applies to it. */
export function useReminderLevel(scope: ReminderScope, id: string) {
  return useQuery({
    queryKey: [...remindersKey, scope, id],
    queryFn: async () =>
      unwrap(await api.GET('/reminders/{scope}/{id}', { params: { path: { scope, id } } })),
  })
}

/** Mutation that refreshes every reminder query: a level can change what another one inherits. */
function useReminderMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: remindersKey }),
  })
}

export function useSetGlobalReminders() {
  return useReminderMutation(async (body: GlobalReminders) =>
    unwrap(await api.PUT('/reminders/global', { body })),
  )
}

export function useSetReminders() {
  return useReminderMutation(
    async ({ scope, id, ...body }: { scope: ReminderScope; id: string } & ReminderOverride) =>
      unwrap(await api.PUT('/reminders/{scope}/{id}', { params: { path: { scope, id } }, body })),
  )
}

export function useDeleteReminders() {
  return useReminderMutation(async ({ scope, id }: { scope: ReminderScope; id: string }) =>
    unwrap(await api.DELETE('/reminders/{scope}/{id}', { params: { path: { scope, id } } })),
  )
}
