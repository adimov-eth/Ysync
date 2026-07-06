// One shadow-DOM toast component (gesture prompts, Spotify navigation) (§13).
// The click handler is a real user gesture — it is the activation bridge.

let host: HTMLElement | null = null
let button: HTMLButtonElement | null = null
let onClick: (() => void) | null = null

const ensureToast = (): HTMLButtonElement => {
  if (host !== null && button !== null && document.contains(host)) return button
  host = document.createElement("div")
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; bottom: 24px; right: 24px;"
  const root = host.attachShadow({ mode: "closed" })
  button = document.createElement("button")
  button.style.cssText = [
    "font: 14px/1.4 -apple-system, system-ui, sans-serif",
    "background: #1a1a1a", "color: #fff", "border: 1px solid #444",
    "border-radius: 10px", "padding: 12px 16px", "cursor: pointer",
    "box-shadow: 0 4px 24px rgba(0,0,0,.4)", "max-width: 320px", "text-align: left",
  ].join(";")
  button.addEventListener("click", () => {
    const cb = onClick
    hideToast()
    cb?.()
  })
  root.appendChild(button)
  document.documentElement.appendChild(host)
  return button
}

/** Text is always set via textContent — never markup (§14). */
export const showToast = (text: string, cb: () => void): void => {
  const b = ensureToast()
  b.textContent = text
  onClick = cb
  if (host !== null) host.style.display = ""
}

export const hideToast = (): void => {
  onClick = null
  if (host !== null) host.style.display = "none"
}
