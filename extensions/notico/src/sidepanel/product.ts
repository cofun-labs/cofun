// The product the side panel is for, given once where the panel starts (main.tsx): components read it
// here instead of importing the product's definition.
import { createContext, useContext } from 'react'
import type { Product } from '../product'

export const ProductContext = createContext<Product | undefined>(undefined)

export function useProduct(): Product {
  const product = useContext(ProductContext)
  if (!product) throw new Error('The side panel was rendered without its product.')
  return product
}
