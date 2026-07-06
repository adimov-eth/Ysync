// Tiny cross-browser WebExtension async facade.
// Chrome MV3 exposes promise-returning chrome.* APIs for the calls we use;
// Firefox exposes the promise-first browser.* namespace. Event APIs still use
// chrome.* directly in callers because both browsers support that shape.

const extensionApi = (): typeof chrome =>
  ((globalThis as typeof globalThis & { browser?: typeof chrome }).browser ?? chrome)

type StorageBag = Record<string, unknown>

let sessionFallback: StorageBag = {}

export const storageLocalGet = async (keys: string | string[]): Promise<StorageBag> =>
  await extensionApi().storage.local.get(keys) as StorageBag

export const storageLocalSet = async (items: StorageBag): Promise<void> => {
  await extensionApi().storage.local.set(items)
}

export const storageSessionGet = async (keys: string | string[]): Promise<StorageBag> => {
  const area = extensionApi().storage.session
  if (area !== undefined) return await area.get(keys) as StorageBag
  const wanted = Array.isArray(keys) ? keys : [keys]
  return Object.fromEntries(wanted.map((key) => [key, sessionFallback[key]]))
}

export const storageSessionSet = async (items: StorageBag): Promise<void> => {
  const area = extensionApi().storage.session
  if (area !== undefined) {
    await area.set(items)
    return
  }
  sessionFallback = { ...sessionFallback, ...items }
}

export const runtimeSendMessage = async (message: unknown): Promise<unknown> =>
  await extensionApi().runtime.sendMessage(message)

export const tabsQuery = async (query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> =>
  await extensionApi().tabs.query(query)

export const tabsSendMessage = async (tabId: number, message: unknown): Promise<unknown> =>
  await extensionApi().tabs.sendMessage(tabId, message)

export const scriptingExecuteScript = async (injection: Parameters<typeof chrome.scripting.executeScript>[0]): Promise<void> => {
  await extensionApi().scripting.executeScript(injection)
}

export const runtimeGetContexts = async (
  filter: chrome.runtime.ContextFilter,
): Promise<chrome.runtime.ExtensionContext[]> => {
  const runtime = extensionApi().runtime as typeof chrome.runtime & {
    getContexts?: (filter: chrome.runtime.ContextFilter) => Promise<chrome.runtime.ExtensionContext[]>
  }
  return runtime.getContexts === undefined ? [] : await runtime.getContexts(filter)
}

export const createOffscreenDocument = async (parameters: chrome.offscreen.CreateParameters): Promise<void> => {
  const offscreen = (extensionApi() as typeof chrome & { offscreen?: typeof chrome.offscreen }).offscreen
  if (offscreen === undefined) return
  await offscreen.createDocument(parameters)
}

export const closeOffscreenDocument = async (): Promise<void> => {
  const offscreen = (extensionApi() as typeof chrome & { offscreen?: typeof chrome.offscreen }).offscreen
  if (offscreen === undefined) return
  await offscreen.closeDocument()
}

export const offscreenReasonWebRtc = (): chrome.offscreen.Reason | null => {
  const offscreen = (extensionApi() as typeof chrome & { offscreen?: typeof chrome.offscreen }).offscreen
  return offscreen?.Reason?.WEB_RTC ?? null
}
