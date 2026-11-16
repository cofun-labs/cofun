import { extensionConfig } from '@cofun/app/vite'
import { buildManifest } from './manifest.ts'

export default extensionConfig(import.meta.dirname, 'Cofun', buildManifest)
