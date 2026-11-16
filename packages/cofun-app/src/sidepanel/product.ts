import { createContext, useContext } from 'react'
import type { Product } from '../product'

export const ProductContext = createContext<Product | null>(null)

export function useProduct(): Product {
  const product = useContext(ProductContext)
  if (!product) throw new Error('The side panel needs a product')
  return product
}
