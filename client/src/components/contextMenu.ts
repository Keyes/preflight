/** One entry of a ContextMenu. */
export interface MenuItem {
  label: string
  action: () => void
  danger?: boolean
}
