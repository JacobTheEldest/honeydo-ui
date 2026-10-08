/** Runtime config injected by the server via /config.js */
declare global {
  interface Window {
    __HONEYDO_CONFIG__?: {
      VikunjaBaseUrl?: string
      HoneyDoLabel?: string
      DefaultProjectId?: number
    }
  }
}

const cfg = window.__HONEYDO_CONFIG__ || {}

export const VIKUNJA_BASE_URL = cfg.VikunjaBaseUrl || 'https://vikunja.jacobsteward.me'
export const HONEYDO_LABEL = cfg.HoneyDoLabel || 'Honey-Do'
export const DEFAULT_PROJECT_ID = cfg.DefaultProjectId || 1
