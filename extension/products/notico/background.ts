// Notico's service worker (the manifest's background.service_worker).
import { NOTICO_BRAND } from './brand'
import { startBackground } from '../../src/background'

startBackground(NOTICO_BRAND)
