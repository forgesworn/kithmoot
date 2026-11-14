import { appLinkForShort } from './short-link.js'

// replace, not assign: Back from the room should not land on this page and
// bounce straight back into the room.
location.replace(appLinkForShort(location.href, Math.floor(Date.now() / 1000)))
