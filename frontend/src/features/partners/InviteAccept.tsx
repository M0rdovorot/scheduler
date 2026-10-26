import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useAcceptInvite } from '@/api/partners'
import { Dialog } from '@/components/Dialog'
import { forgetInvite, pendingInvite, sessionStorageOrNull, withoutInvite } from './invite'
import { partnerErrorMessage } from './messages'

/**
 * Accepts the invite that brought the person here (`/?invite=<token>`), once they are signed
 * in, and tells them how it went. The token is dropped from the address and from storage as
 * soon as it has been tried: it works once, so a reload must not try it again.
 */
export function InviteAccept() {
  const navigate = useNavigate()
  const accept = useAcceptInvite()
  const started = useRef(false)
  const [token] = useState(() => pendingInvite(location.search, sessionStorageOrNull()))
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!token || started.current) return
    started.current = true
    accept.mutate(token, {
      onSettled: () => {
        forgetInvite(sessionStorageOrNull())
        history.replaceState(history.state, '', withoutInvite(location.href))
      },
    })
    // The invite is read once, when the signed-in app first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!token || dismissed) return null
  const close = () => setDismissed(true)

  return (
    <Dialog title="Приглашение" onClose={close}>
      {accept.isPending && <p className="text-hint">Принимаем приглашение…</p>}
      {accept.isError && (
        <>
          <p role="alert" className="text-danger">
            {partnerErrorMessage(accept.error)}
          </p>
          <button type="button" onClick={close} className="mt-4 w-full rounded-xl bg-surface py-3">
            Закрыть
          </button>
        </>
      )}
      {accept.isSuccess && (
        <>
          <p role="status">
            Теперь вы партнёры с {accept.data.display_name}: каждый видит, когда занят другой.
          </p>
          <p className="mt-2 text-sm text-hint">
            Названия дел откроются, только если вы это разрешите.
          </p>
          <button
            type="button"
            onClick={() => {
              close()
              void navigate('/partners')
            }}
            className="mt-4 w-full rounded-xl bg-accent px-4 py-3 text-accent-fg"
          >
            К партнёрам
          </button>
        </>
      )}
    </Dialog>
  )
}
