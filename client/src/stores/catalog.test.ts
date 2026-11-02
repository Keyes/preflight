import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, test, vi } from 'vitest'
import { computed } from 'vue'
import type { CatalogFixture } from '@preflight/shared'
import * as api from '../api'
import { GENERIC_ID } from '../domain/profiles'
import { useCatalog } from './catalog'

vi.mock('../api')
beforeEach(() => setActivePinia(createPinia()))

const later: CatalogFixture = {
  id: 'acme/later',
  manufacturer: 'Acme',
  manufacturerKey: 'acme',
  name: 'Later',
  categories: ['Moving Head'],
  moving: true,
  features: ['pan', 'tilt'],
  modes: [],
}

test('a fixture is the generic moving head until the catalog has it, and what reads its profile follows', async () => {
  const catalog = useCatalog()
  const name = computed(() => catalog.profileFor('acme/later').name)
  expect(catalog.profileFor('acme/later').id).toBe(GENERIC_ID)
  expect(name.value).toBe('Moving head (spot)')

  vi.mocked(api.fetchCatalog).mockResolvedValue({ fixtures: [later], source: { name: 'test', url: '', license: '' }, importedAt: '2026-01-01' } as never)
  await catalog.load()
  expect(catalog.profileFor('acme/later').name).toBe('Later')
  expect(name.value).toBe('Later')
})
