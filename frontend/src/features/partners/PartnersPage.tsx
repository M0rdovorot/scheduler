import { useState } from 'react'
import { Link } from 'react-router'
import { useCreateInvite, usePartners, useRemovePartner, useSetPartnerAccess } from '@/api/partners'
import type { Partner } from '@/api/types'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { inviteLink } from './invite'
import { partnerErrorMessage } from './messages'

export function PartnersPage() {
  const { data: partners, isPending, isError, refetch } = usePartners()

  return (
    <main className="mx-auto max-w-md p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Партнёры</h1>
        {partners && partners.length > 0 && (
          <Link to="/free-time" className="rounded-xl bg-surface px-3 py-2">
            Свободное время
          </Link>
        )}
      </div>
      <p className="mt-1 text-sm text-hint">
        Партнёры видят, когда вы заняты. Названия дел они видят только там, где вы это разрешили.
      </p>

      <Invite />

      {isPending && <p className="mt-4 text-hint">Загрузка…</p>}
      {isError && (
        <p className="mt-4 text-danger" role="alert">
          Не удалось загрузить партнёров.{' '}
          <button type="button" className="underline" onClick={() => void refetch()}>
            Повторить
          </button>
        </p>
      )}
      {partners && partners.length === 0 && (
        <p className="mt-4 text-hint">Партнёров пока нет. Пригласите первого по ссылке.</p>
      )}

      <ul className="mt-4 space-y-3">
        {partners?.map((p) => (
          <PartnerCard key={p.id} partner={p} />
        ))}
      </ul>

      <nav className="mt-6">
        <Link to="/" className="text-link">
          На главную
        </Link>
      </nav>
    </main>
  )
}

function Invite() {
  const create = useCreateInvite()
  const [copied, setCopied] = useState(false)
  const link = create.data ? inviteLink(location.origin, create.data.token) : null

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Clipboard access can be refused; the link stays selectable in the field.
      setCopied(false)
    }
  }

  return (
    <section className="mt-4 rounded-xl bg-surface p-3">
      <button
        type="button"
        disabled={create.isPending}
        onClick={() => {
          setCopied(false)
          create.mutate()
        }}
        className="w-full rounded-xl bg-accent px-4 py-3 text-accent-fg disabled:opacity-50"
      >
        {link ? 'Новая ссылка' : 'Пригласить партнёра'}
      </button>
      {create.isError && (
        <p role="alert" className="mt-2 text-danger">
          {partnerErrorMessage(create.error)}
        </p>
      )}
      {link && (
        <div className="mt-3 space-y-2">
          <input
            readOnly
            aria-label="Ссылка-приглашение"
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-xl border border-separator bg-bg px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void copy(link)}
            className="w-full rounded-xl bg-bg px-4 py-2"
          >
            {copied ? 'Скопировано' : 'Скопировать'}
          </button>
          <p className="text-sm text-hint">
            Отправьте её человеку. Ссылка сработает один раз и действует 7 дней. Он откроет её в
            браузере и войдёт через Telegram.
          </p>
        </div>
      )}
    </section>
  )
}

function PartnerCard({ partner }: { partner: Partner }) {
  const setAccess = useSetPartnerAccess()
  const remove = useRemovePartner()
  const [confirming, setConfirming] = useState(false)

  return (
    <li className="rounded-xl border border-separator p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 truncate font-medium">{partner.display_name}</h2>
        <Link to={`/partners/${partner.id}`} className="shrink-0 rounded-xl bg-surface px-3 py-1.5">
          Календарь
        </Link>
      </div>

      <div className="mt-2 space-y-1">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={partner.tasks_shared}
            disabled={setAccess.isPending}
            onChange={(e) => setAccess.mutate({ id: partner.id, tasks: e.target.checked })}
          />
          <span>
            Видит названия моих дел
            <span className="block text-sm text-hint">
              Для дел с доступом «Разрешённые партнёры»
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={partner.habits_shared}
            disabled={setAccess.isPending}
            onChange={(e) => setAccess.mutate({ id: partner.id, habits: e.target.checked })}
          />
          <span>Видит мои привычки</span>
        </label>
      </div>
      {setAccess.isError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {partnerErrorMessage(setAccess.error)}
        </p>
      )}

      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="mt-3 text-sm text-danger underline"
      >
        Разорвать связь
      </button>

      {confirming && (
        <ConfirmDialog
          title="Разорвать связь?"
          confirmLabel="Разорвать"
          pending={remove.isPending}
          error={remove.isError ? partnerErrorMessage(remove.error) : null}
          onCancel={() => {
            setConfirming(false)
            remove.reset()
          }}
          onConfirm={() => remove.mutate(partner.id, { onSuccess: () => setConfirming(false) })}
        >
          <p>
            {partner.display_name} больше не увидит вашу занятость, а вы — его. Выданные доступы
            пропадут. Чтобы восстановить связь, понадобится новое приглашение.
          </p>
        </ConfirmDialog>
      )}
    </li>
  )
}
