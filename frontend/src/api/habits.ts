import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import { ApiError, unwrap } from './errors'
import { instancesKey } from './instances'
import type { HabitInput, HabitPatch, HabitPlacement } from './types'

// Habit data lives under the "instances" prefix: marking an occurrence of a habit in the
// calendar credits the habit, and any change of a habit moves occurrences in the calendar,
// so one invalidation refreshes both.
export const habitsKey = [...instancesKey, 'habits'] as const

export function useHabits() {
  return useQuery({
    queryKey: [...habitsKey, 'list'],
    queryFn: async () => unwrap(await api.GET('/habits')),
  })
}

export function useHabitsToday() {
  return useQuery({
    queryKey: [...habitsKey, 'today'],
    queryFn: async () => unwrap(await api.GET('/habits/today')),
    // The day changes while the app is open.
    refetchInterval: 5 * 60_000,
  })
}

export function useHabitStats(id: string, from: string, to: string) {
  return useQuery({
    queryKey: [...habitsKey, 'stats', id, from, to],
    queryFn: async () =>
      unwrap(
        await api.GET('/habits/{id}/stats', {
          params: { path: { id }, query: { from, to } },
        }),
      ),
    placeholderData: (previous) => previous,
  })
}

function useHabitMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: instancesKey }),
  })
}

export function useCreateHabit() {
  return useHabitMutation(async (body: HabitInput) => unwrap(await api.POST('/habits', { body })))
}

export function useUpdateHabit() {
  return useHabitMutation(async ({ id, ...body }: { id: string } & HabitPatch) =>
    unwrap(await api.PATCH('/habits/{id}', { params: { path: { id } }, body })),
  )
}

export function useArchiveHabit() {
  return useHabitMutation(async ({ id, archived }: { id: string; archived: boolean }) =>
    unwrap(
      await api.POST(archived ? '/habits/{id}/archive' : '/habits/{id}/unarchive', {
        params: { path: { id } },
      }),
    ),
  )
}

export function useDeleteHabit() {
  return useHabitMutation(async (id: string) => {
    const { error, response } = await api.DELETE('/habits/{id}', { params: { path: { id } } })
    if (!response.ok)
      throw new ApiError(response.status, typeof error === 'object' ? error : undefined)
  })
}

export function useSetPlacement() {
  return useHabitMutation(async ({ id, ...body }: { id: string } & HabitPlacement) =>
    unwrap(await api.PUT('/habits/{id}/placement', { params: { path: { id } }, body })),
  )
}

export function useClearPlacement() {
  return useHabitMutation(async (id: string) =>
    unwrap(await api.DELETE('/habits/{id}/placement', { params: { path: { id } } })),
  )
}

/** Sets the value of a habit on a local date; 0 removes the mark. */
export function useSetMark() {
  return useHabitMutation(
    async ({ id, date, value }: { id: string; date: string; value: number }) => {
      const { error, response } = await api.PUT('/habits/{id}/logs/{date}', {
        params: { path: { id, date } },
        body: { value },
      })
      if (!response.ok)
        throw new ApiError(response.status, typeof error === 'object' ? error : undefined)
    },
  )
}
