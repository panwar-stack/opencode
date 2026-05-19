import path from "path"
import { createMemo } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { SessionRoot } from "@opencode-ai/sdk/v2"
import { errorMessage } from "@/util/error"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { usePathFormatter } from "@tui/context/path-format"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"

type RootOption =
  | {
      type: "root"
      root: SessionRoot
    }
  | {
      type: "add"
    }

export function DialogRoots(props: { sessionID: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const formatter = usePathFormatter()
  const { theme } = useTheme()
  const roots = createMemo(() => sync.data.session_root[props.sessionID] ?? [])
  const options = createMemo<DialogSelectOption<RootOption>[]>(() => [
    ...roots().map((root) => ({
      title: displayName(root),
      value: { type: "root" as const, root },
      description: formatter.format(root.directory),
      category: "Roots",
      footer: root.primary ? (
        <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>primary</span>
      ) : undefined,
    })),
    {
      title: "Add root",
      value: { type: "add" as const },
      category: "Actions",
      description: "Register another working directory",
    },
  ])

  async function refresh() {
    await sync.session.refreshRoots(props.sessionID)
  }

  async function addRoot() {
    const directory = await DialogPrompt.show(dialog, "Add Root", {
      placeholder: "Absolute path to directory",
    })
    if (directory === null) return
    if (!directory.trim()) {
      dialog.replace(() => <DialogRoots sessionID={props.sessionID} />)
      return
    }
    try {
      const result = await sdk.client.session.root.add(
        { sessionID: props.sessionID, body_directory: directory.trim() },
        { throwOnError: true },
      )
      await refresh()
      const root = result.data
      if (root) {
        await sdk.client.session.prompt({
          sessionID: props.sessionID,
          noReply: true,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: `<system-reminder>The session can now work in another directory: ${root.name ?? root.directory} at ${root.directory}.</system-reminder>`,
            },
          ],
        }).catch(() => {})
      }
      toast.show({ message: "Root added", variant: "success" })
    } catch (error) {
      toast.show({ message: errorMessage(error), variant: "error" })
    }
    dialog.replace(() => <DialogRoots sessionID={props.sessionID} />)
  }

  async function renameRoot(root: SessionRoot) {
    const name = await DialogPrompt.show(dialog, "Rename Root", {
      value: root.name ?? "",
      placeholder: displayName(root),
      description: () => <text fg={theme.textMuted}>{formatter.format(root.directory)}</text>,
    })
    if (name === null) return
    try {
      await sdk.client.session.root.update(
        { sessionID: props.sessionID, rootID: root.id, name: name.trim() || undefined },
        { throwOnError: true },
      )
      await refresh()
      toast.show({ message: "Root renamed", variant: "success" })
    } catch (error) {
      toast.show({ message: errorMessage(error), variant: "error" })
    }
    dialog.replace(() => <DialogRoots sessionID={props.sessionID} />)
  }

  async function makePrimary(root: SessionRoot) {
    try {
      await sdk.client.session.root.update(
        { sessionID: props.sessionID, rootID: root.id, primary: true },
        { throwOnError: true },
      )
      await refresh()
      toast.show({ message: "Primary root updated", variant: "success" })
    } catch (error) {
      toast.show({ message: errorMessage(error), variant: "error" })
    }
    dialog.replace(() => <DialogRoots sessionID={props.sessionID} />)
  }

  async function removeRoot(root: SessionRoot) {
    const ok = await DialogConfirm.show(
      dialog,
      "Remove Root",
      `Remove ${displayName(root)} from this session? Files are not deleted.`,
    )
    if (ok !== true) return
    try {
      await sdk.client.session.root.delete({ sessionID: props.sessionID, rootID: root.id }, { throwOnError: true })
      await refresh()
      toast.show({ message: "Root removed", variant: "success" })
    } catch (error) {
      toast.show({ message: errorMessage(error), variant: "error" })
    }
    dialog.replace(() => <DialogRoots sessionID={props.sessionID} />)
  }

  function openActions(root: SessionRoot) {
    dialog.replace(() => (
      <DialogSelect
        title={displayName(root)}
        options={[
          {
            title: "Rename root",
            value: "rename",
            description: formatter.format(root.directory),
          },
          ...(root.primary
            ? []
            : [
                {
                  title: "Make primary",
                  value: "primary",
                  description: "Use this root for relative paths by default",
                },
              ]),
          {
            title: "Remove root",
            value: "remove",
            description: "Keep files, unregister this root",
          },
        ]}
        onSelect={(option) => {
          if (option.value === "rename") void renameRoot(root)
          if (option.value === "primary") void makePrimary(root)
          if (option.value === "remove") void removeRoot(root)
        }}
      />
    ))
  }

  return (
    <DialogSelect
      title="Session Roots"
      options={options()}
      onSelect={(option) => {
        if (option.value.type === "add") void addRoot()
        if (option.value.type === "root") openActions(option.value.root)
      }}
    />
  )
}

function displayName(root: SessionRoot) {
  if (root.name) return root.name
  return path.basename(root.directory) || root.directory
}
