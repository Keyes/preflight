import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import * as api from '../api'
import type { CatalogFile, CatalogFixture } from '@preflight/shared'
import { GENERIC_CATALOG_ENTRY, registerCatalog } from '../fixtures/profiles'

/** The fixture catalog (from the Open Fixture Library), loaded once from the server. */
export const useCatalog = defineStore('catalog', () => {
  const items = ref<CatalogFixture[]>([])
  /** where the catalog comes from; null until it has loaded */
  const source = ref<CatalogFile['source'] | null>(null)
  const importedAt = ref('')
  const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const error = ref<string | null>(null)

  /** Every fixture the picker can offer: the generic one first, then the catalog. */
  const all = computed(() => [GENERIC_CATALOG_ENTRY, ...items.value])

  async function load() {
    if (status.value === 'loading' || status.value === 'ready') return
    status.value = 'loading'
    try {
      const file = await api.fetchCatalog()
      items.value = file.fixtures
      source.value = file.source
      importedAt.value = file.importedAt
      registerCatalog(file.fixtures)
      status.value = 'ready'
      error.value = null
    } catch (e) {
      error.value = (e as Error).message
      status.value = 'error'
    }
  }

  return { items, all, source, importedAt, status, error, load }
})
