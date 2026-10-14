import { useQuery } from '@tanstack/react-query'
import { api } from './client'

/** Backend readiness: 'ok' or 'unavailable' (reachable, but its database is down). */
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const { data, error } = await api.GET('/healthz')
      return (data ?? error)?.status
    },
    refetchInterval: 15_000,
  })
}
