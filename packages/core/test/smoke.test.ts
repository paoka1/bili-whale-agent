import { expect, it } from 'vitest'
import * as m from '../src/index.js'

it('包可以导入', () => {
  expect(m).toBeTypeOf('object')
})
