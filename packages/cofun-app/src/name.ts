// Vite sets the display name in each build. Unbundled agent tests exercise Notico's existing copy.
declare const __PRODUCT_NAME__: string

export const PRODUCT_NAME = typeof __PRODUCT_NAME__ === 'undefined' ? 'Notico' : __PRODUCT_NAME__
