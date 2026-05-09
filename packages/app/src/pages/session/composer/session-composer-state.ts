import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest, QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"
import { todoState } from "./session-composer-utils"

export { todoState }

const idle = { type: "idle" as const }

export function createSessionComposerState(options?: { closeMs?: number | (() => number); sessionID?: () => string | undefined }) {
  const sessionID = options?.sessionID ?? (() => undefined)
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const permission = usePermission()

  const questionRequest = createMemo((): QuestionRequest | undefined => {
    return sessionQuestionRequest(sync.data.session, sync.data.question, sessionID())
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    return sessionPermissionRequest(sync.data.session, sync.data.permission, sessionID(), (item) => {
      return !permission.autoResponds(item, sdk.directory)
    })
  })

  const blocked = createMemo(() => {
    const id = sessionID()
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  const todos = createMemo((): Todo[] => {
    const id = sessionID()
    if (!id) return []
    return globalSync.data.session_todo[id] ?? []
  })

  const done = createMemo(
    () => todos().length > 0 && todos().every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  )

  const status = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync.data.session_status[id] ?? idle
  })

  const busy = createMemo(() => status().type !== "idle")
  const live = createMemo(() => busy() || blocked())
  const pair = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync.data.pair[id]
  })
  const pairRemoteDriver = createMemo(() => {
    const room = pair()
    if (!room || room.status !== "active") return false
    return !!room.localPeerID && room.driverPeerID !== room.localPeerID
  })
  const pairPendingPeer = createMemo(() => {
    const room = pair()
    if (!room?.pendingControlPeerID) return
    return room.peers[room.pendingControlPeerID]
  })
  const pairLocalPeerID = createMemo(() => pair()?.localPeerID ?? pair()?.hostPeerID)

  const [store, setStore] = createStore({
    responding: undefined as string | undefined,
    pairControl: undefined as "request" | "grant" | "revoke" | undefined,
    dock: todos().length > 0 && live(),
    closing: false,
    opening: false,
  })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return store.responding === perm.id
  })

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm) return
    if (store.responding === perm.id) return

    setStore("responding", perm.id)
    sdk.client.permission
      .respond({ sessionID: perm.sessionID, permissionID: perm.id, response })
      .catch((err: unknown) => {
        const description = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description })
      })
      .finally(() => {
        setStore("responding", (id) => (id === perm.id ? undefined : id))
      })
  }

  const pairControlRequest = () => {
    const room = pair()
    const peerID = pairLocalPeerID()
    if (!room || !peerID || store.pairControl) return
    setStore("pairControl", "request")
    sdk.client.pair.control
      .request({ roomID: room.id, peerID })
      .catch((err: unknown) => {
        showToast({ title: language.t("common.requestFailed"), description: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => setStore("pairControl", undefined))
  }

  const pairControlGrant = () => {
    const room = pair()
    const peerID = room?.pendingControlPeerID
    const actorPeerID = pairLocalPeerID()
    if (!room || !peerID || !actorPeerID || store.pairControl) return
    setStore("pairControl", "grant")
    sdk.client.pair.control
      .grant({ roomID: room.id, peerID, actorPeerID })
      .catch((err: unknown) => {
        showToast({ title: language.t("common.requestFailed"), description: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => setStore("pairControl", undefined))
  }

  const pairControlRevoke = () => {
    const room = pair()
    const peerID = room?.driverPeerID
    const actorPeerID = pairLocalPeerID()
    if (!room || !peerID || !actorPeerID || store.pairControl) return
    setStore("pairControl", "revoke")
    sdk.client.pair.control
      .revoke({ roomID: room.id, peerID, actorPeerID })
      .catch((err: unknown) => {
        showToast({ title: language.t("common.requestFailed"), description: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => setStore("pairControl", undefined))
  }

  let timer: number | undefined
  let raf: number | undefined

  const closeMs = () => {
    const value = options?.closeMs
    if (typeof value === "function") return Math.max(0, value())
    if (typeof value === "number") return Math.max(0, value)
    return 400
  }

  const scheduleClose = () => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      setStore({ dock: false, closing: false })
      timer = undefined
    }, closeMs())
  }

  // Keep stale turn todos from reopening if the model never clears them.
  const clear = () => {
    const id = sessionID()
    if (!id) return
    globalSync.todo.set(id, [])
    sync.set("todo", id, [])
  }

  createEffect(
    on(
      () => [todos().length, done(), live()] as const,
      ([count, complete, active]) => {
        if (raf) cancelAnimationFrame(raf)
        raf = undefined

        const next = todoState({
          count,
          done: complete,
          live: active,
        })

        if (next === "hide") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ dock: false, closing: false, opening: false })
          return
        }

        if (next === "clear") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          clear()
          return
        }

        if (next === "open") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          const hidden = !store.dock || store.closing
          setStore({ dock: true, closing: false })
          if (hidden) {
            setStore("opening", true)
            raf = requestAnimationFrame(() => {
              setStore("opening", false)
              raf = undefined
            })
            return
          }
          setStore("opening", false)
          return
        }

        setStore({ dock: true, opening: false, closing: true })
        if (!timer) scheduleClose()
      },
    ),
  )

  onCleanup(() => {
    if (!timer) return
    window.clearTimeout(timer)
  })

  onCleanup(() => {
    if (!raf) return
    cancelAnimationFrame(raf)
  })

  return {
    blocked,
    questionRequest,
    permissionRequest,
    permissionResponding,
    decide,
    pair,
    pairRemoteDriver,
    pairPendingPeer,
    pairControlPending: () => store.pairControl,
    pairControlRequest,
    pairControlGrant,
    pairControlRevoke,
    todos,
    dock: () => store.dock,
    closing: () => store.closing,
    opening: () => store.opening,
  }
}

export type SessionComposerState = ReturnType<typeof createSessionComposerState>
