export const PAIR_SIGNALING_TICKET_QUERY = "ticket"
export const PAIR_SIGNALING_TOKEN_HEADER = "x-opencode-ticket"
export const PAIR_SIGNALING_TOKEN_HEADER_VALUE = "1"

const PAIR_SIGNALING_PATH = /^\/pair\/rooms\/[^/]+\/signaling$/

export function isPairSignalingPath(pathname: string) {
  return PAIR_SIGNALING_PATH.test(pathname)
}

export function hasPairSignalingTicketURL(url: URL) {
  return isPairSignalingPath(url.pathname) && !!url.searchParams.get(PAIR_SIGNALING_TICKET_QUERY)
}
